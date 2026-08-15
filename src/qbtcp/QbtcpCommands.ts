/**
 * The command vocabulary between the Rooms page and the QBTCP server.
 *
 * One IPC channel carrying a discriminated union, rather than a channel per operation. That keeps the
 * preload allowlist and the channel enums from growing a dozen entries for one feature, and it means
 * every command's reply has the same shape: something happened, or something did not happen and there
 * is a reason a director can read.
 *
 * No credential crosses this boundary except the pairing code, which a director has to be able to
 * read aloud. Room and session tokens stay in the main process.
 */
import { IReceivedResult, IQbtcpServerStatus, ReceivedResultStatus } from './QbtcpState';
import { ResultComparison } from './ResultFingerprint';

export type QbtcpCommand =
  /** Point the adapter at a tournament, loading its saved room state. */
  | { kind: 'bind'; tournamentId: string; displayName: string }
  | { kind: 'status' }
  | { kind: 'start'; port: number }
  | { kind: 'stop' }
  | { kind: 'addRoom'; name: string }
  | { kind: 'renameRoom'; roomId: string; name: string }
  | { kind: 'removeRoom'; roomId: string }
  /** Save the scoresheet address for future pairing sheets. */
  | { kind: 'setScoresheetUrl'; url: string }
  /**
   * Publish an assignment.
   *
   * `document` is the built QBJ, produced by the renderer's shared builder. The server stores and
   * serves exactly these bytes, which is what makes the network body and the exported file identical.
   */
  | {
      kind: 'setAssignment';
      roomId: string;
      roundNumber: number;
      leftTeamId: string;
      rightTeamId: string;
      leftTeamName: string;
      rightTeamName: string;
      matchId: string;
      document: object;
      /**
       * The revision the document about to be served declares.
       *
       * The server refuses the command when its own next revision would differ. Two assignments
       * issued from one stale view of the page would otherwise both claim the same revision while
       * the stored record moved on twice, and a correctly scored result would be refused as stale.
       */
      roundRevision: number;
    }
  | { kind: 'clearAssignment'; roomId: string }
  /** Record what the director decided about a received result. */
  | { kind: 'resolveResult'; resultId: string; status: ReceivedResultStatus }
  /** Results still awaiting a decision, so a restart can re-offer them. */
  | { kind: 'unresolvedResults' }
  /**
   * Ask how each game in a document stands against what is already on record, without recording it.
   *
   * Read-only on purpose. The manual import path classifies a file while building its review list,
   * and the director may still cancel that import - recording at that moment would leave a result on
   * record that was never turned into a match.
   *
   * One answer per `Match`, in document order, because a file can hold a whole day of games.
   */
  | { kind: 'classifyResults'; document: object }
  /** Record a result that came in as a file, once the director has committed the import. */
  | { kind: 'recordFileResult'; document: object }
  /** Whether unresolved scored work would be destroyed by switching tournaments. */
  | { kind: 'hasActiveWork' }
  /**
   * Write a room's assignment QBJ to a file the director chooses.
   *
   * The bytes written are the ones already stored for this room - the same object the network hands
   * out. The renderer does not rebuild the document for export, so the file and the network body are
   * identical by construction rather than because two builders were kept in step.
   */
  | { kind: 'exportAssignment'; roomId: string; suggestedFileName: string }
  /** Print an already-rendered pairing-sheet document without writing it to disk. */
  | { kind: 'printPairingSheets'; html: string };

export type QbtcpCommandResult =
  | { ok: true; status: IQbtcpServerStatus }
  | { ok: true; results: IReceivedResult[] }
  | { ok: true; hasActiveWork: boolean }
  | { ok: true; comparisons: ResultComparison[] }
  | { ok: true; exported: boolean }
  | { ok: true }
  /** `error` is always safe to show a director, and never contains a credential. */
  | { ok: false; error: string };
