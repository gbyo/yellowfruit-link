/**
 * The operational state of the Rooms adapter.
 *
 * # This is not tournament data
 *
 * Nothing here belongs in a .yft file. A room, a pairing code and a session describe how a
 * tournament is being run right now; a Match describes what happened in a game. The former is
 * disposable and the latter is the tournament's actual record, so they are persisted separately and
 * a total loss of everything in this file must leave the tournament intact.
 *
 * # Credentials live here and nowhere else
 *
 * `pairingCode`, `roomToken` and every session grant's token are secrets. They are written to the
 * QBTCP state file in the app-data directory, and they must never reach a QBJ document, a log line,
 * or the renderer's view of a room. `IRoomView` below is the redacted shape the renderer is given.
 */
import { QbtcpHelpCategory } from './QbtcpProtocol';
import type { IResultDiscrepancy, IResultReceiptContext, ResultDiscrepancyResolution } from './ResultDiscrepancy';

export type { IResultDiscrepancy, IResultReceiptContext, ResultDiscrepancyResolution } from './ResultDiscrepancy';

/** A scoring position in the tournament. The unit that pairs and authenticates. */
export interface IRoom {
  id: string;
  name: string;
  /** The short code a person types into QBSheet. Secret. */
  pairingCode: string;
  /** Capability token issued at pairing, scoped to this one room. Secret; absent until paired. */
  roomToken?: string;
  enabled: boolean;
}

/**
 * A game a room has been told to score.
 *
 * `document` is the built QBJ assignment, stored verbatim. It is stored rather than rebuilt on
 * demand for two reasons: the HTTP server must be able to answer without waiting on the renderer,
 * and the bytes a room received must not change underneath a game in progress because somebody
 * renamed a team.
 */
export interface IRoomAssignment {
  id: string;
  roomId: string;
  roundNumber: number;
  leftTeamId: string;
  rightTeamId: string;
  /**
   * Stable identity for the game being scored. Becomes `Match.id`, and comes back on the result.
   *
   * For an ordinary assignment this is the tournament's ScheduledGame id, so the result names the
   * pairing it was scored against rather than a game invented when the room was assigned. A manual
   * assignment - a tiebreaker, an odd final, a pool of arbitrary matchups - has no pairing to name, so
   * the renderer mints an opaque id for it instead. Either way this server treats it as an opaque
   * string and only ever compares it for equality.
   */
  matchId: string;
  /** Which issue of this round's pairings. Increases when an assignment is changed. */
  revision: number;
  /** Which issue of the round pairing this assignment was built from. Older state omitted it. */
  roundRevision?: number;
  /** The exact QBJ assignment document served for this game. */
  document: object;
  /** Display labels, so the Rooms page needs no lookup into the tournament. */
  leftTeamName: string;
  rightTeamName: string;
}

/**
 * A capability issued for one session.
 *
 * The token is the non-forgeable identity. `deviceId` is useful attribution attached to that token,
 * but a caller supplying the same text on a later open is not proof that it owns an existing grant.
 */
export interface ISessionGrant {
  /** Informational device identity associated with this capability, if the client supplied one. */
  deviceId: string | null;
  /** Capability token scoped to this session. Secret. */
  token: string;
}

export type QbtcpSessionStatus = 'open' | 'final-received' | 'abandoned';

/** The work of one scoresheet on one assigned game. */
export interface ISession {
  id: string;
  roomId: string;
  matchId: string;
  /** Every capability issued for this session. Secret. */
  grants: ISessionGrant[];
  /** Capability that currently owns writer authority. Secret; null means the next grant claims it. */
  writerGrantToken: string | null;
  /** Former writer capability allowed to submit one late final for an abandoned session only. Secret. */
  lateResultGrantToken?: string;
  /** Informational label for the current writer. Writer authority comes from writerGrantToken. */
  writerDeviceId: string | null;
  /** Highest progress sequence accepted. A lower one is discarded silently. */
  progressSequence: number;
  /** Latest progress snapshot, as the QBJ `Match` the client sent. Best effort. */
  progressMatch?: object;
  /** Persisted lifecycle; `finalReceived` remains as a wire/state compatibility field. */
  status: QbtcpSessionStatus;
  /** Set once a final has been durably persisted for this session. Kept for old clients. */
  finalReceived: boolean;
  /** Immutable assignment facts used for recovery and late-result reconciliation. */
  assignmentContext?: IResultReceiptContext;
  /** The assignment document snapshot used for comparing late result content, without credentials. */
  assignmentDocument?: object;
  /** Append-only canonical roster changes made during this session. */
  rosterAmendments?: IQbtcpRosterAmendment[];
  abandonedAt?: string;
  abandonReason?: string;
  createdAt: string;
  updatedAt: string;
}

