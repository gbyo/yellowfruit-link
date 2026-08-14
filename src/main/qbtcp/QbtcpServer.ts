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
  ISession,
  emptyQbtcpState,
} from '../../qbtcp/QbtcpState';
import {
  ResultComparison,
  compareToRecorded,
  findResultMatch,
  readResultIdentity,
  readResultSourceMetadata,
  stripCredentialKeys,
} from '../../qbtcp/ResultFingerprint';
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

export interface IQbtcpServerHooks {
  /** A final was received and is durably stored. The renderer runs the shared importer from here. */
  onResultReceived: (result: IReceivedResult) => void;
  /** Something a director would want to see changed: presence, a session, a snapshot. */
  onStateChanged: () => void;
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
  }

  /** Whether any session holds scored work that nobody has resolved yet. */
  hasActiveWork(): boolean {
    const unresolvedResult = this.state.results.some(
      (result) => result.status === 'needs-review' || result.status === 'conflict',
    );
    if (unresolvedResult) return true;
    // Opening a session is enough to make the assignment live. Progress is best effort and may never
    // arrive before a device goes offline, so it must not decide whether a game can be replaced.
    return this.state.sessions.some((session) => !session.finalReceived);
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
    await this.store.save(this.state);
  }

  /**
   * Remove a room, but only when nothing would be lost with it.
   *
   * An assigned room, an unfinished session, or one whose result nobody has dealt with, is refused
   * rather than removed. The caller reports that to the director; silently discarding a game to satisfy
   * a click is not a recoverable mistake.
   */
  async removeRoom(roomId: string): Promise<{ removed: boolean; reason?: string }> {
    if (this.state.assignments.some((a) => a.roomId === roomId)) {
      return { removed: false, reason: 'Clear this room’s assignment before removing it.' };
    }
    if (this.state.sessions.some((session) => session.roomId === roomId && !session.finalReceived)) {
      return { removed: false, reason: 'This room has an unfinished scoring session.' };
    }
    if (
      this.state.results.some((r) => r.roomId === roomId && (r.status === 'needs-review' || r.status === 'conflict'))
    ) {
      return { removed: false, reason: 'This room has a result waiting for review.' };
    }
    this.state.rooms = this.state.rooms.filter((room) => room.id !== roomId);
    this.state.sessions = this.state.sessions.filter((session) => session.roomId !== roomId);
    this.state.presence = this.state.presence.filter((entry) => entry.roomId !== roomId);
    await this.store.save(this.state);
    return { removed: true };
  }

  /**
   * Give a room a game to score.
   *
   * The revision increases whenever a room's assignment is replaced, so that a result scored against
   * a superseded pairing is detectable rather than indistinguishable from a current one. An unfinished
   * session locks the room even when no progress snapshot has arrived yet.
   */
  async setAssignment(
    assignment: Omit<IRoomAssignment, 'id' | 'revision'>,
  ): Promise<IRoomAssignment | { assigned: false; reason: string }> {
    if (this.state.sessions.some((session) => session.roomId === assignment.roomId && !session.finalReceived)) {
      return {
        assigned: false,
        reason: 'This room has an unfinished scoring session. Wait for its result before changing the assignment.',
      };
    }
    const previous = this.state.assignments.find((a) => a.roomId === assignment.roomId);
    const stored: IRoomAssignment = {
      ...assignment,
      id: previous?.id ?? makeOpaqueId('asg-', 6),
      revision: (previous?.revision ?? 0) + 1,
    };
    this.state.assignments = this.state.assignments.filter((a) => a.roomId !== assignment.roomId);
    this.state.assignments.push(stored);
    await this.store.save(this.state);
    return stored;
  }

  async clearAssignment(roomId: string): Promise<{ cleared: boolean; reason?: string }> {
    const session = this.state.sessions.find((s) => s.roomId === roomId && !s.finalReceived);
    if (session) {
      return { cleared: false, reason: 'This room has an unfinished scoring session. Wait for its result first.' };
    }
    this.state.assignments = this.state.assignments.filter((a) => a.roomId !== roomId);
    await this.store.save(this.state);
    return { cleared: true };
  }

  /** Record what the director decided about a received result. */
  async resolveResult(resultId: string, status: IReceivedResult['status']): Promise<void> {
    const result = this.state.results.find((entry) => entry.id === resultId);
    if (!result) return;
    result.status = status;
    await this.store.save(this.state);
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
   * How a document stands against what is already recorded, without recording it.
   *
   * The manual import path uses this to tell a director "this is the backup copy of a result you
   * already have" instead of quietly creating a second match for the same game.
   */
  classifyResult(document: object): ResultComparison {
    const identity = readResultIdentity(document);
    if (!identity) return { kind: 'new' };
    return compareToRecorded(
      { matchId: identity.matchId, fingerprint: identity.fingerprint },
      this.state.results.map((r) => ({ id: r.id, matchId: r.matchId, fingerprint: r.fingerprint })),
    );
  }

  /**
   * Record a result that arrived as a file rather than over the network.
   *
   * The manual path calls this so that a later network retry of the same game is recognised as a
   * duplicate. Without it, "control imported the file, then the room reconnected" would produce a
   * second match, which is one of the cases this adapter exists to prevent.
   */
  async recordFileResult(document: object): Promise<void> {
    const identity = readResultIdentity(document);
    if (!identity) return;
    if (identity.tournamentId && identity.tournamentId !== this.state.tournamentId) {
      throw new Error('That result belongs to a different tournament.');
    }
    const comparison = compareToRecorded(
      { matchId: identity.matchId, fingerprint: identity.fingerprint },
      this.state.results.map((r) => ({ id: r.id, matchId: r.matchId, fingerprint: r.fingerprint })),
    );
    if (comparison.kind !== 'new') return;
    this.state.results.push({
      id: makeOpaqueId('res-', 8),
      roomId: '',
      sessionId: '',
      matchId: identity.matchId ?? '',
      fingerprint: identity.fingerprint,
      status: 'accepted',
      document: stripCredentialKeys(document) as object,
      receivedAt: new Date().toISOString(),
      ...(identity.roundNumber !== undefined ? { roundNumber: identity.roundNumber } : {}),
    });
    await this.store.save(this.state);
  }

  // --- request handling -----------------------------------------------------------------------

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const cors = applyCors(request, response, this.allowedOrigins);

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

    if (urlTooLong(request)) {
      sendJson(response, 414, { error: 'That request address was too long.' });
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
    if (path === qbtcpPrefix && method === 'GET') {
      sendJson(response, 200, {
        protocol: 'QBTCP',
        version: 1,
        capabilities: [...advertisedCapabilities],
        qbj_version: qbjVersion,
        name: this.tournamentName,
      });
      return;
    }

    if (path === `${qbtcpPrefix}/rooms` && method === 'GET') {
      // This is pre-pairing discovery: QBSheet uses the names to show a room picker before it has a
      // credential. The response contains no token or pairing code; the pairing endpoint still keeps
      // its identical-failure oracle protection.
      sendJson(response, 200, {
        rooms: this.state.rooms.filter((entry) => entry.enabled).map((entry) => ({ id: entry.id, name: entry.name })),
      });
      return;
    }

    if (path === `${qbtcpPrefix}/pair` && method === 'POST') {
      await this.handlePair(request, response);
      return;
    }

    if (path === `${qbtcpPrefix}/assignment/status` && method === 'GET') {
      const room = this.authorizeRoom(request, response);
      if (!room) return;
      this.sendAssignmentStatus(room, response);
      return;
    }

    if (path === `${qbtcpPrefix}/assignment` && method === 'GET') {
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

    if (path === `${qbtcpPrefix}/sessions` && method === 'POST') {
      await this.handleOpenSession(request, response);
      return;
    }

    if (path === `${qbtcpPrefix}/presence`) {
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
        });
        return;
      }
      sendJson(response, 405, { error: 'Method not allowed.' });
      return;
    }

    const sessionRoute = sessionRoutePattern.exec(path);
    if (sessionRoute) {
      await this.handleSessionRoute(decodeURIComponent(sessionRoute[1]), sessionRoute[2], method, request, response);
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

  private authorizeSession(sessionId: string, request: IncomingMessage, response: ServerResponse): ISession | null {
    const token = headerValue(request, sessionTokenHeader);
    const session = this.state.sessions.find((entry) => entry.id === sessionId);
    // The token must match this session, not merely be a valid token somewhere: a session capability
    // reaches exactly one session.
    if (!session || !token || session.sessionToken !== token) {
      sendJson(response, 401, { error: 'This session is not open.' });
      return null;
    }
    return session;
  }

  // --- assignment status ----------------------------------------------------------------------

  private sendAssignmentStatus(room: IRoom, response: ServerResponse): void {
    const assignment = this.state.assignments.find((a) => a.roomId === room.id);
    const session = assignment
      ? this.state.sessions.find((s) => s.roomId === room.id && s.matchId === assignment.matchId)
      : undefined;

    sendJson(response, 200, {
      state: assignment ? 'assigned' : 'none',
      blocked_reason: null,
      blocked_message: null,
      session: session ? { session_id: session.id, resumable: true } : null,
      ...(assignment ? { released_round: assignment.roundNumber } : {}),
      hold_new_starts: false,
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

    const existing = this.state.sessions.find((s) => s.roomId === room.id && s.matchId === matchId);
    if (existing) {
      // Reopening never transfers the lock: an automatic transfer is exactly how two devices end up
      // both believing they are authoritative.
      const isWriter = existing.writerDeviceId === null || existing.writerDeviceId === (deviceId ?? null);
      if (existing.writerDeviceId === null && deviceId) {
        existing.writerDeviceId = deviceId;
        await this.store.save(this.state);
      }
      sendJson(response, 200, { session_id: existing.id, token: existing.sessionToken, writer: isWriter });
      return;
    }

    const now = new Date().toISOString();
    const session: ISession = {
      id: makeOpaqueId('sess-', 8),
      roomId: room.id,
      matchId,
      sessionToken: `st-${randomBytes(24).toString('hex')}`,
      writerDeviceId: deviceId ?? null,
      progressSequence: 0,
      finalReceived: false,
      createdAt: now,
      updatedAt: now,
    };
    this.state.sessions.push(session);
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, { session_id: session.id, token: session.sessionToken, writer: true });
  }

  private async handleSessionRoute(
    sessionId: string,
    kind: string,
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const session = this.authorizeSession(sessionId, request, response);
    if (!session) return;

    if (kind === 'recovery' && method === 'GET') {
      const assignment = this.state.assignments.find((a) => a.matchId === session.matchId);
      // Deliberately camelCase: this is the shape the client reads for recovery on both surfaces.
      sendJson(response, 200, {
        sessionId: session.id,
        roundNumber: assignment?.roundNumber ?? 0,
        leftTeam: assignment?.leftTeamName ?? '',
        rightTeam: assignment?.rightTeamName ?? '',
        finalReceived: session.finalReceived,
        latestQbj: session.progressMatch ?? null,
      });
      return;
    }

    if (kind === 'writer' && method === 'POST') {
      await this.handleWriterTakeover(session, request, response);
      return;
    }

    if (kind === 'progress' && method === 'PUT') {
      await this.handleProgress(session, request, response);
      return;
    }

    if (kind === 'result' && method === 'POST') {
      await this.handleResult(session, request, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed.' });
  }

  private async handleWriterTakeover(
    session: ISession,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body) || body.take_over !== true) {
      // A takeover is always explicit and a person always starts it.
      sendJson(response, 400, { error: 'A change of writer has to be asked for explicitly.' });
      return;
    }
    session.writerDeviceId = stringField(body.device_id, 256) ?? null;
    session.updatedAt = new Date().toISOString();
    await this.store.save(this.state);
    this.hooks.onStateChanged();
    // The token does not change on a transfer; only who may write with it does.
    sendJson(response, 200, { session_id: session.id, token: session.sessionToken, writer: true });
  }

  /**
   * Replace this session's snapshot.
   *
   * Best effort by design. A snapshot is a whole state rather than a delta, so a client that was
   * offline sends its current state and does not replay what it missed. A sequence lower than the one
   * held is discarded with a `200`: the client is late rather than wrong, and an error would only
   * cause a pointless retry. Nothing here ever reaches YellowFruit's statistics.
   */
  private async handleProgress(session: ISession, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (writerRefused(session, request, response)) return;

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
   * Receive the completed game.
   *
   * The ordering here is the durability contract described at the top of this file. Note that a
   * conflicting result is still persisted before it is refused: retaining both copies is what lets a
   * director resolve the disagreement, and discarding the loser would destroy the evidence.
   */
  private async handleResult(session: ISession, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (writerRefused(session, request, response)) return;

    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;
    if (!isPlainObject(body)) {
      sendJson(response, 400, { error: 'That result was not a readable QBJ document.' });
      return;
    }

    const identity = readResultIdentity(body);
    if (!identity) {
      sendJson(response, 400, { error: 'That result contained no match this server could read.' });
      return;
    }
    if (identity.tournamentId && identity.tournamentId !== this.state.tournamentId) {
      sendJson(response, 409, { error: 'That result belongs to a different tournament.' });
      return;
    }

    if (!identity.matchId || identity.matchId !== session.matchId) {
      sendJson(response, 409, { error: 'That result does not belong to this scoring session.' });
      return;
    }

    const assignment = this.state.assignments.find(
      (entry) => entry.roomId === session.roomId && entry.matchId === session.matchId,
    );
    if (!assignment) {
      sendJson(response, 409, { error: 'That result no longer belongs to an assigned game.' });
      return;
    }

    const assignmentError = validateResultAgainstAssignment(body, assignment);
    if (assignmentError) {
      sendJson(response, 409, { error: assignmentError });
      return;
    }

    const comparison = compareToRecorded(
      { matchId: identity.matchId, fingerprint: identity.fingerprint },
      this.state.results.map((r) => ({ id: r.id, matchId: r.matchId, fingerprint: r.fingerprint })),
    );

    if (comparison.kind === 'duplicate') {
      // The correct answer to a retry, and not an error. No second result is recorded.
      session.finalReceived = true;
      session.updatedAt = new Date().toISOString();
      await this.store.save(this.state);
      sendJson(response, 200, {
        accepted: true,
        match_id: identity.matchId,
        fingerprint: identity.fingerprint,
        duplicate: true,
      });
      this.hooks.onStateChanged();
      return;
    }

    const received: IReceivedResult = {
      id: makeOpaqueId('res-', 8),
      roomId: session.roomId,
      sessionId: session.id,
      matchId: identity.matchId,
      fingerprint: identity.fingerprint,
      status: comparison.kind === 'conflict' ? 'conflict' : 'needs-review',
      // Kept exactly as it arrived, minus anything credential-shaped that should never have been in
      // it. This is the evidence the director falls back to.
      document: stripCredentialKeys(body) as object,
      receivedAt: new Date().toISOString(),
      ...(comparison.kind === 'conflict' ? { conflictsWithResultId: comparison.existingId } : {}),
      // A bare QBSheet Match may not carry a round number. The current assignment is authoritative
      // once the session and match identity have been checked, so keep enough context to reopen the
      // review after a restart.
      ...(identity.roundNumber !== undefined
        ? { roundNumber: identity.roundNumber }
        : { roundNumber: assignment.roundNumber }),
    };
    this.state.results.push(received);
    session.finalReceived = true;
    session.updatedAt = new Date().toISOString();

    // Durable before anything is acknowledged. A crash after this point loses nothing.
    await this.store.save(this.state);

    if (comparison.kind === 'conflict') {
      this.hooks.onResultReceived(received);
      sendJson(response, 409, {
        error: 'A different result is already recorded for this game. Tournament control must resolve it.',
        match_id: received.matchId,
        fingerprint: received.fingerprint,
        duplicate: false,
      });
      return;
    }

    sendJson(response, 200, {
      accepted: true,
      match_id: received.matchId,
      fingerprint: received.fingerprint,
      duplicate: false,
    });

    // Told after the acknowledgement: the renderer failing to hear costs a refresh, and the result is
    // already safe on disk either way.
    this.hooks.onResultReceived(received);
  }

  // --- presence -------------------------------------------------------------------------------

  private async handlePresencePost(room: IRoom, request: IncomingMessage, response: ServerResponse): Promise<void> {
    // Read and discard the body: presence carries nothing this server needs beyond the headers, but
    // the stream still has to be consumed and bounded.
    const body = await this.readJsonBody(request, response);
    if (body === undefined) return;

    const entry = {
      roomId: room.id,
      lastSeenAt: new Date().toISOString(),
      ...(headerValue(request, deviceIdHeader) ? { deviceId: headerValue(request, deviceIdHeader) } : {}),
      ...(headerValue(request, operatorNameHeader) ? { operatorName: headerValue(request, operatorNameHeader) } : {}),
    };
    this.state.presence = this.state.presence.filter((p) => p.roomId !== room.id);
    this.state.presence.push(entry);
    // Advisory: a lost heartbeat never ends a session, so this is not worth blocking a response on.
    this.store.saveBestEffort(this.state);
    this.hooks.onStateChanged();
    sendJson(response, 200, {});
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
}

/**
 * Refuse a write that another device owns, when the writer can be identified.
 *
 * The device id is an informational header, and current QBSheet does not send it on a session write
 * - only when opening a session. So the lock is enforced here for a client that does identify
 * itself, and a write from an unidentified client is accepted rather than refused, because refusing
 * it would refuse the legitimate writer too. The enforcement a client actually observes today is at
 * session open, which reports `writer: false` to the device that does not hold the lock.
 *
 * `409` rather than `401` on purpose: the session token is perfectly valid, and a device without the
 * lock may read. Conflating them would send a room hunting for a pairing code to fix a problem that
 * a person standing next to the other device has to resolve.
 */
function writerRefused(session: ISession, request: IncomingMessage, response: ServerResponse): boolean {
  const deviceId = headerValue(request, deviceIdHeader);
  if (!deviceId || session.writerDeviceId === null || session.writerDeviceId === deviceId) return false;
  sendJson(response, 409, {
    error: 'Another device is scoring this game.',
    writer_device: session.writerDeviceId,
    can_take_over: true,
  });
  return true;
}

/** Validate the identity and assignment metadata before a final can be compared or stored. */
export function validateResultAgainstAssignment(body: object, assignment: IRoomAssignment): string | undefined {
  const match = findResultMatch(body);
  if (!match) return 'That result contained no match this server could read.';

  const rawTeams = match.match_teams ?? match.matchTeams;
  if (!Array.isArray(rawTeams) || rawTeams.length !== 2) {
    return 'That result does not contain the two teams assigned to this scoring session.';
  }
  const teamIds = rawTeams.map(teamIdFromMatchTeam);
  const hasAllTeamIds = teamIds.every((teamId) => teamId !== undefined);
  const hasNoTeamIds = teamIds.every((teamId) => teamId === undefined);
  if (hasAllTeamIds) {
    if (teamIds[0] !== assignment.leftTeamId || teamIds[1] !== assignment.rightTeamId) {
      return 'That result does not contain the two teams assigned to this scoring session.';
    }
  } else if (hasNoTeamIds && match === body) {
    const teamNames = rawTeams.map(teamNameFromMatchTeam);
    if (
      teamNames[0] !== assignment.leftTeamName ||
      teamNames[1] !== assignment.rightTeamName ||
      teamNames.some((teamName) => teamName === undefined)
    ) {
      return 'That result does not contain the two teams assigned to this scoring session.';
    }
  } else {
    return 'That result does not contain the two teams assigned to this scoring session.';
  }

  const extension = match._qbtcp;
  let revision: unknown;
  if (extension !== undefined) {
    if (!isPlainObject(extension)) return 'That result contains invalid QBTCP assignment metadata.';
    revision = extension.round_revision ?? extension.roundRevision;
  }
  if (revision === undefined) revision = readResultSourceMetadata(match).roundRevision;
  if (
    revision !== undefined &&
    (typeof revision !== 'number' || !Number.isInteger(revision) || revision !== assignment.revision)
  ) {
    return 'That result belongs to an older assignment for this room.';
  }
  return undefined;
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

const presenceFreshMs = 45_000;

function isRecent(timestamp?: string): boolean {
  if (!timestamp) return false;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && Date.now() - parsed < presenceFreshMs;
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
