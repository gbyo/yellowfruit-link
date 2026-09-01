/**
 * The QBTCP v1 server.
 *
 * # Where it lives, and why
 *
 * In the Electron main process, never in a React component. Two reasons. A rejected request must not
 * be able to unmount the renderer, and the renderer is the part of this application that a user can
 * make busy by opening a stat report. Serving an assignment cannot depend on either.
 *
 * That is also why an assignment is *stored* rather than built on demand: the renderer builds the QBJ
 * document once, when the director makes the assignment, and this server hands out those exact bytes.
 * A room that has already started scoring cannot have the document change underneath it because
 * somebody renamed a team, and the network body is byte-identical to the exported file by construction
 * rather than by a test that has to keep proving it.
 *
 * # Ordering around a received final
 *
 * The order below is the whole point of this class and is not an implementation detail:
 *
 *     validate identity -> persist the exact QBJ atomically -> acknowledge -> tell the renderer
 *
 * Acknowledging first would allow a crash to produce the one state this design must never reach: a
 * room told "accepted" for a result this application cannot produce. So `save` is awaited before the
 * `200` is written, and the renderer is told afterwards - the renderer failing to hear about it costs
 * a refresh, whereas losing the result costs a game.
 *
 * # Only the canonical surface
 *
 * The deprecated `/api/v1` aliases are not served. They cannot dispatch to these handlers: that
 * surface answers the assignment with its own non-QBJ shape and spells the session fields
 * differently, so aliases would mean a second set of behaviours, which is what the specification's
 * "an alias holds no duplicated logic" rule forbids. Current QBSheet asks for discovery before
 * anything else and adopts the canonical routes when it answers, so nothing is lost by their absence.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  advertisedCapabilities,
  defaultAllowedOrigins,
  deviceIdHeader,
  operatorNameHeader,
  pairingRateLimit,
  presenceFreshMs,
  qbtcpHelpCategories,
  qbjMediaType,
  qbjVersion,
  qbtcpPrefix,
  roomTokenHeader,
  sessionTokenHeader,
} from '../../qbtcp/QbtcpProtocol';
import {
  IQbtcpTournamentState,
  IReceivedResult,
  IRoom,
  IRoomAssignment,
  IQbtcpHelpRequest,
  IQbtcpRosterPlayerRequest,
  ISession,
  ISessionGrant,
  IResultReviewRequest,
  ResultReviewDecision,
  QbtcpSessionStatus,
  QbtcpRosterPlayerOutcome,
  IQbtcpRosterAmendment,
  emptyQbtcpState,
} from '../../qbtcp/QbtcpState';
import {
  ResultComparison,
  compareToRecorded,
  findResultMatch,
  readResultIdentities,
  readResultIdentity,
  readResultSourceMetadata,
  resultFingerprint,
  stripCredentialKeys,
} from '../../qbtcp/ResultFingerprint';
import {
  discrepancyMessage,
  IResultDiscrepancy,
  IResultReceiptContext,
  resultDiscrepancies,
} from '../../qbtcp/ResultDiscrepancy';
import { normalizeScoresheetUrl } from '../../qbtcp/PairingLaunch';
import { makeOpaqueId } from '../../SharedUtils';
import QbtcpStore from './QbtcpStore';
import {
  AttemptLimiter,
  applyCors,
  headerValue,
  isPlainObject,
  parseUntrustedJson,
  readBody,
  stringField,
  urlTooLong,
} from './HttpUtils';

/** Escaped so a future protocol prefix cannot be interpreted as a regular expression. */
const escapedQbtcpPrefix = qbtcpPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sessionRoutePattern = new RegExp(`^${escapedQbtcpPrefix}/sessions/([^/]+)/(writer|progress|result|recovery)$`);
const helpRoutePattern = new RegExp(`^${escapedQbtcpPrefix}/help/([^/]+)$`);

export interface IQbtcpServerHooks {
  /** A final was received and is durably stored. The renderer runs the shared importer from here. */
  onResultReceived: (result: IReceivedResult) => void;
  /** Something a director would want to see changed: presence, a session, a snapshot. */
  onStateChanged: () => void;
  /** Apply QBSheet's authenticated live roster addition to the renderer-owned tournament. */
  onRosterPlayerRequested?: (request: IQbtcpRosterPlayerRequest) => Promise<QbtcpRosterPlayerOutcome>;
}

export default class QbtcpServer {
  private server?: Server;

  private state: IQbtcpTournamentState = emptyQbtcpState('');

  private pairingLimiter = new AttemptLimiter(pairingRateLimit.maxAttempts, pairingRateLimit.windowMs);

  private allowedOrigins: readonly string[] = defaultAllowedOrigins;

  private listenPort?: number;

  private lastError?: string;

  /** Serializes lifecycle commands so a close fully completes before another bind. */
  private lifecycleChain: Promise<void> = Promise.resolve();

  /** A problem loading saved state, kept so the Rooms page can report it without hiding the tournament. */
  private stateProblem?: string;

  private store: QbtcpStore;

  private hooks: IQbtcpServerHooks;

  constructor(store: QbtcpStore, hooks: IQbtcpServerHooks) {
    this.store = store;
    this.hooks = hooks;
  }

  // --- lifecycle ------------------------------------------------------------------------------

  get running(): boolean {
    return this.server !== undefined;
  }

  get port(): number | undefined {
    return this.listenPort;
  }

  get problem(): string | undefined {
    return this.lastError ?? this.stateProblem;
  }

  get tournamentId(): string {
    return this.state.tournamentId;
  }

  /**
   * Point this server at a tournament, loading whatever operational state it already had.
   *
   * A failure to read that state is reported, not thrown: the tournament itself is fine and every
   * manual workflow still has to work.
   */
  async bindTournament(tournamentId: string): Promise<void> {
    const loaded = await this.store.load(tournamentId);
    this.state = loaded.state;
    this.stateProblem = loaded.problem;
    this.refreshAllowedOrigins();
  }

  /**
   * Recompute which browser origins may reach this server.
   *
   * The director can point the pairing sheets at a self-hosted QBSheet, and a printed QR code that
   * this application generated has to work against the server that generated it. So the chosen
   * scoresheet's origin joins the allowlist. It is still an exact origin, never a wildcard: the one
   * added entry is an address a person deliberately typed into the pairing-sheet dialog.
   */
  private refreshAllowedOrigins(): void {
    const chosen = originOf(this.state.scoresheetUrl);
    this.allowedOrigins =
      chosen && !defaultAllowedOrigins.includes(chosen) ? [...defaultAllowedOrigins, chosen] : defaultAllowedOrigins;
  }

  /** A pending result follows its scheduled game, never the physical room that received it. */
  private hasUnresolvedResultForMatch(matchId: string): boolean {
    return this.state.results.some(
      (result) =>
        (result.matchId === matchId || result.expectedMatchId === matchId) &&
        (result.status === 'needs-review' || result.status === 'conflict'),
    );
  }

  /** Whether any session holds scored work that nobody has resolved yet. */
  hasActiveWork(): boolean {
    const unresolvedResult = this.state.results.some(
      (result) => result.status === 'needs-review' || result.status === 'conflict',
    );
    if (unresolvedResult) return true;
    // Opening a session is enough to make the assignment live. Progress is best effort and may never
    // arrive before a device goes offline, so it must not decide whether a game can be replaced.
    return this.state.sessions.some((session) => sessionStatus(session) === 'open');
  }

  async start(port: number): Promise<void> {
    return this.runExclusively(() => this.startInner(port));
  }

  async stop(): Promise<void> {
    return this.runExclusively(() => this.stopInner());
  }

  private runExclusively(work: () => Promise<void>): Promise<void> {
    const run = this.lifecycleChain.then(work);
    this.lifecycleChain = run.catch(() => undefined);
    return run;
  }

