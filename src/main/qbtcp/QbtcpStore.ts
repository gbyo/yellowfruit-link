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
} from '../../qbtcp/QbtcpState';
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

interface IValidatedState {
  state: IQbtcpTournamentState;
  /** How many individual records had to be dropped. Zero means the file loaded whole. */
  discarded: number;
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
  if (parsed.stateVersion !== qbtcpStateVersion) return null;
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
  const assignments = records(parsed.assignments).flatMap((a) =>
    typeof a.id === 'string' &&
    typeof a.roomId === 'string' &&
    typeof a.matchId === 'string' &&
    isPlainObject(a.document)
      ? [a]
      : keep(null),
  );
  const sessions = records(parsed.sessions).flatMap((session) => {
    const legacyWriterDeviceId =
      session.writerDeviceId === undefined || session.writerDeviceId === null ? null : session.writerDeviceId;
    if (legacyWriterDeviceId !== null && typeof legacyWriterDeviceId !== 'string') return keep(null);
    const grants = sessionGrants(session, legacyWriterDeviceId);
    if (
      typeof session.id !== 'string' ||
      typeof session.roomId !== 'string' ||
      // Without the game it belongs to, a session can neither be matched to an assignment nor have a
      // result checked against it, but it would still lock its room as unfinished work.
      typeof session.matchId !== 'string' ||
      grants === null ||
      // The live protocol accepts only whole, non-negative sequences. A stored 1.5 would silently
      // classify the legitimate sequence 2 that follows it as stale.
      (session.progressSequence !== undefined && !isNonNegativeInteger(session.progressSequence)) ||
      (session.finalReceived !== undefined && typeof session.finalReceived !== 'boolean')
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

    return [
      {
        // `sessionToken` is dropped: it has been migrated into a grant, and leaving it behind would
        // keep a second copy of a live capability in the file.
        ...without(session, 'sessionToken'),
        grants,
        progressSequence: session.progressSequence ?? 0,
        finalReceived: session.finalReceived ?? false,
        writerGrantToken,
        // The label follows the credential. A hand-edited or stale label can never create authority.
        writerDeviceId: writerGrant?.deviceId ?? null,
      },
    ];
  });
  const validStatuses = new Set<ReceivedResultStatus>(['needs-review', 'accepted', 'duplicate', 'conflict']);
  const results = records(parsed.results).flatMap((result) => {
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
      (result.status !== undefined &&
        (typeof result.status !== 'string' || !validStatuses.has(result.status as ReceivedResultStatus)))
    ) {
      return keep(null);
    }
    return [{ ...result, status: (result.status as ReceivedResultStatus | undefined) ?? 'needs-review' }];
  });
  const now = Date.now();
  const presence = records(parsed.presence).flatMap((p) => {
    const lastSeenAt = typeof p.lastSeenAt === 'string' ? Date.parse(p.lastSeenAt) : NaN;
    return typeof p.roomId === 'string' && Number.isFinite(lastSeenAt) && lastSeenAt <= now ? [p] : keep(null);
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
