/**
 * The QBTCP v1 wire vocabulary, shared by the Electron main process and the renderer.
 *
 * This file is the only place the protocol's spelling lives. It deliberately contains no logic and
 * no YellowFruit data model, so that both processes can agree on route names, header names and
 * capability names without either one importing the other's world.
 *
 * The authority for everything here is the QBTCP specification (`docs/QBTCP.md` in gbyo/qbsheet),
 * not this comment and not the older `/api/v1` surface that preceded it.
 */

/** The canonical protocol prefix. Version is a single integer in the path. */
export const qbtcpPrefix = '/qbtcp/v1';

/** The QBJ serialization version this server produces and accepts. */
export const qbjVersion = '2.1.1';

/** The media type a QBJ document travels as. Deliberately not `application/json`. */
export const qbjMediaType = 'application/vnd.quizbowl.qbj+json';

/**
 * Credential headers. A credential travels only in a header - never in a URL, a log, the UI, or QBJ.
 *
 * The `x-yf-` prefix is historical and is treated as an opaque string, per the specification.
 */
export const roomTokenHeader = 'x-yf-room-token';
export const sessionTokenHeader = 'x-yf-session-token';

/** Informational headers. These never authorise an operation. */
export const deviceIdHeader = 'x-yf-device-id';
export const operatorNameHeader = 'x-yf-operator-name';

/**
 * What this server actually supports.
 *
 * Discovery MUST advertise only capabilities that work, because a client is forbidden from inferring
 * support from the absence of an error. `roster` names QBSheet's current authenticated player-add
 * extension; player data remains QBJ, while this capability carries the live request to update the
 * tournament roster before the final QBJ comes back.
 */
export const advertisedCapabilities = [
  'pairing',
  'assignment',
  'progress',
  'result',
  'recovery',
  'help',
  'presence',
  'roster',
] as const;

/** The help categories the current QBSheet build can send and render. */
export const qbtcpHelpCategoryLabels = {
  'wrong-matchup': 'Wrong matchup',
  'team-missing': "Team hasn't arrived",
  protest: 'Protest / disputed ruling',
  'question-packet': 'Question / packet issue',
  'roster-change': 'Roster change',
  'equipment-technical': 'Equipment / technical issue',
  'rules-question': 'Rules question',
  'scoring-problem': 'Scoring problem',
  'device-network': 'Device/network problem',
  'wrong-room': 'Wrong room',
  other: 'Other',
} as const;

export type QbtcpHelpCategory = keyof typeof qbtcpHelpCategoryLabels;

export const qbtcpHelpCategories = Object.keys(qbtcpHelpCategoryLabels) as QbtcpHelpCategory[];

/** Assignment lifecycle state, as reported by `GET /qbtcp/v1/assignment/status`. */
export type QbtcpAssignmentState = 'assigned' | 'none' | 'blocked' | 'held';

/** Default port. Chosen high and unregistered to avoid colliding with dev servers. */
export const defaultQbtcpPort = 40787;

/** Valid explicit TCP listening ports. Port zero is reserved for OS-assigned ephemeral ports. */
export const minQbtcpPort = 1;
export const maxQbtcpPort = 65535;

export function isValidQbtcpPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= minQbtcpPort && value <= maxQbtcpPort;
}

/**
 * Origins allowed to make an authenticated cross-origin request.
 *
 * An exact allowlist, never a wildcard: a wildcard on a capability-token API would let any page on
 * the internet drive a tournament from a scorekeeper's browser. The dev origins are included only
 * in development builds because they are for QBSheet's local Vite server.
 */
const productionAllowedOrigins = ['https://qbsheet.com', 'https://www.qbsheet.com', 'https://gbyo.github.io'];

export const defaultAllowedOrigins = [
  ...productionAllowedOrigins,
  ...(process.env.NODE_ENV === 'development' ? ['http://localhost:5173', 'http://127.0.0.1:5173'] : []),
];

/** Hard limits on untrusted input. A body or URL beyond these is refused rather than parsed. */
export const maxRequestBodyBytes = 4 * 1024 * 1024;
export const maxUrlLength = 2048;

/** Pairing attempt budget per client source, before `429`. */
export const pairingRateLimit = { maxAttempts: 10, windowMs: 60_000 };

/**
 * How long a heartbeat means a room is still there.
 *
 * Shared, because a room that the server considers present and the Rooms page considers stale would
 * be two different answers to one question. Nothing expires a session when it lapses - presence is
 * advisory - but the moment it lapses is the moment the page has to stop claiming a connection.
 */
export const presenceFreshMs = 45_000;