  private async startInner(port: number): Promise<void> {
    if (this.server) return;
    this.lastError = undefined;
    const server = createServer((request, response) => {
      // A throw here would take down the process; a request must never be able to do that.
      this.handle(request, response).catch(() => {
        try {
          if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: 'Tournament control had an internal failure.' }));
        } catch {
          // The socket is already gone. Nothing left to report to.
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.lastError = describeListenError(error, port);
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      // Bound to all interfaces on purpose: a room on the tournament's Wi-Fi has to reach it.
      server.listen(port);
    }).catch(async (error) => {
      await closeServer(server);
      throw error;
    });

    try {
      // After startup, a socket error must not be fatal.
      server.on('error', (error) => {
        this.lastError = describeListenError(error, port);
        this.hooks.onStateChanged();
      });

      // The port the socket actually bound to, which is not the requested one when 0 was passed to
      // let the OS choose. Everything a director is shown - and every address a room is given -
      // comes from here, so it has to be the real one.
      const address = server.address();
      const listenPort = typeof address === 'object' && address !== null ? address.port : port;
      this.server = server;
      this.listenPort = listenPort;
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  }

  private async stopInner(): Promise<void> {
    const { server } = this;
    if (!server) return;
    await closeServer(server);
    if (this.server === server) {
      this.server = undefined;
      this.listenPort = undefined;
    }
  }

  // --- state the renderer drives -------------------------------------------------------------

  getState(): IQbtcpTournamentState {
    return this.state;
  }

  private assignmentContextForSession(
    room: IRoom,
    assignment: IRoomAssignment,
    sessionId: string,
  ): IResultReceiptContext {
    return {
      tournamentId: this.state.tournamentId,
      roomId: room.id,
      roomName: room.name,
      sessionId,
      assignmentId: assignment.id,
      expectedMatchId: assignment.matchId,
      expectedRoundNumber: assignment.roundNumber,
      expectedAssignmentRevision: assignment.revision,
      expectedRoundRevision: assignment.roundRevision ?? 1,
      expectedLeftTeamId: assignment.leftTeamId,
      expectedRightTeamId: assignment.rightTeamId,
      expectedLeftTeamName: assignment.leftTeamName,
      expectedRightTeamName: assignment.rightTeamName,
    };
  }

  async addRoom(name: string): Promise<IRoom> {
    const room: IRoom = {
      id: makeOpaqueId('room-', 6),
      name,
      pairingCode: makePairingCode(),
      enabled: true,
    };
    this.state.rooms.push(room);
    await this.store.save(this.state);
    return room;
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    const room = this.state.rooms.find((entry) => entry.id === roomId);
    if (!room) return;
    room.name = name;
    await this.store.save(this.state);
  }

  async setScoresheetUrl(url: string): Promise<void> {
    const normalized = normalizeScoresheetUrl(url);
    if (!normalized) throw new Error('The scoresheet address must be an HTTP or HTTPS URL.');
    if (this.state.scoresheetUrl === normalized) return;
    this.state.scoresheetUrl = normalized;
    this.refreshAllowedOrigins();
    await this.store.save(this.state);
  }

  /**
   * Remove a room, but only when nothing would be lost with it.
   *
   * An assigned room, an unfinished session, or an open help request is refused rather than removed.
   * Terminal sessions and received results stay in operational history after a room is removed, so
   * removing the physical room does not discard evidence the director may still need.
   */
  async removeRoom(roomId: string): Promise<{ removed: boolean; reason?: string }> {
    if (this.state.assignments.some((a) => a.roomId === roomId)) {
      return { removed: false, reason: 'Clear this room’s assignment before removing it.' };
    }
    if (this.state.sessions.some((session) => session.roomId === roomId && sessionStatus(session) === 'open')) {
      return { removed: false, reason: 'This room has an unfinished scoring session.' };
    }
    if (this.state.helpRequests.some((request) => request.roomId === roomId && request.status === 'open')) {
      return { removed: false, reason: 'This room has an open help request. Resolve it before removing the room.' };
    }
    this.state.rooms = this.state.rooms.filter((room) => room.id !== roomId);
    // Terminal sessions and results are audit evidence. Removing a room must not make a late retry or
    // a received result disappear with the physical room record.
    this.state.presence = this.state.presence.filter((entry) => entry.roomId !== roomId);
    await this.store.save(this.state);
    return { removed: true };
  }

  /**
   * Give a room a game to score.
   *
   * The revision increases whenever a room's assignment is replaced, so that a result scored against
   * a superseded pairing is detectable rather than indistinguishable from a current one. An unfinished
   * session locks the room even when no progress snapshot has arrived yet. Once a final is durably
   * received, the room may move on while the result remains attached to its immutable context.
   *
   * `expectedRevision` is the revision the caller baked into the document it is handing over. The
   * renderer computes it from the status it last saw, so two commands issued from one stale snapshot
   * would otherwise both claim revision N+1 while the second stored record became N+2 - and a
   * correctly scored result would then be refused as stale. Refusing the second command is the honest
   * answer: the page it was issued from was out of date.
   */
  async setAssignment(
    assignment: Omit<IRoomAssignment, 'id' | 'revision'>,
    expectedAssignmentRevision?: number,
    roundRevision?: number,
  ): Promise<IRoomAssignment | { assigned: false; reason: string }> {
    if (
      this.state.sessions.some((session) => session.roomId === assignment.roomId && sessionStatus(session) === 'open')
    ) {
      return {
        assigned: false,
        reason: 'This room has an unfinished scoring session. Wait for its result before changing the assignment.',
      };
    }
    const otherAssignment = this.state.assignments.find(
      (entry) => entry.matchId === assignment.matchId && entry.roomId !== assignment.roomId,
    );
    if (otherAssignment) {
      return {
        assigned: false,
        reason: 'That scheduled game is already assigned to another room.',
      };
    }
    if (this.hasUnresolvedResultForMatch(assignment.matchId)) {
      return {
        assigned: false,
        reason: 'That scheduled game has a result waiting for review.',
      };
    }
    const previous = this.state.assignments.find((a) => a.roomId === assignment.roomId);
    const revision = (previous?.revision ?? 0) + 1;
    if (expectedAssignmentRevision !== undefined && expectedAssignmentRevision !== revision) {
      return {
        assigned: false,
        reason: 'The Rooms page was out of date. Refresh it and make this assignment again.',
      };
    }
    const stored: IRoomAssignment = {
      ...assignment,
      id: previous?.id ?? makeOpaqueId('asg-', 6),
      revision,
      roundRevision: assignment.roundRevision ?? roundRevision ?? 1,
      document: addAssignmentRevision(assignment.document, revision),
    };
    this.state.assignments = this.state.assignments.filter((a) => a.roomId !== assignment.roomId);
    this.state.assignments.push(stored);
    await this.store.save(this.state);
    return stored;
  }

  async clearAssignment(roomId: string): Promise<{ cleared: boolean; reason?: string }> {
    const session = this.state.sessions.find((s) => s.roomId === roomId && sessionStatus(s) === 'open');
    if (session) {
      return { cleared: false, reason: 'This room has an unfinished scoring session. Wait for its result first.' };
    }
    this.state.assignments = this.state.assignments.filter((a) => a.roomId !== roomId);
    await this.store.save(this.state);
    return { cleared: true };
  }

  /**
   * Deliberately abandon an open session without deleting its progress or capability history.
   *
   * Abandonment is a director-side primitive, not a scorekeeper escape hatch. The session remains
   * readable for recovery/audit, but its writer lock is revoked and its assignment is released. An
   * already received final is terminal evidence and cannot be turned back into an abandoned session.
   */
  async abandonSession(
    sessionId: string,
    reason?: string,
  ): Promise<{
    abandoned: boolean;
    reason?: string;
    progressSequence?: number;
    hadProgress?: boolean;
    warning?: string;
  }> {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session) return { abandoned: false, reason: 'That scoring session does not exist.' };
    const currentStatus = sessionStatus(session);
    if (currentStatus === 'abandoned') {
      return {
        abandoned: false,
        reason: 'That scoring session has already been abandoned.',
        progressSequence: session.progressSequence,
        hadProgress: session.progressSequence > 0,
      };
    }
    if (currentStatus === 'final-received') {
      return { abandoned: false, reason: 'That scoring session already has a received final.' };
    }
    const normalizedReason = normalizeAbandonReason(reason);
    if (reason !== undefined && normalizedReason === undefined) {
      return { abandoned: false, reason: 'The abandonment reason is empty or too long.' };
    }

    const { progressSequence } = session;
    const formerWriterGrantToken = session.writerGrantToken ?? undefined;
    const now = new Date().toISOString();
    session.status = 'abandoned';
    session.finalReceived = false;
    session.writerGrantToken = null;
    session.lateResultGrantToken = formerWriterGrantToken;
    session.writerDeviceId = null;
    session.abandonedAt = now;
    session.updatedAt = now;
    if (normalizedReason) session.abandonReason = normalizedReason;

    // Only release the assignment belonging to this exact session. The snapshot in the session and
    // any later received result remains available after the room is given another game.
    this.state.assignments = this.state.assignments.filter(
      (assignment) => !(assignment.roomId === session.roomId && assignment.matchId === session.matchId),
    );
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    return {
      abandoned: true,
      progressSequence,
      hadProgress: progressSequence > 0,
      ...(progressSequence > 0
        ? { warning: `This session has recorded progress through sequence ${progressSequence}.` }
        : {}),
    };
  }