/** How a received final currently stands with the director. */
export type ReceivedResultStatus =
  /** Persisted and acknowledged; waiting for the director to review it. */
  | 'needs-review'
  /** Turned into an ordinary YellowFruit Match. */
  | 'accepted'
  /** The same statistical result was already on record. No second match was created. */
  | 'duplicate'
  /** Same tournament and match identity, different statistics. A person must resolve it. */
  | 'conflict'
  /** Kept as audit evidence after a director chose another result. */
  | 'dismissed'
  /** Kept as audit evidence after a later result replaced it. */
  | 'superseded';

/** Deliberate director decisions for a received result that needs reconciliation. */
export type ResultReviewDecision = 'accept' | 'keep-existing' | 'dismiss' | 'supersede';

/** Persisted decision metadata; the received QBJ remains immutable evidence beside it. */
export interface IResultReview {
  decision: ResultReviewDecision;
  resolvedAt: string;
  reason?: string;
  /** The result selected as the existing/old side of a review decision. */
  targetResultId?: string;
}

/** Input for the explicit director-side result review primitive. */
export interface IResultReviewRequest {
  decision: ResultReviewDecision;
  existingResultId?: string;
  reason?: string;
  /** Set by the shared importer after it has committed the incoming QBJ as a Match. */
  imported?: boolean;
}

/**
 * A final that reached this server.
 *
 * `document` is the exact QBJ that arrived, kept byte-for-byte. It is the evidence: if import or
 * review goes wrong, this is what the director falls back to, and it is what a manual
 * `result.qbj` is compared against.
 */
export interface IReceivedResult {
  id: string;
  roomId: string;
  sessionId: string;
  matchId: string;
  /** Statistical fingerprint of the QBJ `Match`, ignoring transport metadata and key order. */
  fingerprint: string;
  status: ReceivedResultStatus;
  document: object;
  receivedAt: string;
  /** Match ID that arrived in the result, when the result claimed one. */
  claimedMatchId?: string;
  /** Match ID YellowFruit expected for the authenticated session. */
  expectedMatchId?: string;
  /** Immutable context captured when the session was opened. */
  context?: IResultReceiptContext;
  /** Typed, safe discrepancies found before import/review. */
  warnings?: IResultDiscrepancy[];
  /** True when the retained document did not contain a usable Match. */
  unreadable?: boolean;
  /** Set when this result conflicts with an earlier one; names the result it disagrees with. */
  conflictsWithResultId?: string;
  /** Explicit persisted director decision, including keep/dismiss/supersede choices. */
  review?: IResultReview;
  /** The earlier result this correction replaces, without deleting that evidence. */
  supersedesResultId?: string;
  /** The later result that replaced this one, without deleting this evidence. */
  supersededByResultId?: string;
  /** The result retained when this incoming result was dismissed as a correction. */
  keepsResultId?: string;
  /** Timestamp for a dismissed incoming result, separate from its receipt timestamp. */
  dismissedAt?: string;
  /** Compatibility resolution metadata retained for existing consumers. */
  resolution?: ResultDiscrepancyResolution;
  /** The corresponding tournament Match was committed by the importer. */
  importedMatchId?: string;
  /** Round the result claims, for display before it is imported. */
  roundNumber?: number;
  /** Assignment revision claimed by the result, when present. */
  claimedAssignmentRevision?: number;
  /** Round revision claimed by the result, when present. */
  claimedRoundRevision?: number;
}

/** Whether a room device has been heard from lately. Advisory only. */
export interface IPresence {
  roomId: string;
  deviceId?: string;
  operatorName?: string;
  lastSeenAt: string;
  /** Bounded, advisory client diagnostics; never used for authentication. */
  client?: {
    name?: string;
    version?: string;
    build?: string;
    commit?: string;
  };
  procedureVersions?: number[];
  qbjVersion?: string;
}

export type HelpRequestStatus = 'open' | 'cancelled' | 'resolved';

/** One scorekeeper's request for tournament control to come to the room. */
export interface IQbtcpHelpRequest {
  id: string;
  roomId: string;
  roomName: string;
  category: QbtcpHelpCategory;
  message: string;
  status: HelpRequestStatus;
  createdAt: string;
  updatedAt: string;
  deviceId?: string;
  operatorName?: string;
  currentMatchup?: {
    roundNumber: number;
    roundName: string;
    leftTeam: string;
    rightTeam: string;
  };
}

