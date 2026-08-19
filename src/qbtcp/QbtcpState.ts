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

/** The work of one scoresheet on one assigned game. */
export interface ISession {
  id: string;
  roomId: string;
  matchId: string;
  /** Every capability issued for this session. Secret. */
  grants: ISessionGrant[];
  /** Capability that currently owns writer authority. Secret; null means the next grant claims it. */
  writerGrantToken: string | null;
  /** Informational label for the current writer. Writer authority comes from writerGrantToken. */
  writerDeviceId: string | null;
  /** Highest progress sequence accepted. A lower one is discarded silently. */
  progressSequence: number;
  /** Latest progress snapshot, as the QBJ `Match` the client sent. Best effort. */
  progressMatch?: object;
  /** Set once a final has been durably persisted for this session. */
  finalReceived: boolean;
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
  | 'conflict';

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
  /** Set when this result conflicts with an earlier one; names the result it disagrees with. */
  conflictsWithResultId?: string;
  /** Round the result claims, for display before it is imported. */
  roundNumber?: number;
}

/** Whether a room device has been heard from lately. Advisory only. */
export interface IPresence {
  roomId: string;
  deviceId?: string;
  operatorName?: string;
  lastSeenAt: string;
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
}

export type QbtcpRosterPlayerOutcome = { ok: true } | { ok: false; error: string; status?: 409 | 503 };

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

export const qbtcpStateVersion = 1;

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
  assignment?: {
    id: string;
    roundNumber: number;
    leftTeamName: string;
    rightTeamName: string;
    matchId: string;
    revision: number;
  };
  session?: {
    id: string;
    /** Whether any progress snapshot has arrived. */
    scoring: boolean;
    tossupsRead?: number;
    finalReceived: boolean;
  };
  result?: {
    id: string;
    status: ReceivedResultStatus;
    fingerprint: string;
    receivedAt: string;
  };
  /** Open requests only. Closed history stays in the main process. */
  helpRequests?: IQbtcpHelpRequest[];
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
}