  /**
   * Apply an explicit director decision to a received result.
   *
   * A correction never overwrites its predecessor. `supersede` marks the old evidence as
   * superseded and the incoming evidence as accepted, while `keep-existing` marks the incoming
   * evidence dismissed and accepts the selected predecessor if it was still under review. Every
   * transition is one durable save so a restart cannot leave half of a correction relationship.
   */
  async reviewResult(resultId: string, request: IResultReviewRequest): Promise<{ reviewed: boolean; reason?: string }> {
    const result = this.state.results.find((entry) => entry.id === resultId);
    if (!result) return { reviewed: false, reason: 'That received result does not exist.' };
    if (!isResultReviewDecision(request.decision)) {
      return { reviewed: false, reason: 'That result review decision is not supported.' };
    }

    if ((request.decision === 'accept' || request.decision === 'dismiss') && request.existingResultId) {
      return { reviewed: false, reason: 'That review decision does not select an existing result.' };
    }
    const targetResultId =
      request.decision === 'supersede' || request.decision === 'keep-existing'
        ? request.existingResultId ?? result.conflictsWithResultId
        : undefined;
    const reason = normalizeReviewReason(request.reason);
    if (request.reason !== undefined && reason === undefined) {
      return { reviewed: false, reason: 'The result review reason is empty or too long.' };
    }

    // A repeated command is safe and idempotent, but a different decision must not silently
    // reinterpret a result that has already been resolved.
    if (result.review) {
      return result.review.decision === request.decision && result.review.targetResultId === targetResultId
        ? { reviewed: true }
        : { reviewed: false, reason: 'That result has already been reviewed.' };
    }
    if (result.status !== 'needs-review' && result.status !== 'conflict') {
      return { reviewed: false, reason: 'That result is not waiting for review.' };
    }

    let target: IReceivedResult | undefined;
    if (request.decision === 'supersede' || request.decision === 'keep-existing') {
      if (!targetResultId) {
        if (request.decision === 'supersede') {
          return { reviewed: false, reason: 'A correction must identify the result it replaces.' };
        }
        return { reviewed: false, reason: 'Keeping an existing result must identify which result to keep.' };
      }
      target = this.state.results.find((entry) => entry.id === targetResultId);
      if (!target || target.id === result.id) {
        return { reviewed: false, reason: 'The selected existing result does not exist.' };
      }
      if (target.matchId !== result.matchId) {
        return { reviewed: false, reason: 'A result can only be reconciled with the same Match ID.' };
      }
      if (target.status === 'dismissed' || target.status === 'superseded') {
        return { reviewed: false, reason: 'The selected existing result has already been resolved elsewhere.' };
      }
      if (target.supersededByResultId) {
        return { reviewed: false, reason: 'The selected existing result has already been superseded.' };
      }
    }

    const resolvedAt = new Date().toISOString();
    const review = {
      decision: request.decision,
      resolvedAt,
      ...(reason ? { reason } : {}),
      ...(targetResultId ? { targetResultId } : {}),
    };
    const imported = (request.decision === 'accept' || request.decision === 'supersede') && request.imported === true;

    if (request.decision === 'supersede' && target) {
      target.status = 'superseded';
      target.supersededByResultId = result.id;
      target.review = {
        decision: 'supersede',
        resolvedAt,
        ...(reason ? { reason } : {}),
        targetResultId: result.id,
      };
      result.status = 'accepted';
      result.supersedesResultId = target.id;
      result.resolution = 'accepted';
      result.review = review;
      if (imported && result.matchId) result.importedMatchId = result.matchId;
      resolveResultWarnings(result, 'accepted');
    } else if (request.decision === 'keep-existing' && target) {
      // A Keep decision is bookkeeping for a Match that already exists. A retained QBTCP result
      // may look accepted in the adapter while its importer was cancelled or failed; promoting that
      // evidence here would make the review queue lie about a Match that is not in the tournament.
      if (target.importedMatchId && (target.status === 'needs-review' || target.status === 'conflict')) {
        target.status = 'accepted';
        target.resolution = 'accepted';
        resolveResultWarnings(target, 'accepted');
      }
      result.status = 'dismissed';
      result.keepsResultId = target.id;
      result.dismissedAt = resolvedAt;
      result.resolution = 'dismissed';
      result.review = review;
      resolveResultWarnings(result, 'dismissed');
    } else if (request.decision === 'dismiss') {
      result.status = 'dismissed';
      result.dismissedAt = resolvedAt;
      result.resolution = 'dismissed';
      result.review = review;
      resolveResultWarnings(result, 'dismissed');
    } else {
      result.status = 'accepted';
      result.resolution = 'accepted';
      result.review = review;
      if (imported && result.matchId) result.importedMatchId = result.matchId;
      resolveResultWarnings(result, 'accepted');
    }

    this.pruneResolvedSessionAssignment(result.sessionId);
    if (target) this.pruneResolvedSessionAssignment(target.sessionId);
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    return { reviewed: true };
  }

  /**
   * Backward-compatible status setter used by the existing importer bookkeeping path.
   *
   * New callers should use `reviewResult`, which records the director's actual decision and
   * validates correction relationships. An old `accepted` reply still gets a durable review record.
   */
  async resolveResult(resultId: string, status: IReceivedResult['status']): Promise<void> {
    const result = this.state.results.find((entry) => entry.id === resultId);
    if (!result) return;
    if (status === 'accepted' && (result.status === 'needs-review' || result.status === 'conflict')) {
      await this.reviewResult(resultId, { decision: 'accept' });
      return;
    }
    result.status = status;
    if (status === 'accepted') {
      result.resolution = 'accepted';
      result.review ??= { decision: 'accept', resolvedAt: new Date().toISOString() };
      if (result.matchId) result.importedMatchId = result.matchId;
      resolveResultWarnings(result, 'accepted');
    }
    this.pruneResolvedSessionAssignment(result.sessionId);
    await this.store.save(this.state);
    this.hooks.onStateChanged();
  }

  /** Mark an open request dealt with from the Rooms page. */
  async resolveHelpRequest(requestId: string): Promise<void> {
    const request = this.state.helpRequests.find((entry) => entry.id === requestId && entry.status === 'open');
    if (!request) return;
    request.status = 'resolved';
    request.updatedAt = new Date().toISOString();
    await this.store.save(this.state);
    this.hooks.onStateChanged();
  }

  /** Results the renderer has not yet turned into a decision. Used to re-offer them after a restart. */
  unresolvedResults(): IReceivedResult[] {
    return this.state.results
      .filter((r) => r.status === 'needs-review' || r.status === 'conflict')
      .map((result) => {
        if (result.roundNumber !== undefined) return result;
        const assignment = this.state.assignments.find(
          (entry) => entry.roomId === result.roomId && entry.matchId === result.matchId,
        );
        return assignment ? { ...result, roundNumber: assignment.roundNumber } : result;
      });
  }

  /**
   * Whether a document claims to belong to a tournament other than the one this state is bound to.
   *
   * Recorded results are scoped to one tournament, so a document from a different one can never be
   * the same game as any of them however its `Match.id` reads. Two tournaments that both number their
   * games from a common counter would otherwise report a stranger's game as this one's duplicate.
   */
  private belongsToAnotherTournament(tournamentId?: string): boolean {
    return tournamentId !== undefined && tournamentId !== this.state.tournamentId;
  }

  private compareOne(
    identity: { matchId?: string; fingerprint: string; tournamentId?: string },
    reviewingResultId?: string,
  ): ResultComparison {
    if (this.belongsToAnotherTournament(identity.tournamentId)) return { kind: 'new' };
    return compareToRecorded(
      { matchId: identity.matchId, fingerprint: identity.fingerprint },
      this.state.results
        .filter(
          (result) =>
            result.id !== reviewingResultId ||
            result.fingerprint !== identity.fingerprint ||
            (result.status !== 'needs-review' && result.status !== 'conflict'),
        )
        .map((r) => ({
          id: r.id,
          matchId: r.matchId,
          fingerprint: r.fingerprint,
          status: r.status,
          receivedAt: r.receivedAt,
          supersededByResultId: r.supersededByResultId,
        })),
    );
  }

  /**
   * How a document stands against what is already recorded, without recording it.
   *
   * The manual import path uses this to tell a director "this is the backup copy of a result you
   * already have" instead of quietly creating a second match for the same game.
   *
   * One answer per `Match` in the document, in document order. A file can hold a whole day of games,
   * and one answer applied to all of them would mark nine new games as duplicates because the tenth
   * was one.
   */
  classifyResults(document: object, reviewingResultId?: string): ResultComparison[] {
    return readResultIdentities(document).map((identity) => this.compareOne(identity, reviewingResultId));
  }

  /**
   * Record a result that arrived as a file rather than over the network.
   *
   * The manual path calls this so that a later network retry of the same game is recognised as a
   * duplicate. Without it, "control imported the file, then the room reconnected" would produce a
   * second match, which is one of the cases this adapter exists to prevent.
   *
   * Every `Match` in the document is recorded, not just the first: a multi-game file whose later
   * games were left out of dedup state is exactly the file whose later games arrive twice.
   */
  async recordFileResult(document: object): Promise<void> {
    const identities = readResultIdentities(document);
    // Checked across the whole document before anything is written, so a file with one foreign game
    // in it is refused rather than half recorded.
    if (identities.some((identity) => this.belongsToAnotherTournament(identity.tournamentId))) {
      throw new Error('That result belongs to a different tournament.');
    }

    let recorded = false;
    for (const identity of identities) {
      if (this.compareOne(identity).kind !== 'new') continue;
      this.state.results.push({
        id: makeOpaqueId('res-', 8),
        roomId: '',
        sessionId: '',
        matchId: identity.matchId ?? '',
        fingerprint: identity.fingerprint,
        status: 'accepted',
        // The `Match` alone, which is what a later arrival is compared against. Keeping the whole
        // file against every one of its games would store the same day of play ten times over.
        document: stripCredentialKeys(identity.match) as object,
        receivedAt: new Date().toISOString(),
        ...(identity.matchId ? { importedMatchId: identity.matchId } : {}),
        ...(identity.roundNumber !== undefined ? { roundNumber: identity.roundNumber } : {}),
      });
      recorded = true;
    }
    if (recorded) await this.store.save(this.state);
  }

  // --- request handling -----------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cors = applyCors(request, response, this.allowedOrigins);

    if (urlTooLong(request)) {
      sendJson(response, 414, { error: 'That request address was too long.' });
      return;
    }

    if (request.method === 'OPTIONS') {
      // Preflight is answered for every path, and refused for an origin outside the allowlist.
      if (!cors.allowed) {
        sendJson(response, 403, { error: 'This browser origin is not approved.', code: 'origin_not_allowed' });
        return;
      }
      response.writeHead(204).end();
      return;
    }

    if (!cors.allowed) {
      sendJson(response, 403, { error: 'This browser origin is not approved.', code: 'origin_not_allowed' });
      return;
    }

    // A relative URL needs a base to parse against; the host is never used for routing.
    const path = new URL(request.url ?? '/', 'http://qbtcp.invalid').pathname;
    const method = request.method ?? 'GET';

    if (!path.startsWith(qbtcpPrefix)) {
      sendJson(response, 404, { error: 'Not found.' });
      return;
    }

