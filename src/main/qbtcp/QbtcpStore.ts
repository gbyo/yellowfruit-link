/**
 * Where the Rooms adapter keeps its operational state.
 *
 * # Separate from the tournament, on purpose
 *
 * One file per tournament under the app-data directory:
 *
 *     <userData>/qbtcp/<tournament-id-digest>.json
 *
 * It never touches the .yft. That separation is the point: a corrupt QBTCP file must not be able to
 * damage the tournament's actual record, and a tournament whose QBTCP state is missing or unreadable
 * must still open and still support every manual workflow. `load` therefore treats an unreadable file
 * as "no state yet" and reports the problem rather than throwing.
 *
 * # Writes are atomic and serialized
 *
 * Every write goes through `writeFileAtomically`, so a crash mid-write leaves the previous complete
 * state rather than a truncated one. Writes are also queued behind each other, because two overlapping
 * saves of the same file would race on the rename and the loser's contents would vanish silently.
 *
 * # It holds credentials
 *
 * Pairing codes and capability tokens live in this file. Nothing here logs its own contents, and the
 * renderer is never handed the raw state - see `IRoomView`.
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'node:crypto';
import { writeFileAtomically, IAtomicFileSystem } from './AtomicFile';
import {
  IQbtcpTournamentState,
  ISessionGrant,
  HelpRequestStatus,
  emptyQbtcpState,
  qbtcpStateVersion,
  ReceivedResultStatus,
  QbtcpSessionStatus,
  IResultReview,
  ResultReviewDecision,
  IQbtcpRosterAmendment,
} from '../../qbtcp/QbtcpState';
import type { IResultDiscrepancy, IResultReceiptContext } from '../../qbtcp/ResultDiscrepancy';
import { discrepancyMessage, resultDiscrepancyCodes } from '../../qbtcp/ResultDiscrepancy';
import { qbtcpHelpCategories, QbtcpHelpCategory } from '../../qbtcp/QbtcpProtocol';

export interface IQbtcpStoreLoad {
  state: IQbtcpTournamentState;
  /**
   * Set when a file existed but could not be used, with a message safe to show a director.
   *
   * The state returned alongside it is a fresh empty one, so the application keeps working. The
   * message exists so the Rooms page can say the QBTCP state was lost rather than pretending the
   * tournament never had any rooms.
   */
  problem?: string;
}

export default class QbtcpStore {
  private readonly directory: string;

  /** Serializes writes so two saves cannot race on the rename. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    userDataPath: string,
    private fileSystem?: IAtomicFileSystem,
  ) {
    this.directory = path.join(userDataPath, 'qbtcp');
  }

  /**
   * The path for a tournament's state.
   *
   * A digest contains no path characters and avoids collisions between distinct imported or edited
   * tournament ids.
   */
  private pathFor(tournamentId: string): string {
    const digest = createHash('sha256').update(tournamentId, 'utf8').digest('hex').slice(0, 32);
    return path.join(this.directory, `${digest}.json`);
  }

  /** The filename used before state files were keyed by a digest. */
  private legacyPathFor(tournamentId: string): string {
    const safe =
      tournamentId
        .replace(/[^A-Za-z0-9._-]/g, '_')
        .replace(/^\.+/, '')
        .slice(0, 128) || 'unknown';
    return path.join(this.directory, `${safe}.json`);
  }

  /** Preserve a state file that cannot be adopted before a later save can replace it. */
  // eslint-disable-next-line class-methods-use-this
  private async preserveUnusableFile(filePath: string): Promise<void> {
    const parsed = path.parse(filePath);
    const preservedPath = path.join(parsed.dir, `${parsed.name}.unusable-${nowStamp()}${parsed.ext || '.json'}`);
    try {
      await fs.promises.rename(filePath, preservedPath);
    } catch {
      // Opening the tournament must still succeed if the file cannot be moved aside.
    }
  }