/** Validated request passed from the HTTP server to the tournament-owning renderer. */
export interface IQbtcpRosterPlayerRequest {
  requestId: string;
  roomId: string;
  sessionId: string;
  teamId: string;
  teamName: string;
  playerName: string;
  questionNumber?: number;
}

export interface IQbtcpRosterAmendment {
  teamId: string;
  teamName: string;
  playerId?: string;
  playerName: string;
  created?: boolean;
  questionNumber?: number;
  recordedAt?: string;
  /** Safe, bounded note when control had to reconcile the requested and canonical team identity. */
  warning?: string;
}

export type QbtcpRosterPlayerOutcome =
  | {
      ok: true;
      playerId?: string;
      playerName?: string;
      teamId?: string;
      teamName?: string;
      created?: boolean;
      warning?: string;
    }
  | { ok: false; error: string; status?: 409 | 503 };

/** The whole persisted operational state for one tournament. */
export interface IQbtcpTournamentState {
  /** Schema version of this file, so a later build can migrate or refuse it. */
  stateVersion: number;
  /** The tournament this state belongs to. Guards against binding state to the wrong file. */
  tournamentId: string;
  /** Optional self-hosted scoresheet address. Older state files intentionally omit it. */
  scoresheetUrl?: string;
  rooms: IRoom[];
  assignments: IRoomAssignment[];
  sessions: ISession[];
  results: IReceivedResult[];
  presence: IPresence[];
  helpRequests: IQbtcpHelpRequest[];
}

export const qbtcpStateVersion = 3;

export function emptyQbtcpState(tournamentId: string): IQbtcpTournamentState {
  return {
    stateVersion: qbtcpStateVersion,
    tournamentId,
    rooms: [],
    assignments: [],
    sessions: [],
    results: [],
    presence: [],
    helpRequests: [],
  };
}

// --- what the renderer is allowed to see -------------------------------------------------------

/**
 * A room as shown on the Rooms page.
 *
 * The pairing code is present because a director has to read it aloud to a scorekeeper; that is the
 * whole point of a pairing code. The room and session tokens are not, because nothing in the UI can
 * do anything with them and a token on screen is a token in a screenshot.
 */
export interface IRoomView {
  id: string;
  name: string;
  pairingCode: string;
  enabled: boolean;
  paired: boolean;
  connected: boolean;
  lastSeenAt?: string;
  operatorName?: string;
  /** Safe advisory client metadata from the latest heartbeat; never an authentication input. */
  client?: IPresence['client'];
  procedureVersions?: number[];
  qbjVersion?: string;
  assignment?: {
    id: string;
    roundNumber: number;
    leftTeamName: string;
    rightTeamName: string;
    matchId: string;
    revision: number;
    roundRevision?: number;
  };
  session?: {
    id: string;
    /** Whether any progress snapshot has arrived. */
    scoring: boolean;
    status?: QbtcpSessionStatus;
    tossupsRead?: number;
    finalReceived: boolean;
  };
  result?: {
    id: string;
    matchId: string;
    status: ReceivedResultStatus;
    fingerprint: string;
    receivedAt: string;
    warningCount?: number;
    warningCodes?: string[];
  };
  /** Open requests only. Closed history stays in the main process. */
  helpRequests?: IQbtcpHelpRequest[];
}

/** Redacted global review-queue entry, including results whose room has already moved on. */
export interface IRoomReviewQueueItem {
  id: string;
  roomId: string;
  roomName: string;
  matchId: string;
  roundNumber?: number;
  status: Extract<ReceivedResultStatus, 'needs-review' | 'conflict'>;
  receivedAt: string;
  warningCount?: number;
}

/** Server status as shown on the Rooms page. */
export interface IQbtcpServerStatus {
  running: boolean;
  port?: number;
  /** The persisted scoresheet address, or the public default when it has not been chosen yet. */
  scoresheetUrl: string;
  /** Usable LAN addresses a scorekeeper can type in. */
  addresses: string[];
  /** Present when the last start attempt failed. Safe to display. */
  error?: string;
  /** Whether any session is unfinished or any result still needs review, which blocks a tournament switch. */
  hasActiveWork: boolean;
  rooms: IRoomView[];
  /** Results still needing a director decision, independent of the room's current assignment. */
  reviewQueue?: IRoomReviewQueueItem[];
}