    await this.route(path, method, request, response);
  }

  private async route(path: string, method: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    // --- discovery: no credential, and it reveals no schedule, room list, or pairing code -------
    if (path === qbtcpPrefix) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      sendJson(response, 200, {
        protocol: 'QBTCP',
        version: 1,
        capabilities: advertisedCapabilities.filter(
          (capability) => capability !== 'roster' || this.hooks.onRosterPlayerRequested !== undefined,
        ),
        help_categories: [...qbtcpHelpCategories],
        qbj_version: qbjVersion,
        name: this.tournamentName,
      });
      return;
    }

    if (path === `${qbtcpPrefix}/rooms`) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      // This is pre-pairing discovery: QBSheet uses the names to show a room picker before it has a
      // credential. The response contains no token or pairing code; the pairing endpoint still keeps
      // its identical-failure oracle protection.
      sendJson(response, 200, {
        rooms: this.state.rooms.filter((entry) => entry.enabled).map((entry) => ({ id: entry.id, name: entry.name })),
      });
      return;
    }

    if (path === `${qbtcpPrefix}/pair`) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      await this.handlePair(request, response);
      return;
    }

    if (path === `${qbtcpPrefix}/assignment/status`) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      this.sendAssignmentStatus(room, response);
      return;
    }

    if (path === `${qbtcpPrefix}/assignment`) {
      if (method !== 'GET') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      const assignment = this.state.assignments.find((a) => a.roomId === room.id);
      if (!assignment) {
        // Nothing to play is `204`, never an empty QBJ document.
        response.writeHead(204).end();
        return;
      }
      sendJson(response, 200, assignment.document, qbjMediaType);
      return;
    }

    if (path === `${qbtcpPrefix}/sessions`) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      await this.handleOpenSession(request, response);
      return;
    }

    if (path === `${qbtcpPrefix}/presence`) {
      if (method !== 'GET' && method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      if (method === 'POST') {
        await this.handlePresencePost(room, request, response);
        return;
      }
      if (method === 'GET') {
        const entry = this.state.presence.find((p) => p.roomId === room.id);
        sendJson(response, 200, {
          room_id: room.id,
          connected: isRecent(entry?.lastSeenAt),
          ...(entry?.lastSeenAt ? { last_seen_at: entry.lastSeenAt } : {}),
          ...(entry?.operatorName ? { operator_name: entry.operatorName } : {}),
          ...(entry?.deviceId ? { device_id: entry.deviceId } : {}),
          ...(entry?.client ? { client: entry.client } : {}),
          ...(entry?.procedureVersions ? { procedure_versions: entry.procedureVersions } : {}),
          ...(entry?.qbjVersion ? { qbj_version: entry.qbjVersion } : {}),
        });
        return;
      }
    }

    if (path === `${qbtcpPrefix}/help`) {
      if (method !== 'GET' && method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      if (method === 'GET') {
        this.sendOpenHelpRequest(room, request, response);
      } else {
        await this.handleHelpPost(room, request, response);
      }
      return;
    }

    const helpRoute = helpRoutePattern.exec(path);
    if (helpRoute) {
      if (method !== 'DELETE') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      let helpRequestId: string;
      try {
        helpRequestId = decodeURIComponent(helpRoute[1]);
      } catch {
        sendJson(response, 400, { error: 'That help request address is malformed.' });
        return;
      }
      await this.handleHelpDelete(room, helpRequestId, request, response);
      return;
    }

    if (path === `${qbtcpPrefix}/roster/players`) {
      if (method !== 'POST') {
        sendJson(response, 405, { error: 'Method not allowed.' });
        return;
      }
      await this.handleRosterPlayer(request, response);
      return;
    }

    const sessionRoute = sessionRoutePattern.exec(path);
    if (sessionRoute) {
      let sessionId: string;
      try {
        sessionId = decodeURIComponent(sessionRoute[1]);
      } catch {
        sendJson(response, 400, { error: 'That session address is malformed.' });
        return;
      }
      await this.handleSessionRoute(sessionId, sessionRoute[2], method, request, response);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  }

  private get tournamentName(): string {
    return this.displayName || 'Tournament control';
  }

  /** Set by the renderer so discovery can name the tournament without reading the .yft. */
  displayName = '';

  // --- pairing --------------------------------------------------------------------------------

  /**
   * Exchange a typed code for a room capability.
   *
   * Every failure returns the identical response. A distinguishable error - "no such room" versus
   * "wrong code" - is an oracle that lets someone enumerate the tournament's rooms, so a malformed
   * code, an unknown code, a disabled room and a code/room mismatch are one answer.
   */
  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const source = clientSource(request);
    if (this.pairingLimiter.exceeded(source)) {
      sendJson(response, 429, { error: 'Too many pairing attempts. Wait a moment and try again.' });
      return;
    }

    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;

    const failIdentically = () => {
      this.pairingLimiter.record(source);
      sendJson(response, 401, { error: 'That code is not valid for this tournament.' });
    };

    if (!isPlainObject(body)) {
      failIdentically();
      return;
    }
    const code = stringField(body.code, 64);
    const requestedRoomId = stringField(body.roomId, 128);
    if (!code) {
      failIdentically();
      return;
    }

    const matches = this.state.rooms.filter((room) => room.enabled && room.pairingCode === code);
    const room = requestedRoomId ? matches.find((entry) => entry.id === requestedRoomId) : matches[0];
    if (!room) {
      failIdentically();
      return;
    }

    // A fresh token per pairing: a device that pairs again invalidates the previous one, which is
    // how a room recovers from a token that leaked onto a projector.
    room.roomToken = `rt-${randomBytes(24).toString('hex')}`;
    // The session capabilities and writer ownership go with it. Revoking the room token while
    // leaving either behind would let the device whose pairing was deliberately revoked keep control.
    for (const session of this.state.sessions) {
      if (session.roomId !== room.id) continue;
      session.grants = [];
      session.writerGrantToken = null;
      session.lateResultGrantToken = undefined;
      session.writerDeviceId = null;
    }
    // The previous device's operator name and heartbeat describe somebody who is no longer this
    // room's scorekeeper, so the room reads as waiting until the new device is heard from.
    this.state.presence = this.state.presence.filter((entry) => entry.roomId !== room.id);
    await this.store.save(this.state);
    this.pairingLimiter.clear(source);
    this.hooks.onStateChanged();

    sendJson(response, 200, { roomId: room.id, roomName: room.name, token: room.roomToken });
  }

  // --- authorization --------------------------------------------------------------------------

  /**
   * Resolve the room from its token, or refuse.
   *
   * The room comes from the credential rather than from the path, which is why the canonical routes
   * carry no room id: there is no identifier to edit in the hope of reaching another room's game.
   */
  private authorizeRoom(request: IncomingMessage, response: ServerResponse): IRoom | null {
    const token = headerValue(request, roomTokenHeader);
    const room = token ? this.state.rooms.find((entry) => entry.roomToken === token && entry.enabled) : undefined;
    if (!room) {
      sendJson(response, 401, { error: 'This room is no longer paired.' });
      return null;
    }
    return room;
  }

  /**
   * Resolve the session *and the grant it was reached with*, or refuse.
   *
   * The grant matters as much as the session. Its opaque token is the credential used for writer
   * ownership; the device label attached to it is attribution, not proof supplied by a later caller.
   */
  private authorizeSession(
    sessionId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): { session: ISession; grant: ISessionGrant } | null {
    const token = headerValue(request, sessionTokenHeader);
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    // The token must match this session, not merely be a valid token somewhere: a session capability
    // reaches exactly one session.
    const grant = token ? session?.grants.find((entry) => entry.token === token) : undefined;
    if (!session || !grant) {
      sendJson(response, 401, { error: 'This session is not open.' });
      return null;
    }
    return { session, grant };
  }

  // --- assignment status ----------------------------------------------------------------------

  private sendAssignmentStatus(room: IRoom, response: ServerResponse): void {
    const assignment = this.state.assignments.find((a) => a.roomId === room.id);
    const session = assignment
      ? [...this.state.sessions].reverse().find((s) => s.roomId === room.id && s.matchId === assignment.matchId)
      : undefined;

    sendJson(response, 200, {
      state: assignment ? 'assigned' : 'none',
      blocked_reason: null,
      blocked_message: null,
      // A game whose final is already on record is finished, not resumable. Offering to resume it
      // invites a second scoring pass over a game this application has already accepted.
      session: session
        ? { session_id: session.id, resumable: sessionStatus(session) === 'open', status: sessionStatus(session) }
        : null,
      ...(assignment ? { released_round: assignment.roundNumber } : {}),
      ...(assignment
        ? { round_revision: assignment.roundRevision ?? 1, assignment_revision: assignment.revision }
        : {}),
      hold_new_starts: false,
      previous: null,
      next: null,
    });
  }

  // --- sessions -------------------------------------------------------------------------------

  /**
   * Open a session against the current assignment, or rejoin the one already open.
   *
   * Never creates a second session for the same game. Two devices on one game is a real event - a
   * Chromebook dies and a phone takes over - and writer ownership is what resolves it. A refusal here
   * would leave the phone unable to do anything at all.
   */
  private async handleOpenSession(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const room = this.authorizeRoom(request, response);
    if (!room) return;

    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body)) {
      sendJson(response, 400, { error: 'A session needs a match.' });
      return;
    }
    const matchId = stringField(body.match_id, 256);
    const deviceId = stringField(body.device_id, 256);
    if (!matchId) {
      sendJson(response, 400, { error: 'A session needs a match.' });
      return;
    }

    const assignment = this.state.assignments.find((a) => a.roomId === room.id);
    if (!assignment || assignment.matchId !== matchId) {
      // The room is asking for a game it is not assigned. Its assignment moved on.
      sendJson(response, 410, { error: 'That game is no longer this room’s assignment.' });
      return;
    }

    const existing = this.state.sessions.find(
      (s) => s.roomId === room.id && s.matchId === matchId && sessionStatus(s) !== 'abandoned',
    );
    if (existing) {
      // A caller-supplied device id is attribution, not proof of ownership. Never reuse the writer's
      // credential merely because a new caller repeats the same id; only explicit takeover transfers it.
      const grant = grantFor(existing, deviceId ?? null, existing.writerGrantToken ?? undefined);
      if (existing.writerGrantToken === null) {
        existing.writerGrantToken = grant.token;
        existing.writerDeviceId = deviceId ?? null;
      }
      const isWriter = grant.token === existing.writerGrantToken;
      await this.store.save(this.state);
      sendJson(response, 200, {
        session_id: existing.id,
        token: grant.token,
        writer: isWriter,
        // A retry of an already-delivered final still needs its session; saying so is what stops a
        // client presenting a finished game as one it may carry on scoring.
        final_received: existing.finalReceived,
        status: sessionStatus(existing),
      });
      return;
    }

    const now = new Date().toISOString();
    const sessionId = makeOpaqueId('sess-', 8);
    const session: ISession = {
      id: sessionId,
      roomId: room.id,
      matchId,
      grants: [],
      writerGrantToken: null,
      writerDeviceId: deviceId ?? null,
      progressSequence: 0,
      status: 'open',
      finalReceived: false,
      assignmentContext: this.assignmentContextForSession(room, assignment, sessionId),
      assignmentDocument: stripCredentialKeys(assignment.document) as object,
      createdAt: now,
      updatedAt: now,
    };
    const grant = grantFor(session, deviceId ?? null);
    session.writerGrantToken = grant.token;
    this.state.sessions.push(session);
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, {
      session_id: session.id,
      token: grant.token,
      writer: true,
      final_received: false,
      status: 'open',
    });
  }

  private async handleSessionRoute(
    sessionId: string,
    kind: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const expectedMethod = { recovery: 'GET', writer: 'POST', progress: 'PUT', result: 'POST' }[kind];
    if (method !== expectedMethod) {
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const authorized = this.authorizeSession(sessionId, request, response);
    if (!authorized) return;
    const { session, grant } = authorized;

    if (kind === 'recovery') {
      const assignment = this.state.assignments.find(
        (a) => a.roomId === session.roomId && a.matchId === session.matchId,
      );
      const context = session.assignmentContext;
      const roundRevision = context?.expectedRoundRevision ?? assignment?.roundRevision;
      const assignmentRevision = context?.expectedAssignmentRevision ?? assignment?.revision;
      // Deliberately camelCase: this is the shape the client reads for recovery on both surfaces.
      sendJson(response, 200, {
        sessionId: session.id,
        roundNumber: context?.expectedRoundNumber ?? assignment?.roundNumber ?? 0,
        leftTeam: context?.expectedLeftTeamName ?? assignment?.leftTeamName ?? '',
        rightTeam: context?.expectedRightTeamName ?? assignment?.rightTeamName ?? '',
        finalReceived: session.finalReceived,
        status: sessionStatus(session),
        ...(roundRevision !== undefined ? { roundRevision } : {}),
        ...(assignmentRevision !== undefined ? { assignmentRevision } : {}),
        latestQbj: session.progressMatch ?? null,
        rosterAmendments: session.rosterAmendments ?? [],
      });
      return;
    }

    if (kind === 'writer') {
      await this.handleWriterTakeover(session, grant, request, response);
      return;
    }

    if (kind === 'progress') {
      await this.handleProgress(session, grant, request, response);
      return;
    }

    if (kind === 'result') {
      await this.handleResult(session, grant, request, response);
      return;
    }

    sendJson(response, 404, { error: 'Not found.' });
  }

  private async handleWriterTakeover(
    session: ISession,
    grant: ISessionGrant,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (sessionStatus(session) !== 'open') {
      sendJson(response, 409, {
        error:
          sessionStatus(session) === 'abandoned'
            ? 'This scoring session has been abandoned.'
            : 'This game’s result has already been received.',
      });
      return;
    }
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body) || body.take_over !== true) {
      // A takeover is always explicit and a person always starts it.
      sendJson(response, 400, { error: 'A change of writer has to be asked for explicitly.' });
      return;
    }
    // The device that presented the capability, falling back to one it names. A takeover that named
    // nobody used to leave the lock unowned, which does not transfer exclusivity - it ends it, for
    // every holder of a token on this session.
    const claimant = grant.deviceId ?? stringField(body.device_id, 256);
    if (!claimant) {
      sendJson(response, 400, { error: 'A change of writer has to say which device is taking over.' });
      return;
    }
    // A claimant may already have another non-writer capability. Keep only the credential this
    // explicit takeover arrived on so one device cannot retain multiple live session tokens.
    session.grants = session.grants.filter((entry) => entry === grant || entry.deviceId !== claimant);
    grant.deviceId = claimant;
    session.writerGrantToken = grant.token;
    session.writerDeviceId = claimant;
    session.updatedAt = new Date().toISOString();
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    // The token does not change on a transfer; only which credential owns the writer role does.
    sendJson(response, 200, { session_id: session.id, token: grant.token, writer: true });
  }

  /**
   * Replace this session's snapshot.
   *
   * Best effort by design. A snapshot is a whole state rather than a delta, so a client that was
   * offline sends its current state and does not replay what it missed. A sequence lower than the one
   * held is discarded with a `200`: the client is late rather than wrong, and an error would only
   * cause a pointless retry. Nothing here ever reaches YellowFruit's statistics.
   */
  private async handleProgress(
    session: ISession,
    grant: ISessionGrant,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (sessionStatus(session) !== 'open') {
      // The recovery state of a game this application has already accepted must not keep moving.
      // Whatever this snapshot says, it describes a game that is over.
      sendJson(response, 409, {
        error:
          sessionStatus(session) === 'abandoned'
            ? 'This scoring session has been abandoned.'
            : 'This game’s result has already been received.',
      });
      return;
    }
    if (writerRefused(session, grant, response)) return;

    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body) || typeof body.sequence !== 'number' || !Number.isInteger(body.sequence)) {
      sendJson(response, 400, { error: 'A progress snapshot needs an integer sequence.' });
      return;
    }
    if (body.sequence <= session.progressSequence) {
      sendJson(response, 200, { accepted: true, stale: true });
      return;
    }
    if (!isPlainObject(body.match)) {
      sendJson(response, 400, { error: 'A progress snapshot needs a match.' });
      return;
    }
    // A snapshot that names a game is checked against this session's game. It is not required to
    // name one - a match in progress may not carry its identity yet - but a snapshot that names the
    // wrong one would replace this session's recovery state with another game's.
    const snapshotWarning = this.snapshotIdentityWarning(body.match, session);
    if (snapshotWarning) {
      sendJson(response, 200, {
        accepted: false,
        received: true,
        // Preserve the legacy warning signal for clients that surface `review_required` on a
        // nonfatal progress response. This does not create a durable result review item.
        review_required: true,
        warning_codes: [snapshotWarning.code],
        warnings: [snapshotWarning],
      });
      return;
    }

    session.progressSequence = body.sequence;
    session.progressMatch = stripCredentialKeys(body.match) as object;
    session.updatedAt = new Date().toISOString();
    // Persisted so that a restart can still answer a recovery request, but the client is not made to
    // wait on the disk for something that is explicitly best effort.
    this.store.saveBestEffort(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, { accepted: true });
  }

  /**
   * Why a progress snapshot cannot belong to this session, or undefined when nothing rules it out.
   *
   * Deliberately permissive about absence and strict about disagreement. A snapshot that carries no
   * identity is the ordinary case for a game a scoresheet is still filling in; one that carries a
   * different game's identity is never a snapshot of this game.
   */
  private snapshotIdentityWarning(match: Record<string, unknown>, session: ISession): IResultDiscrepancy | undefined {
    const identity = readResultIdentity(match);
    if (!identity) return undefined;
    if (identity.matchId && identity.matchId !== session.matchId) {
      return { code: 'match-id-mismatch', message: discrepancyMessage('match-id-mismatch') };
    }
    if (this.belongsToAnotherTournament(identity.tournamentId)) {
      return { code: 'tournament-id-mismatch', message: discrepancyMessage('tournament-id-mismatch') };
    }
    return undefined;
  }

  /**
   * Receive the completed game.
   *
   * The ordering here is the durability contract described at the top of this file. A conflicting,
   * mismatched, or unreadable-but-parseable result is persisted before a durable receipt is returned:
   * retaining both copies is what lets a director resolve the disagreement.
   */
  private async handleResult(
    session: ISession,
    grant: ISessionGrant,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const abandoned = sessionStatus(session) === 'abandoned';
    // An abandoned session has no writer authority. A previously issued session capability is still
    // enough to submit a late final for quarantine/review, but no late progress or takeover can mutate
    // the abandoned recovery snapshot.
    if (abandoned) {
      if (!session.lateResultGrantToken || grant.token !== session.lateResultGrantToken) {
        sendJson(response, 409, {
          error: 'This abandoned session no longer accepts results from this capability.',
        });
        return;
      }
    } else if (writerRefused(session, grant, response)) return;

    const body = await this.readResultBody(request, response);
    if (body === undefined) return;

    const identity = readResultIdentity(body);
    const fingerprint = identity?.fingerprint ?? resultFingerprintForUnknownDocument(body);
    const context = this.resultContextForSession(session);
    const warnings = resultDiscrepancies(body, context, this.expectedDocumentForSession(session));
    if (abandoned) addServerDiscrepancy(warnings, 'late-after-abandon');

    // Match ID is authoritative whenever it exists. Only an absent id may use the fingerprint
    // fallback, so two separate Match IDs with identical statistics remain separate received games.
    const comparison: ResultComparison =
      identity?.tournamentId && this.belongsToAnotherTournament(identity.tournamentId)
        ? { kind: 'new' }
        : compareToRecorded(
            { matchId: identity?.matchId, fingerprint },
            this.state.results.map((r) => ({
              id: r.id,
              matchId: r.matchId,
              fingerprint: r.fingerprint,
              status: r.status,
              receivedAt: r.receivedAt,
              supersededByResultId: r.supersededByResultId,
            })),
          );

    if (comparison.kind === 'duplicate') {
      const existing = this.state.results.find((result) => result.id === comparison.existingId);
      const reviewRequired =
        warnings.length > 0 || existing?.status === 'needs-review' || existing?.status === 'conflict';
      if (!abandoned) {
        session.status = 'final-received';
        session.finalReceived = true;
        session.updatedAt = new Date().toISOString();
        this.pruneResolvedSessionAssignment(session.id);
        await this.store.save(this.state);
      }
      sendJson(
        response,
        200,
        receiptBody({
          accepted: !reviewRequired,
          received: true,
          review_required: reviewRequired,
          duplicate: true,
          match_id: identity?.matchId ?? context.expectedMatchId,
          fingerprint,
          warning_codes: warnings.map((warning) => warning.code),
          ...(warnings.length > 0 ? { warnings } : {}),
        }),
      );
      this.hooks.onStateChanged();
      return;
    }

    if (comparison.kind === 'conflict') {
      addServerDiscrepancy(warnings, 'same-match-different-result');
    }

    const claimedMatchId = identity?.matchId;
    const retainedDocument = retainResultDocument(body);
    const resultRoundNumber = identity?.roundNumber ?? context.expectedRoundNumber;
    const received: IReceivedResult = {
      id: makeOpaqueId('res-', 8),
      roomId: session.roomId,
      sessionId: session.id,
      // Keep the expected id as the storage anchor when the document omitted one. The original
      // claim, including its absence, is kept separately for reconciliation and display.
      matchId: claimedMatchId ?? context.expectedMatchId,
      fingerprint,
      status: comparison.kind === 'conflict' ? 'conflict' : 'needs-review',
      document: retainedDocument,
      receivedAt: new Date().toISOString(),
      ...(claimedMatchId ? { claimedMatchId } : {}),
      expectedMatchId: context.expectedMatchId,
      context,
      warnings,
      ...(identity ? {} : { unreadable: true }),
      ...(identity?.assignmentRevision !== undefined ? { claimedAssignmentRevision: identity.assignmentRevision } : {}),
      ...(identity?.roundRevision !== undefined ? { claimedRoundRevision: identity.roundRevision } : {}),
      ...(comparison.kind === 'conflict' ? { conflictsWithResultId: comparison.existingId } : {}),
      ...(resultRoundNumber !== undefined ? { roundNumber: resultRoundNumber } : {}),
    };
    this.state.results.push(received);
    if (!abandoned) {
      session.status = 'final-received';
      session.finalReceived = true;
    }
    session.updatedAt = new Date().toISOString();

    // This save is the receipt boundary. Content discrepancies, conflicts, and unreadable parsed
    // documents all reach this point; only auth, bounds, JSON syntax, and actual storage failures do not.
    await this.store.save(this.state);

    sendJson(
      response,
      200,
      receiptBody({
        // `received` is the durable receipt boundary. Keep the legacy `accepted` field true for any
        // authenticated, parseable body that reached storage; newer clients use `review_required`
        // to distinguish a retained discrepancy from a canonical import.
        accepted: true,
        received: true,
        review_required: warnings.length > 0 || comparison.kind === 'conflict',
        duplicate: false,
        match_id: claimedMatchId ?? context.expectedMatchId,
        fingerprint,
        warning_codes: warnings.map((warning) => warning.code),
        ...(warnings.length > 0 ? { warnings } : {}),
      }),
    );

    // The renderer may fail to hear this notification, but the state is already safe on disk and can
    // be re-offered by its existing unresolved-results command after a restart.
    this.hooks.onResultReceived(received);
  }

  // --- presence -------------------------------------------------------------------------------

  private async handlePresencePost(room: IRoom, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;

    const details = normalizePresenceDetails(body);
    const entry = {
      roomId: room.id,
      lastSeenAt: new Date().toISOString(),
      ...(headerValue(request, deviceIdHeader) ? { deviceId: headerValue(request, deviceIdHeader) } : {}),
      ...(headerValue(request, operatorNameHeader) ? { operatorName: headerValue(request, operatorNameHeader) } : {}),
      ...(details.client ? { client: details.client } : {}),
      ...(details.procedureVersions ? { procedureVersions: details.procedureVersions } : {}),
      ...(details.qbjVersion ? { qbjVersion: details.qbjVersion } : {}),
    };
    this.state.presence = this.state.presence.filter((p) => p.roomId !== room.id);
    this.state.presence.push(entry);
    // Advisory: a lost heartbeat never ends a session, so this is not worth blocking a response on.
    this.store.saveBestEffort(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, {});
  }

  // --- help requests --------------------------------------------------------------------------

  private static requestDeviceId(request: IncomingMessage): string | undefined {
    return stringField(headerValue(request, deviceIdHeader), 256);
  }

  private openHelpRequest(roomId: string, deviceId?: string): IQbtcpHelpRequest | undefined {
    return this.state.helpRequests.find(
      (request) => request.roomId === roomId && request.deviceId === deviceId && request.status === 'open',
    );
  }

  private sendOpenHelpRequest(room: IRoom, request: IncomingMessage, response: ServerResponse): void {
    sendJson(response, 200, { request: this.openHelpRequest(room.id, QbtcpServer.requestDeviceId(request)) ?? null });
  }

  private async handleHelpPost(room: IRoom, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body)) {
      sendJson(response, 400, { error: 'A help request needs a category.' });
      return;
    }
    const category = stringField(body.category, 64);
    if (!category || !qbtcpHelpCategories.includes(category as (typeof qbtcpHelpCategories)[number])) {
      sendJson(response, 400, { error: 'That help-request category is not supported.' });
      return;
    }
    if (body.message !== undefined && (typeof body.message !== 'string' || body.message.length > 2000)) {
      sendJson(response, 400, { error: 'That help-request message is not usable.' });
      return;
    }
    const message = typeof body.message === 'string' ? body.message.trim() : '';

    const deviceId = QbtcpServer.requestDeviceId(request);
    const existing = this.openHelpRequest(room.id, deviceId);
    if (existing) {
      sendJson(response, 200, { request: existing });
      return;
    }

    const assignment = this.state.assignments.find((entry) => entry.roomId === room.id);
    const operatorName = stringField(headerValue(request, operatorNameHeader), 256);
    const now = new Date().toISOString();
    const helpRequest: IQbtcpHelpRequest = {
      id: makeOpaqueId('help-', 8),
      roomId: room.id,
      roomName: room.name,
      category: category as IQbtcpHelpRequest['category'],
      message,
      status: 'open',
      createdAt: now,
      updatedAt: now,
      ...(deviceId ? { deviceId } : {}),
      ...(operatorName ? { operatorName } : {}),
      ...(assignment
        ? {
            currentMatchup: {
              roundNumber: assignment.roundNumber,
              roundName: `Round ${assignment.roundNumber}`,
              leftTeam: assignment.leftTeamName,
              rightTeam: assignment.rightTeamName,
            },
          }
        : {}),
    };
    this.state.helpRequests.push(helpRequest);
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, { request: helpRequest });
  }

  private async handleHelpDelete(
    room: IRoom,
    requestId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const deviceId = QbtcpServer.requestDeviceId(request);
    const helpRequest = this.state.helpRequests.find(
      (entry) =>
        entry.id === requestId && entry.roomId === room.id && entry.deviceId === deviceId && entry.status === 'open',
    );
    if (!helpRequest) {
      // A harmless race with a director resolving it while the scorekeeper clicks cancel.
      sendJson(response, 200, { request: null });
      return;
    }
    helpRequest.status = 'cancelled';
    helpRequest.updatedAt = new Date().toISOString();
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, { request: helpRequest });
  }

  // --- live roster synchronization -------------------------------------------------------------

  private async handleRosterPlayer(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const room = this.authorizeRoom(request, response);
    if (!room) return;
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body)) {
      sendJson(response, 400, { error: 'A roster update needs a session, team, and player.' });
      return;
    }
    const sessionId = stringField(body.session_id ?? body.sessionId, 256);
    const requestedTeamId = stringField(body.team_id ?? body.teamId, 256);
    const requestedTeamName = stringField(body.team_name ?? body.teamName, 512);
    const playerName = stringField(body.player_name ?? body.playerName, 200);
    const rawQuestionNumber = body.question_number ?? body.questionNumber;
    const questionNumber =
      typeof rawQuestionNumber === 'number' && Number.isInteger(rawQuestionNumber) && rawQuestionNumber >= 1
        ? Math.min(rawQuestionNumber, 10000)
        : undefined;
    if (!sessionId || (!requestedTeamId && !requestedTeamName) || !playerName) {
      sendJson(response, 400, { error: 'A roster update needs a session, team, and player.' });
      return;
    }
    const authorized = this.authorizeSession(sessionId, request, response);
    if (!authorized) return;
    const { session } = authorized;
    if (session.roomId !== room.id) {
      sendJson(response, 403, { error: 'That session does not belong to this room.' });
      return;
    }
    const assignment = this.state.assignments.find((entry) => entry.roomId === room.id);
    if (!assignment || assignment.matchId !== session.matchId || sessionStatus(session) !== 'open') {
      sendJson(response, 410, { error: 'A newer assignment has superseded this game.' });
      return;
    }
    let teamId: string | undefined;
    let teamName: string | undefined;
    if (requestedTeamId === assignment.leftTeamId) {
      teamId = assignment.leftTeamId;
      teamName = assignment.leftTeamName;
    } else if (requestedTeamId === assignment.rightTeamId) {
      teamId = assignment.rightTeamId;
      teamName = assignment.rightTeamName;
    } else if (!requestedTeamId && requestedTeamName === assignment.leftTeamName) {
      teamId = assignment.leftTeamId;
      teamName = assignment.leftTeamName;
    } else if (!requestedTeamId && requestedTeamName === assignment.rightTeamName) {
      teamId = assignment.rightTeamId;
      teamName = assignment.rightTeamName;
    }
    if (!teamId) {
      sendJson(response, 409, { error: 'That team is not part of this scoring session.' });
      return;
    }
    if (!this.hooks.onRosterPlayerRequested) {
      sendJson(response, 501, { error: 'Live roster updates are not available.' });
      return;
    }

    if (writerRefused(session, authorized.grant, response)) return;

    let outcome: QbtcpRosterPlayerOutcome;
    try {
      outcome = await this.hooks.onRosterPlayerRequested({
        requestId: makeOpaqueId('roster-', 8),
        roomId: room.id,
        sessionId,
        teamId,
        teamName: teamName as string,
        playerName,
        ...(questionNumber !== undefined ? { questionNumber } : {}),
      });
    } catch {
      outcome = { ok: false, status: 503, error: 'YellowFruit could not apply that roster update.' };
    }
    if (!outcome.ok) {
      sendJson(response, outcome.status ?? 409, { error: outcome.error });
      return;
    }
    const canonicalTeamName = outcome.teamName ?? teamName;
    const canonicalPlayerName = outcome.playerName ?? playerName;
    const amendment: IQbtcpRosterAmendment = {
      teamId,
      teamName: canonicalTeamName as string,
      playerName: canonicalPlayerName,
      ...(questionNumber !== undefined ? { questionNumber } : {}),
      ...(outcome.playerId ? { playerId: outcome.playerId } : {}),
      ...(outcome.created !== undefined ? { created: outcome.created } : {}),
      ...(outcome.warning ? { warning: outcome.warning.slice(0, 200) } : {}),
      recordedAt: new Date().toISOString(),
    };
    const previousAmendments = session.rosterAmendments ?? [];
    if (
      !previousAmendments.some(
        (entry) =>
          entry.teamId === amendment.teamId &&
          ((entry.playerId && amendment.playerId && entry.playerId === amendment.playerId) ||
            entry.playerName.toLocaleLowerCase() === amendment.playerName.toLocaleLowerCase()),
      )
    ) {
      session.rosterAmendments = [...previousAmendments, amendment];
      session.updatedAt = amendment.recordedAt as string;
      await this.store.save(this.state);
    }
    if (!outcome.playerId && !outcome.teamId && !outcome.teamName && !outcome.playerName) {
      // Preserve the exact old success shape for servers/renderers that do not yet provide canonical
      // identity. The durable amendment still gives a newer recovering client the names it needs.
      sendJson(response, 200, { added: true, teamName: canonicalTeamName, playerName: canonicalPlayerName });
      return;
    }
    sendJson(response, 200, {
      added: true,
      player: { id: outcome.playerId ?? null, name: canonicalPlayerName },
      team: { id: outcome.teamId ?? teamId, name: canonicalTeamName },
      ...(outcome.created !== undefined ? { created: outcome.created } : {}),
      ...(outcome.warning ? { warning: outcome.warning } : {}),
    });
  }

  // --- helpers --------------------------------------------------------------------------------

  /**
   * Read and parse a bounded, untrusted body.
   *
   * Returns `undefined` when it has already answered the request, so a caller returns immediately on
   * `undefined` rather than inspecting an error.
   */
  // eslint-disable-next-line class-methods-use-this -- kept on the class so callers read as one flow.
  private async readJsonBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | undefined> {
    const body = await readBody(request);
    if (!body.ok) {
      if (body.tooLarge) sendJson(response, 413, { error: 'That request was too large.' });
      else sendJson(response, 400, { error: 'That request did not arrive completely.' });
      return undefined;
    }
    const parsed = parseUntrustedJson(body.text);
    if (!parsed.ok) {
      sendJson(response, 400, { error: parsed.error });
      return undefined;
    }
    return parsed.value ?? {};
  }

  /** The result route keeps parsed JSON that is not a useful Match as a reviewable quarantine record. */
  // eslint-disable-next-line class-methods-use-this -- kept beside the ordinary body reader for one boundary.
  private async readResultBody(request: IncomingMessage, response: ServerResponse): Promise<unknown | undefined> {
    const body = await readBody(request);
    if (!body.ok) {
      if (body.tooLarge) sendJson(response, 413, { error: 'That request was too large.' });
      else sendJson(response, 400, { error: 'That request did not arrive completely.' });
      return undefined;
    }
    const parsed = parseUntrustedJson(body.text);
    if (!parsed.ok) {
      // Invalid JSON is still a transport failure. It is intentionally not copied verbatim because a
      // malformed body cannot be passed through the credential-stripping boundary safely.
      sendJson(response, 400, { error: parsed.error });
      return undefined;
    }
    return parsed.value;
  }

  private resultContextForSession(session: ISession): IResultReceiptContext {
    if (session.assignmentContext) return session.assignmentContext;
    const assignment = this.state.assignments.find(
      (entry) => entry.roomId === session.roomId && entry.matchId === session.matchId,
    );
    const room = this.state.rooms.find((entry) => entry.id === session.roomId);
    if (assignment && room) return this.assignmentContextForSession(room, assignment, session.id);
    return {
      tournamentId: this.state.tournamentId,
      roomId: session.roomId,
      roomName: room?.name ?? '',
      sessionId: session.id,
      expectedMatchId: session.matchId,
    };
  }

  private expectedDocumentForSession(session: ISession): object | undefined {
    if (session.assignmentDocument) return session.assignmentDocument;
    return this.state.assignments.find((entry) => entry.roomId === session.roomId && entry.matchId === session.matchId)
      ?.document;
  }

  /**
   * Drop the duplicate assignment snapshot once its session is terminal and no result from it is
   * still waiting for a director. The immutable assignment context remains for recovery/audit, and
   * unresolved results retain their own exact document; this only removes the second copy of a QBJ
   * after it has stopped being needed for comparison.
   */
  private pruneResolvedSessionAssignment(sessionId: string): void {
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    if (!session || sessionStatus(session) === 'open') return;
    if (
      this.state.results.some(
        (result) =>
          result.sessionId === sessionId && (result.status === 'needs-review' || result.status === 'conflict'),
      )
    ) {
      return;
    }
    delete session.assignmentDocument;
  }
}