  /**
   * Keep a copy of a file whose usable part is still being adopted.
   *
   * Copied rather than moved: the salvaged state is in use, and the next save writes over the
   * original. Without the copy, the records that could not be read would be gone for good the first
   * time anything changed.
   */
  // eslint-disable-next-line class-methods-use-this
  private async preserveDamagedFile(filePath: string): Promise<void> {
    const parsed = path.parse(filePath);
    const preservedPath = path.join(parsed.dir, `${parsed.name}.damaged-${nowStamp()}${parsed.ext || '.json'}`);
    try {
      await fs.promises.copyFile(filePath, preservedPath);
    } catch {
      // Opening the tournament must still succeed if the copy cannot be made.
    }
  }

  async load(tournamentId: string): Promise<IQbtcpStoreLoad> {
    const currentPath = this.pathFor(tournamentId);
    let stateFilePath = currentPath;
    let text: string;
    try {
      text = await fs.promises.readFile(currentPath, 'utf8');
    } catch (error) {
      // Nothing saved yet is the ordinary case for a new tournament, and not a problem.
      if ((error as { code?: string }).code !== 'ENOENT') {
        await this.preserveUnusableFile(currentPath);
        return {
          state: emptyQbtcpState(tournamentId),
          problem: 'The saved Rooms state for this tournament could not be read. Rooms will start empty.',
        };
      }

      const legacyPath = this.legacyPathFor(tournamentId);
      try {
        text = await fs.promises.readFile(legacyPath, 'utf8');
        stateFilePath = legacyPath;
      } catch (legacyError) {
        if ((legacyError as { code?: string }).code === 'ENOENT') {
          return { state: emptyQbtcpState(tournamentId) };
        }
        await this.preserveUnusableFile(legacyPath);
        return {
          state: emptyQbtcpState(tournamentId),
          problem: 'The saved Rooms state for this tournament could not be read. Rooms will start empty.',
        };
      }
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      await this.preserveUnusableFile(stateFilePath);
      return {
        state: emptyQbtcpState(tournamentId),
        problem: 'The saved Rooms state for this tournament is damaged. Rooms will start empty.',
      };
    }

    const validated = validateState(parsed, tournamentId);
    if (!validated) {
      await this.preserveUnusableFile(stateFilePath);
      return {
        state: emptyQbtcpState(tournamentId),
        problem: 'The saved Rooms state for this tournament is not usable. Rooms will start empty.',
      };
    }

    let problem: string | undefined;
    if (validated.discarded > 0) {
      // The salvageable part is still adopted - refusing all of it would lose the rooms and results
      // that are perfectly good. But a record that vanished is not a healthy load, and the next save
      // will overwrite the file it vanished from, so a copy is kept and the director is told.
      await this.preserveDamagedFile(stateFilePath);
      problem =
        `${validated.discarded} saved Rooms ${validated.discarded === 1 ? 'record was' : 'records were'} damaged ` +
        'and could not be loaded. The rest of this tournament’s Rooms state was kept, and a copy of the ' +
        'damaged file is in the app data folder.';
    }

    if (stateFilePath !== currentPath) {
      try {
        await fs.promises.rename(stateFilePath, currentPath);
      } catch {
        // The validated state is still usable; a later load can retry the migration.
      }
    }
    if (validated.migrated || stateFilePath !== currentPath || validated.discarded > 0) {
      try {
        // Write the normalized state only after the legacy/damaged source has been preserved. A
        // failed migration must leave the original evidence available for a later build to inspect.
        await this.save(validated.state);
      } catch {
        problem = `${problem ?? 'The Rooms state was read.'} The normalized state could not be saved yet.`;
      }
    }
    return { state: validated.state, ...(problem ? { problem } : {}) };
  }

  /**
   * Persist state, and do not resolve until it is durable.
   *
   * Callers that must not acknowledge anything before the data is safe - the result handler above all
   * - depend on that ordering, so this deliberately does not fire-and-forget.
   */
  async save(state: IQbtcpTournamentState): Promise<void> {
    const run = this.writeChain.then(async () => {
      await fs.promises.mkdir(this.directory, { recursive: true });
      await writeFileAtomically(this.pathFor(state.tournamentId), JSON.stringify(state), this.fileSystem);
      return undefined;
    });
    // Keep the chain alive on failure so one failed write does not wedge every later one.
    this.writeChain = run.catch(() => undefined);
    return run;
  }

