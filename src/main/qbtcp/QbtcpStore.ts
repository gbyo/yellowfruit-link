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
  emptyQbtcpState,
  qbtcpStateVersion,
  ReceivedResultStatus,
} from '../../qbtcp/QbtcpState';

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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preservedPath = path.join(parsed.dir, `${parsed.name}.unusable-${timestamp}${parsed.ext || '.json'}`);
    try {
      await fs.promises.rename(filePath, preservedPath);
    } catch {
      // Opening the tournament must still succeed if the file cannot be moved aside.
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

    if (stateFilePath !== currentPath) {
      try {
        await fs.promises.rename(stateFilePath, currentPath);
      } catch {
        // The validated state is still usable; a later load can retry the migration.
      }
    }
    return { state: validated };
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

function arrayOfObjects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/**
 * Accept a parsed state file, or reject it.
 *
 * Its own file, but still untrusted: it may have been written by a different build, hand-edited, or
 * left behind by a version that stored something else. A shape check here is cheaper than a crash
 * during a round. Unknown fields on a record are preserved, since a newer build may have added one.
 */
function validateState(parsed: unknown, tournamentId: string): IQbtcpTournamentState | null {
  if (!isPlainObject(parsed)) return null;
  if (parsed.stateVersion !== qbtcpStateVersion) return null;
  // State bound to a different tournament must never be adopted by this one; the results inside it
  // belong to somebody else's games.
  if (parsed.tournamentId !== tournamentId) return null;

  const rooms = arrayOfObjects(parsed.rooms).flatMap((room) => {
    if (
      typeof room.id !== 'string' ||
      typeof room.name !== 'string' ||
      typeof room.pairingCode !== 'string' ||
      (room.enabled !== undefined && typeof room.enabled !== 'boolean')
    ) {
      return [];
    }
    return [{ ...room, enabled: room.enabled ?? true }];
  });
  const assignments = arrayOfObjects(parsed.assignments).filter(
    (a) =>
      typeof a.id === 'string' &&
      typeof a.roomId === 'string' &&
      typeof a.matchId === 'string' &&
      isPlainObject(a.document),
  );
  const sessions = arrayOfObjects(parsed.sessions).flatMap((session) => {
    if (
      typeof session.id !== 'string' ||
      typeof session.roomId !== 'string' ||
      typeof session.sessionToken !== 'string' ||
      (session.progressSequence !== undefined &&
        (typeof session.progressSequence !== 'number' || !Number.isFinite(session.progressSequence))) ||
      (session.finalReceived !== undefined && typeof session.finalReceived !== 'boolean') ||
      (session.writerDeviceId !== undefined &&
        session.writerDeviceId !== null &&
        typeof session.writerDeviceId !== 'string')
    ) {
      return [];
    }
    return [
      {
        ...session,
        progressSequence: session.progressSequence ?? 0,
        finalReceived: session.finalReceived ?? false,
        writerDeviceId: session.writerDeviceId ?? null,
      },
    ];
  });
  const validStatuses = new Set<ReceivedResultStatus>(['needs-review', 'accepted', 'duplicate', 'conflict']);
  const results = arrayOfObjects(parsed.results).flatMap((result) => {
    if (
      typeof result.id !== 'string' ||
      typeof result.fingerprint !== 'string' ||
      !isPlainObject(result.document) ||
      (result.status !== undefined &&
        (typeof result.status !== 'string' || !validStatuses.has(result.status as ReceivedResultStatus)))
    ) {
      return [];
    }
    return [{ ...result, status: (result.status as ReceivedResultStatus | undefined) ?? 'needs-review' }];
  });
  const presence = arrayOfObjects(parsed.presence).filter((p) => typeof p.roomId === 'string');

  return {
    stateVersion: qbtcpStateVersion,
    tournamentId,
    rooms,
    assignments,
    sessions,
    results,
    presence,
  } as unknown as IQbtcpTournamentState;
}