function sessionStatus(session: ISession): QbtcpSessionStatus {
  if (session.status === 'abandoned') return 'abandoned';
  if (session.status === 'final-received' || session.finalReceived) return 'final-received';
  return 'open';
}

function normalizeAbandonReason(reason?: string): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = reason.trim();
  return normalized === '' || normalized.length > 1000 ? undefined : normalized;
}

function isResultReviewDecision(value: unknown): value is ResultReviewDecision {
  return value === 'accept' || value === 'keep-existing' || value === 'dismiss' || value === 'supersede';
}

function normalizeReviewReason(reason?: string): string | undefined {
  if (reason === undefined) return undefined;
  const normalized = reason.trim();
  return normalized === '' || normalized.length > 1000 ? undefined : normalized;
}

function resolveResultWarnings(result: IReceivedResult, resolution: 'accepted' | 'dismissed'): void {
  if (!result.warnings) return;
  for (const warning of result.warnings) {
    if (!warning.resolution || warning.resolution === 'unresolved') warning.resolution = resolution;
  }
}

function addServerDiscrepancy(warnings: IResultDiscrepancy[], code: IResultDiscrepancy['code']): void {
  if (warnings.some((warning) => warning.code === code)) return;
  warnings.push({ code, message: discrepancyMessage(code) });
}