  /**
   * Persist state where the caller does not wait, and a failure is acceptable.
   *
   * For progress snapshots and presence only - things that are explicitly best effort and must never
   * make a room wait on a disk. It exists as its own method because `save(...)` without an `await`
   * leaves a rejected promise nobody handles, and an unhandled rejection in the main process can take
   * the whole application down. A dropped snapshot costs a stale number on one screen.
   */
  saveBestEffort(state: IQbtcpTournamentState): void {
    this.save(state).catch(() => undefined);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A timestamp safe to put in a file name. */
function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** A copy of a record without one key. Used to drop a field that cannot be carried forward. */
function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

function isNonNegativeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function optionalReference(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value.slice(0, 1024);
}

interface IListValidation<T> {
  value: T[];
  discarded: number;
}

function rosterAmendments(value: unknown): IListValidation<IQbtcpRosterAmendment> | null {
  if (value === undefined) return { value: [], discarded: 0 };
  if (!Array.isArray(value)) return null;
  const amendments: IQbtcpRosterAmendment[] = [];
  let discarded = Math.max(0, value.length - 200);
  for (const entry of value.slice(0, 200)) {
    if (!isPlainObject(entry)) {
      discarded += 1;
      continue;
    }
    const teamId = typeof entry.teamId === 'string' ? entry.teamId.trim().slice(0, 256) : '';
    const teamName = typeof entry.teamName === 'string' ? entry.teamName.trim().slice(0, 512) : '';
    const playerName = typeof entry.playerName === 'string' ? entry.playerName.trim().slice(0, 200) : '';
    const playerId =
      typeof entry.playerId === 'string' && entry.playerId.trim() !== ''
        ? entry.playerId.trim().slice(0, 256)
        : undefined;
    if (!teamId || !teamName || !playerName) {
      discarded += 1;
      continue;
    }
    const questionNumber =
      typeof entry.questionNumber === 'number' && Number.isInteger(entry.questionNumber) && entry.questionNumber >= 1
        ? entry.questionNumber
        : undefined;
    const recordedAt = typeof entry.recordedAt === 'string' ? entry.recordedAt.slice(0, 128) : undefined;
    const warning =
      typeof entry.warning === 'string' && entry.warning.trim() !== '' ? entry.warning.trim().slice(0, 200) : undefined;
    amendments.push({
      teamId,
      teamName,
      playerName,
      ...(playerId ? { playerId } : {}),
      ...(entry.created === true || entry.created === false ? { created: entry.created } : {}),
      ...(questionNumber !== undefined ? { questionNumber } : {}),
      ...(recordedAt ? { recordedAt } : {}),
      ...(warning ? { warning } : {}),
    });
  }
  return { value: amendments, discarded };
}

function presenceClient(value: unknown): { name?: string; version?: string; build?: string; commit?: string } | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const client: { name?: string; version?: string; build?: string; commit?: string } = {};
  for (const key of ['name', 'version', 'build', 'commit'] as const) {
    const entry = value[key];
    if (entry !== undefined && typeof entry !== 'string') return null;
    if (typeof entry === 'string' && entry.trim() !== '') client[key] = entry.slice(0, 100);
  }
  return client;
}

/**
 * The grants recorded for a session, migrating a file written before they existed.
 *
 * Older files hold one `sessionToken` shared by every device on the session. That token stays valid
 * and is attributed to whichever device held the writer lock, which is the only device that could
 * have been using it in a way that mattered.
 */
function sessionGrants(session: Record<string, unknown>, writerDeviceId: string | null): ISessionGrant[] | null {
  if (Array.isArray(session.grants)) {
    const grants = session.grants.filter(
      (entry): entry is ISessionGrant =>
        isPlainObject(entry) &&
        typeof entry.token === 'string' &&
        entry.token !== '' &&
        (entry.deviceId === null || typeof entry.deviceId === 'string'),
    );
    return grants.length === session.grants.length ? grants : null;
  }
  if (typeof session.sessionToken === 'string' && session.sessionToken !== '') {
    return [{ deviceId: writerDeviceId, token: session.sessionToken }];
  }
  return null;
}

function isSessionStatus(value: unknown): value is QbtcpSessionStatus {
  return value === 'open' || value === 'final-received' || value === 'abandoned';
}

function normalizeSessionStatus(session: Record<string, unknown>): QbtcpSessionStatus | null {
  if (session.status !== undefined && !isSessionStatus(session.status)) return null;
  // A legacy finalReceived flag is authoritative when an older state has no lifecycle field. If a
  // partially migrated record says both "open" and finalReceived, keeping it terminal is safer than
  // accepting progress after a durable final.
  if (session.status === 'abandoned') return 'abandoned';
  if (session.status === 'final-received' || session.finalReceived === true) return 'final-received';
  return 'open';
}

function resultContext(value: unknown): IResultReceiptContext | undefined {
  if (!isPlainObject(value)) return undefined;
  const stringKeys = ['tournamentId', 'roomId', 'roomName', 'sessionId', 'expectedMatchId'] as const;
  if (stringKeys.some((key) => typeof value[key] !== 'string')) return undefined;
  const numberKeys = ['expectedRoundNumber', 'expectedAssignmentRevision', 'expectedRoundRevision'] as const;
  if (numberKeys.some((key) => value[key] !== undefined && !isNonNegativeInteger(value[key]))) return undefined;
  const optionalStringKeys = [
    'assignmentId',
    'expectedLeftTeamId',
    'expectedRightTeamId',
    'expectedLeftTeamName',
    'expectedRightTeamName',
  ] as const;
  if (optionalStringKeys.some((key) => value[key] !== undefined && typeof value[key] !== 'string')) return undefined;
  const context = {
    tournamentId: (value.tournamentId as string).slice(0, 256),
    roomId: (value.roomId as string).slice(0, 256),
    roomName: (value.roomName as string).slice(0, 512),
    sessionId: (value.sessionId as string).slice(0, 256),
    expectedMatchId: (value.expectedMatchId as string).slice(0, 256),
    ...(typeof value.assignmentId === 'string' ? { assignmentId: value.assignmentId.slice(0, 256) } : {}),
    ...(typeof value.expectedRoundNumber === 'number' ? { expectedRoundNumber: value.expectedRoundNumber } : {}),
    ...(typeof value.expectedAssignmentRevision === 'number'
      ? { expectedAssignmentRevision: value.expectedAssignmentRevision }
      : {}),
    ...(typeof value.expectedRoundRevision === 'number' ? { expectedRoundRevision: value.expectedRoundRevision } : {}),
    ...(typeof value.expectedLeftTeamId === 'string'
      ? { expectedLeftTeamId: value.expectedLeftTeamId.slice(0, 256) }
      : {}),
    ...(typeof value.expectedRightTeamId === 'string'
      ? { expectedRightTeamId: value.expectedRightTeamId.slice(0, 256) }
      : {}),
    ...(typeof value.expectedLeftTeamName === 'string'
      ? { expectedLeftTeamName: value.expectedLeftTeamName.slice(0, 512) }
      : {}),
    ...(typeof value.expectedRightTeamName === 'string'
      ? { expectedRightTeamName: value.expectedRightTeamName.slice(0, 512) }
      : {}),
  };
  return context;
}

function resultWarnings(value: unknown): IListValidation<IResultDiscrepancy> | null {
  if (value === undefined) return { value: [], discarded: 0 };
  if (!Array.isArray(value)) return null;
  const validCodes = new Set<string>(resultDiscrepancyCodes);
  const warnings: IResultDiscrepancy[] = [];
  let discarded = Math.max(0, value.length - 200);
  for (const entry of value.slice(0, 200)) {
    if (!isPlainObject(entry) || typeof entry.code !== 'string' || !validCodes.has(entry.code)) {
      discarded += 1;
      continue;
    }
    if (typeof entry.message !== 'string') {
      discarded += 1;
      continue;
    }
    const expected = safeWarningValue(entry.expected);
    const received = safeWarningValue(entry.received);
    const code = entry.code as IResultDiscrepancy['code'];
    const warning: IResultDiscrepancy = {
      code,
      // Use the canonical message for the code. A hand-edited state file must not turn the review
      // queue into a place to display an arbitrary string or a copied credential.
      message: discrepancyMessage(code),
      ...(expected === undefined ? {} : { expected }),
      ...(received === undefined ? {} : { received }),
      ...(entry.resolution === 'unresolved' || entry.resolution === 'accepted' || entry.resolution === 'dismissed'
        ? { resolution: entry.resolution }
        : {}),
    };
    warnings.push(warning);
  }
  return { value: warnings, discarded };
}

function safeWarningValue(value: unknown, depth = 0): IResultDiscrepancy['expected'] | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 512);
  if (Array.isArray(value) && depth < 2) {
    return value.slice(0, 8).map((entry) => safeWarningValue(entry, depth + 1) ?? null);
  }
  return undefined;
}