function resultFingerprintForUnknownDocument(document: unknown): string {
  return resultFingerprint(document);
}

function retainResultDocument(document: unknown): object {
  const sanitized = stripCredentialKeys(document);
  if (isPlainObject(sanitized)) return sanitized;
  return { _qbtcp_unreadable: sanitized };
}

/** Add the server-side assignment revision without mutating the renderer's document object. */
function addAssignmentRevision(document: object, assignmentRevision: number): object {
  try {
    const copy = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    const objects = Array.isArray(copy.objects) ? copy.objects : [];
    const match = objects.find(
      (entry): entry is Record<string, unknown> => isPlainObject(entry) && entry.type === 'Match',
    );
    if (!match) return document;
    const extension = isPlainObject(match._qbtcp) ? match._qbtcp : {};
    match._qbtcp = { ...extension, assignment_revision: assignmentRevision };
    return copy;
  } catch {
    // A document from the renderer is expected to be JSON-shaped. If a test or a future caller gives
    // us an object JSON cannot clone, preserve the original rather than making assignment itself fail.
    return document;
  }
}

function receiptBody(body: object): object {
  return body;
}

/** The capability this session has already issued to a non-writer identity, or a fresh one. */
function grantFor(session: ISession, deviceId: string | null, excludedToken?: string): ISessionGrant {
  const existing = session.grants.find((entry) => entry.deviceId === deviceId && entry.token !== excludedToken);
  if (existing) return existing;
  const grant: ISessionGrant = { deviceId, token: `st-${randomBytes(24).toString('hex')}` };
  session.grants.push(grant);
  return grant;
}

/**
 * Refuse a write from a capability that does not hold the writer lock.
 *
 * The authority is the opaque grant token the session recorded as writer. `device_id` remains useful
 * attribution, but a caller can choose that text and therefore cannot use it as proof that it owns the
 * writer's credential. `409` rather than `401` on purpose: a non-writer session token is perfectly
 * valid and may still read or explicitly take over.
 */
function writerRefused(session: ISession, grant: ISessionGrant, response: ServerResponse): boolean {
  if (grant.token === session.writerGrantToken) return false;
  sendJson(response, 409, {
    error: 'Another device is scoring this game.',
    writer_device: session.writerDeviceId,
    can_take_over: true,
  });
  return true;
}

/** The origin of a URL, or undefined when there is not one to speak of. */
function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? undefined : origin;
  } catch {
    return undefined;
  }
}

interface IResultAssignmentValidationError {
  status: 400 | 409 | 410;
  error: string;
}

/** Validate the identity and assignment metadata before a final can be stored. */
function resultAssignmentValidation(
  body: object,
  assignment: IRoomAssignment,
): IResultAssignmentValidationError | undefined {
  const match = findResultMatch(body);
  if (!match) return { status: 400, error: 'That result contained no match this server could read.' };

  const rawTeams = match.match_teams ?? match.matchTeams;
  if (!Array.isArray(rawTeams) || rawTeams.length !== 2) {
    return { status: 409, error: 'That result does not contain the two teams assigned to this scoring session.' };
  }
  const teamIds = rawTeams.map(teamIdFromMatchTeam);
  const hasAllTeamIds = teamIds.every((teamId) => teamId !== undefined);
  const hasNoTeamIds = teamIds.every((teamId) => teamId === undefined);
  if (hasAllTeamIds) {
    if (teamIds[0] !== assignment.leftTeamId || teamIds[1] !== assignment.rightTeamId) {
      return { status: 409, error: 'That result does not contain the two teams assigned to this scoring session.' };
    }
  } else if (hasNoTeamIds && match === body) {
    const teamNames = rawTeams.map(teamNameFromMatchTeam);
    if (
      teamNames[0] !== assignment.leftTeamName ||
      teamNames[1] !== assignment.rightTeamName ||
      teamNames.some((teamName) => teamName === undefined)
    ) {
      return { status: 409, error: 'That result does not contain the two teams assigned to this scoring session.' };
    }
  } else {
    return { status: 409, error: 'That result does not contain the two teams assigned to this scoring session.' };
  }

  const extension = match._qbtcp;
  let assignmentRevision: unknown;
  let roundRevision: unknown;
  if (extension !== undefined) {
    if (!isPlainObject(extension)) {
      return { status: 400, error: 'That result contains invalid QBTCP assignment metadata.' };
    }
    assignmentRevision = extension.assignment_revision ?? extension.assignmentRevision;
    roundRevision = extension.round_revision ?? extension.roundRevision;
  }
  const source = readResultSourceMetadata(match);
  if (assignmentRevision === undefined) assignmentRevision = source.assignmentRevision;
  if (roundRevision === undefined) roundRevision = source.roundRevision;
  // Before the two revisions were split, `round_revision` was the only revision a result carried
  // and it described the room assignment. Preserve that meaning for old result files and state
  // records; new documents carry both fields and therefore take the independent paths below.
  if (assignmentRevision === undefined && roundRevision !== undefined) {
    assignmentRevision = roundRevision;
    roundRevision = undefined;
  }
  if (
    assignmentRevision !== undefined &&
    (typeof assignmentRevision !== 'number' || !Number.isInteger(assignmentRevision))
  ) {
    return { status: 400, error: 'That result contains invalid QBTCP assignment metadata.' };
  }
  if (roundRevision !== undefined && (typeof roundRevision !== 'number' || !Number.isInteger(roundRevision))) {
    return { status: 400, error: 'That result contains invalid QBTCP assignment metadata.' };
  }
  if (typeof assignmentRevision === 'number' && assignmentRevision < assignment.revision) {
    return { status: 410, error: 'A newer assignment has superseded this game.' };
  }
  if (typeof assignmentRevision === 'number' && assignmentRevision > assignment.revision) {
    return { status: 409, error: 'That result does not match this room’s current assignment.' };
  }
  const expectedRoundRevision = assignment.roundRevision ?? 1;
  if (typeof roundRevision === 'number' && roundRevision < expectedRoundRevision) {
    return { status: 410, error: 'A newer round assignment has superseded this game.' };
  }
  if (typeof roundRevision === 'number' && roundRevision > expectedRoundRevision) {
    return { status: 409, error: 'That result does not match this room’s current round assignment.' };
  }
  return undefined;
}