function resultReview(value: unknown): IResultReview | undefined {
  if (!isPlainObject(value)) return undefined;
  const decisions = new Set<ResultReviewDecision>(['accept', 'keep-existing', 'dismiss', 'supersede']);
  if (
    typeof value.decision !== 'string' ||
    !decisions.has(value.decision as ResultReviewDecision) ||
    typeof value.resolvedAt !== 'string'
  ) {
    return undefined;
  }
  const review: IResultReview = {
    decision: value.decision as ResultReviewDecision,
    resolvedAt: value.resolvedAt.slice(0, 128),
    ...(typeof value.reason === 'string' && value.reason.trim() !== ''
      ? { reason: value.reason.trim().slice(0, 1000) }
      : {}),
    ...(optionalReference(value.targetResultId) ? { targetResultId: optionalReference(value.targetResultId) } : {}),
  };
  return review;
}

interface IValidatedState {
  state: IQbtcpTournamentState;
  /** How many individual records had to be dropped. Zero means the file loaded whole. */
  discarded: number;
  /** True when an older operational schema was normalized to the current schema. */
  migrated: boolean;
}

/**
 * Accept a parsed state file, or reject it.
 *
 * Its own file, but still untrusted: it may have been written by a different build, hand-edited, or
 * left behind by a version that stored something else. A shape check here is cheaper than a crash
 * during a round. Unknown fields on a record are preserved, since a newer build may have added one.
 *
 * Individual bad records are dropped rather than taking the whole file with them - one unreadable
 * room must not cost a director every other room. But the count is reported, because a session or a
 * result quietly disappearing is exactly the kind of loss somebody needs to hear about while there
 * is still a paper scoresheet in the building.
 */