/** Compatibility-facing validation message used by focused assignment tests and non-HTTP callers. */
export function validateResultAgainstAssignment(body: object, assignment: IRoomAssignment): string | undefined {
  return resultAssignmentValidation(body, assignment)?.error;
}

function teamIdFromMatchTeam(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const { team } = value;
  if (!isPlainObject(team)) return undefined;
  if (typeof team.$ref === 'string') return team.$ref;
  if (typeof team.id === 'string') return team.id;
  return undefined;
}

function teamNameFromMatchTeam(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  const { team } = value;
  if (!isPlainObject(team)) return undefined;
  return typeof team.name === 'string' ? team.name : undefined;
}

function sendJson(response: ServerResponse, status: number, body: object, contentType = 'application/json'): void {
  const text = JSON.stringify(body);
  const headers: Record<string, string | number> = {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(text),
  };
  // A refused oversized body is answered while the client may still be uploading. Closing the
  // connection after the response is what lets that answer arrive intact instead of as a reset.
  if (status === 413) headers.Connection = 'close';
  response.writeHead(status, headers);
  response.end(text);
}

/** Close a server and release all idle connections before the next lifecycle operation. */
async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    // Idle keep-alive sockets would otherwise hold the close open.
    server.closeAllConnections?.();
  });
}

/**
 * A pairing code a person can read aloud and type without ambiguity.
 *
 * Digits only, and eight of them, which is what QBSheet's pairing field expects. Short enough to read
 * off a card and long enough that guessing it inside the rate limit is not worth attempting.
 */
function makePairingCode(): string {
  let code = '';
  while (code.length < 8) {
    for (const byte of randomBytes(8)) {
      if (byte >= 250) continue;
      code += String(byte % 10);
      if (code.length === 8) break;
    }
  }
  return code;
}

/** The bucket a pairing attempt is counted against. */
function clientSource(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? 'unknown';
}

function isRecent(timestamp?: string): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Date.now() - parsed < presenceFreshMs;
}

/** Keep presence diagnostics bounded and advisory; none of these fields grants authority. */
function normalizePresenceDetails(value: unknown): {
  client?: { name?: string; version?: string; build?: string; commit?: string };
  procedureVersions?: number[];
  qbjVersion?: string;
} {
  if (!isPlainObject(value)) return {};
  const rawClient = isPlainObject(value.client) ? value.client : undefined;
  const client = rawClient
    ? (Object.fromEntries(
        (['name', 'version', 'build', 'commit'] as const).flatMap((key) => {
          const entry = stringField(rawClient[key], 100);
          return entry ? [[key, entry]] : [];
        }),
      ) as { name?: string; version?: string; build?: string; commit?: string })
    : undefined;
  const rawVersions = value.procedure_versions ?? value.procedureVersions ?? value.supportedProcedureVersions;
  const procedureVersions = Array.isArray(rawVersions)
    ? rawVersions
        .filter((entry): entry is number => typeof entry === 'number' && Number.isInteger(entry) && entry >= 1)
        .slice(0, 16)
    : [];
  const reportedQbjVersion = stringField(value.qbj_version ?? value.qbjVersion, 50);
  return {
    ...(client && Object.keys(client).length > 0 ? { client } : {}),
    ...(procedureVersions.length > 0 ? { procedureVersions } : {}),
    ...(reportedQbjVersion ? { qbjVersion: reportedQbjVersion } : {}),
  };
}

/** Turn a listen failure into something a director can act on. Never includes a credential. */
function describeListenError(error: Error, port: number): string {
  const { code } = error as { code?: string };
  if (code === 'EADDRINUSE') return `Port ${port} is already in use. Choose a different port.`;
  if (code === 'EACCES') return `This computer would not allow the server to use port ${port}.`;
  return `The Rooms server could not start: ${error.message}`;
}

/** Every non-loopback IPv4 address a room could reach this computer on. */
export function lanAddresses(port: number): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(`http://${entry.address}:${port}`);
    }
  }
  addresses.push(`http://localhost:${port}`);
  return addresses;
}