function validateState(parsed: unknown, tournamentId: string): IValidatedState | null {
  if (!isPlainObject(parsed)) return null;
  const sourceVersion = parsed.stateVersion;
  if (sourceVersion !== 1 && sourceVersion !== 2 && sourceVersion !== qbtcpStateVersion) return null;
  // State bound to a different tournament must never be adopted by this one; the results inside it
  // belong to somebody else's games.
  if (parsed.tournamentId !== tournamentId) return null;
  if (parsed.scoresheetUrl !== undefined && typeof parsed.scoresheetUrl !== 'string') return null;

  let discarded = 0;
  const records = (value: unknown): Record<string, unknown>[] => {
    if (!Array.isArray(value)) return [];
    const objects = value.filter(isPlainObject);
    discarded += value.length - objects.length;
    return objects;
  };
  const keep = <T>(kept: T[] | null): T[] => {
    if (kept === null) {
      discarded += 1;
      return [];
    }
    return kept;
  };

  const rooms = records(parsed.rooms).flatMap((room) => {
    if (
      typeof room.id !== 'string' ||
      typeof room.name !== 'string' ||
      typeof room.pairingCode !== 'string' ||
      (room.enabled !== undefined && typeof room.enabled !== 'boolean')
    ) {
      return keep(null);
    }
    // A missing or unusable token cannot authenticate a request, so retaining one would make a room
    // read as paired while every scoresheet was refused. Drop the field without losing the room.
    if (room.roomToken !== undefined && (typeof room.roomToken !== 'string' || room.roomToken.trim() === '')) {
      discarded += 1;
      return [{ ...without(room, 'roomToken'), enabled: room.enabled ?? true }];
    }
    return [{ ...room, enabled: room.enabled ?? true }];
  });
  const assignments = records(parsed.assignments).flatMap((a) => {
    const assignmentRevision =
      typeof a.revision === 'number' && Number.isInteger(a.revision) && a.revision >= 1 ? a.revision : 1;
    const roundRevision =
      typeof a.roundRevision === 'number' && Number.isInteger(a.roundRevision) && a.roundRevision >= 1
        ? a.roundRevision
        : 1;
    if (
      typeof a.id !== 'string' ||
      typeof a.roomId !== 'string' ||
      typeof a.matchId !== 'string' ||
      !isPlainObject(a.document) ||
      (a.revision !== undefined &&
        (typeof a.revision !== 'number' || !Number.isInteger(a.revision) || a.revision < 1)) ||
      (a.roundRevision !== undefined &&
        (typeof a.roundRevision !== 'number' || !Number.isInteger(a.roundRevision) || a.roundRevision < 1))
    ) {
      return keep(null);
    }
    return [{ ...a, revision: assignmentRevision, roundRevision }];
  });
  const sessions = records(parsed.sessions).flatMap((session) => {
    const legacyWriterDeviceId =
      session.writerDeviceId === undefined || session.writerDeviceId === null ? null : session.writerDeviceId;
    if (legacyWriterDeviceId !== null && typeof legacyWriterDeviceId !== 'string') return keep(null);
    const grants = sessionGrants(session, legacyWriterDeviceId);
    const status = normalizeSessionStatus(session);
    const assignmentContext =
      session.assignmentContext === undefined ? undefined : resultContext(session.assignmentContext);
    const amendments = rosterAmendments(session.rosterAmendments);
    if (amendments) discarded += amendments.discarded;
    if (
      typeof session.id !== 'string' ||
      typeof session.roomId !== 'string' ||
      // Without the game it belongs to, a session can neither be matched to an assignment nor have a
      // result checked against it, but it would still lock its room as unfinished work.
      typeof session.matchId !== 'string' ||
      grants === null ||
      status === null ||
      (session.assignmentContext !== undefined && assignmentContext === undefined) ||
      amendments === null ||
      (session.assignmentDocument !== undefined && !isPlainObject(session.assignmentDocument)) ||
      // The live protocol accepts only whole, non-negative sequences. A stored 1.5 would silently
      // classify the legitimate sequence 2 that follows it as stale.
      (session.progressSequence !== undefined && !isNonNegativeInteger(session.progressSequence)) ||
      (session.finalReceived !== undefined && typeof session.finalReceived !== 'boolean') ||
      (session.abandonedAt !== undefined && typeof session.abandonedAt !== 'string') ||
      (session.abandonReason !== undefined && typeof session.abandonReason !== 'string')
    ) {
      return keep(null);
    }

    let writerGrantToken: string | null;
    if (session.writerGrantToken === undefined) {
      // State written before credential-bound writer ownership used the device label as the lock.
      // Migrate that label to the capability already associated with it, if one exists.
      writerGrantToken = grants.find((grant) => grant.deviceId === legacyWriterDeviceId)?.token ?? null;
    } else if (session.writerGrantToken === null) {
      writerGrantToken = null;
    } else if (
      typeof session.writerGrantToken === 'string' &&
      session.writerGrantToken.trim() !== '' &&
      grants.some((grant) => grant.token === session.writerGrantToken)
    ) {
      writerGrantToken = session.writerGrantToken;
    } else {
      return keep(null);
    }
    const writerGrant =
      writerGrantToken === null ? undefined : grants.find((grant) => grant.token === writerGrantToken);
    const storedLateResultGrantToken =
      typeof session.lateResultGrantToken === 'string' &&
      session.lateResultGrantToken.trim() !== '' &&
      grants.some((grant) => grant.token === session.lateResultGrantToken)
        ? session.lateResultGrantToken
        : undefined;
    if (session.lateResultGrantToken !== undefined && storedLateResultGrantToken === undefined) discarded += 1;
    const lateResultGrantToken =
      status === 'abandoned' ? storedLateResultGrantToken ?? writerGrantToken ?? undefined : undefined;
    if (status === 'abandoned') writerGrantToken = null;
    const normalizedSession = without(session, 'sessionToken');
    delete normalizedSession.lateResultGrantToken;
    delete normalizedSession.rosterAmendments;

    return [
      {
        // `sessionToken` is dropped: it has been migrated into a grant, and leaving it behind would
        // keep a second copy of a live capability in the file.
        ...normalizedSession,
        grants,
        progressSequence: session.progressSequence ?? 0,
        status,
        finalReceived: status === 'final-received',
        writerGrantToken,
        ...(lateResultGrantToken ? { lateResultGrantToken } : {}),
        // The label follows the credential. A hand-edited or stale label can never create authority.
        writerDeviceId: status === 'abandoned' ? null : writerGrant?.deviceId ?? null,
        ...(assignmentContext ? { assignmentContext } : {}),
        ...(isPlainObject(session.assignmentDocument) ? { assignmentDocument: session.assignmentDocument } : {}),
        ...(amendments && amendments.value.length > 0 ? { rosterAmendments: amendments.value } : {}),
      },
    ];
  });
  const validStatuses = new Set<ReceivedResultStatus>([
    'needs-review',
    'accepted',
    'duplicate',
    'conflict',
    'dismissed',
    'superseded',
  ]);
  const results = records(parsed.results).flatMap((result) => {
    const warnings = resultWarnings(result.warnings);
    if (warnings) discarded += warnings.discarded;
    const context = result.context === undefined ? undefined : resultContext(result.context);
    const review = resultReview(result.review);
    if (
      typeof result.id !== 'string' ||
      typeof result.fingerprint !== 'string' ||
      !isPlainObject(result.document) ||
      // The identity fields are what associate a result with the room and game it came from. An
      // unresolved result missing them counts as work blocking the whole tournament while being
      // impossible to place against any of it.
      typeof result.roomId !== 'string' ||
      typeof result.sessionId !== 'string' ||
      typeof result.matchId !== 'string' ||
      typeof result.receivedAt !== 'string' ||
      warnings === null ||
      (result.context !== undefined && context === undefined) ||
      (result.claimedMatchId !== undefined && typeof result.claimedMatchId !== 'string') ||
      (result.expectedMatchId !== undefined && typeof result.expectedMatchId !== 'string') ||
      (result.importedMatchId !== undefined && typeof result.importedMatchId !== 'string') ||
      (result.unreadable !== undefined && typeof result.unreadable !== 'boolean') ||
      (result.claimedAssignmentRevision !== undefined && !isNonNegativeInteger(result.claimedAssignmentRevision)) ||
      (result.claimedRoundRevision !== undefined && !isNonNegativeInteger(result.claimedRoundRevision)) ||
      (result.resolution !== undefined &&
        result.resolution !== 'unresolved' &&
        result.resolution !== 'accepted' &&
        result.resolution !== 'dismissed') ||
      (result.status !== undefined &&
        (typeof result.status !== 'string' || !validStatuses.has(result.status as ReceivedResultStatus)))
    ) {
      return keep(null);
    }
    const normalized = { ...result };
    for (const key of [
      'review',
      'conflictsWithResultId',
      'supersedesResultId',
      'supersededByResultId',
      'keepsResultId',
      'dismissedAt',
    ]) {
      delete normalized[key];
    }
    return [
      {
        ...normalized,
        status: (result.status as ReceivedResultStatus | undefined) ?? 'needs-review',
        warnings: warnings?.value ?? [],
        ...(context ? { context } : {}),
        ...(review ? { review } : {}),
        ...(optionalReference(result.conflictsWithResultId)
          ? { conflictsWithResultId: optionalReference(result.conflictsWithResultId) }
          : {}),
        ...(optionalReference(result.supersedesResultId)
          ? { supersedesResultId: optionalReference(result.supersedesResultId) }
          : {}),
        ...(optionalReference(result.supersededByResultId)
          ? { supersededByResultId: optionalReference(result.supersededByResultId) }
          : {}),
        ...(optionalReference(result.keepsResultId) ? { keepsResultId: optionalReference(result.keepsResultId) } : {}),
        ...(optionalReference(result.dismissedAt) ? { dismissedAt: optionalReference(result.dismissedAt) } : {}),
        ...(optionalReference(result.importedMatchId)
          ? { importedMatchId: optionalReference(result.importedMatchId) }
          : {}),
        ...(typeof result.claimedAssignmentRevision === 'number'
          ? { claimedAssignmentRevision: result.claimedAssignmentRevision }
          : {}),
        ...(typeof result.claimedRoundRevision === 'number'
          ? { claimedRoundRevision: result.claimedRoundRevision }
          : {}),
      },
    ];
  });
  const now = Date.now();
  const presence = records(parsed.presence).flatMap((p) => {
    const lastSeenAt = typeof p.lastSeenAt === 'string' ? Date.parse(p.lastSeenAt) : NaN;
    const client = presenceClient(p.client);
    let procedureVersions: number[] | null = [];
    if (p.procedureVersions !== undefined) {
      procedureVersions =
        Array.isArray(p.procedureVersions) &&
        p.procedureVersions.every((entry) => typeof entry === 'number' && Number.isInteger(entry) && entry >= 1)
          ? p.procedureVersions.slice(0, 16)
          : null;
    }
    if (
      typeof p.roomId !== 'string' ||
      !Number.isFinite(lastSeenAt) ||
      lastSeenAt > now ||
      client === null ||
      procedureVersions === null ||
      (p.qbjVersion !== undefined && typeof p.qbjVersion !== 'string')
    ) {
      return keep(null);
    }
    return [
      {
        ...p,
        ...(Object.keys(client).length > 0 ? { client } : {}),
        ...(procedureVersions.length > 0 ? { procedureVersions } : {}),
        ...(typeof p.qbjVersion === 'string' && p.qbjVersion.trim() !== ''
          ? { qbjVersion: p.qbjVersion.slice(0, 50) }
          : {}),
      },
    ];
  });
  const validHelpStatuses = new Set<HelpRequestStatus>(['open', 'cancelled', 'resolved']);
  const validHelpCategories = new Set<QbtcpHelpCategory>(qbtcpHelpCategories);
  const helpRequests = records(parsed.helpRequests).flatMap((request) => {
    if (
      typeof request.id !== 'string' ||
      typeof request.roomId !== 'string' ||
      typeof request.roomName !== 'string' ||
      typeof request.category !== 'string' ||
      !validHelpCategories.has(request.category as QbtcpHelpCategory) ||
      typeof request.message !== 'string' ||
      typeof request.status !== 'string' ||
      !validHelpStatuses.has(request.status as HelpRequestStatus) ||
      typeof request.createdAt !== 'string' ||
      typeof request.updatedAt !== 'string' ||
      (request.deviceId !== undefined && typeof request.deviceId !== 'string') ||
      (request.operatorName !== undefined && typeof request.operatorName !== 'string') ||
      (request.currentMatchup !== undefined && !isPlainObject(request.currentMatchup))
    ) {
      return keep(null);
    }
    return [request];
  });

  return {
    discarded,
    migrated: sourceVersion !== qbtcpStateVersion,
    state: {
      stateVersion: qbtcpStateVersion,
      tournamentId,
      ...(typeof parsed.scoresheetUrl === 'string' ? { scoresheetUrl: parsed.scoresheetUrl } : {}),
      rooms,
      assignments,
      sessions,
      results,
      presence,
      helpRequests,
    } as unknown as IQbtcpTournamentState,
  };
}
