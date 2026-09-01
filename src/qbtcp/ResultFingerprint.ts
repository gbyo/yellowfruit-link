/**
 * The statistical fingerprint of a result, and the rules for telling a retry from a disagreement.
 *
 * # Why a fingerprint at all
 *
 * The same game can reach this application twice: once automatically over QBTCP, and once as a
 * `result.qbj` that a scorekeeper downloaded and handed to the control table. Two arrivals must not
 * become two matches, and a genuinely different result for the same game must not be silently
 * overwritten. Identity alone cannot tell those apart - both carry the same `Tournament.id` and
 * `Match.id` - so the statistics themselves are hashed.
 *
 * # What is deliberately excluded
 *
 * Transport and source metadata are ignored, because the same game scored once must produce one
 * fingerprint whichever route the document took. A fingerprint that moved when the transport
 * metadata moved would report every manual backup as a conflict, which is the exact failure this is
 * here to prevent. Object key order is likewise irrelevant.
 *
 * The algorithm (FNV-1a over canonical JSON) matches the one QBSheet uses for the same purpose, so
 * the two sides compute the same value for the same match. It is an equality aid, not an
 * authenticity claim - the server still authenticates the room and the director still reviews.
 */

/** Extension blocks that describe how a result travelled rather than what happened in the game. */
const ignoredForFingerprint = new Set(['_qbtcp', '_qbsheet_source', '_scoresheet_source', '_yf_scorekeeper_recovery']);

/**
 * Keys stripped from a document before it is hashed or stored.
 *
 * In practice a QBSheet result contains none of these. The stripping exists because "in practice
 * none" is a property of today's producer rather than of the format, and the cost of being wrong is
 * a room token sitting in a file that gets emailed around.
 */
const credentialKeys = new Set([
  'accesstoken',
  'token',
  'sessiontoken',
  'sessionid',
  'sessioncredentials',
  'roomtoken',
  'pairingcode',
  'deviceid',
  'authorization',
  'credentials',
  'secret',
]);

function isCredentialKey(key: string): boolean {
  return credentialKeys.has(key.replace(/[-_\s]/g, '').toLowerCase());
}

/** A deep copy with anything credential-shaped removed. */
export function stripCredentialKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripCredentialKeys(entry));
  if (typeof value !== 'object' || value === null) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialKey(key)) continue;
    output[key] = stripCredentialKeys(entry);
  }
  return output;
}

/**
 * Compare strings lexicographically by Unicode code point, not by locale or UTF-16 code unit.
 *
 * This is the ordering shared with QBSheet's canonical JSON implementation, so the same document
 * hashes the same on every machine regardless of its locale or runtime defaults.
 */
export function compareCodePointOrder(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightCodePoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const commonLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (leftCodePoints[index] !== rightCodePoints[index]) {
      return leftCodePoints[index] < rightCodePoints[index] ? -1 : 1;
    }
  }
  if (leftCodePoints.length !== rightCodePoints.length) {
    return leftCodePoints.length < rightCodePoints.length ? -1 : 1;
  }
  return 0;
}

/** Canonical JSON, with object-key order made irrelevant and transport metadata dropped. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !ignoredForFingerprint.has(key))
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => compareCodePointOrder(left, right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

/**
 * FNV-1a, 64-bit, as a zero-padded hex string.
 *
 * The same hash QBSheet computes for the same match, so the two sides agree on what "the same result"
 * means. BigInt keeps it exact and deterministic without pulling in a crypto dependency for what is an
 * equality aid rather than a security primitive.
 */
export function resultFingerprint(value: unknown): string {
  const canonical = canonicalJson(stripCredentialKeys(value));
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < canonical.length; index += 1) {
    // eslint-disable-next-line no-bitwise -- XOR is the algorithm; there is no non-bitwise FNV-1a.
    hash ^= BigInt(canonical.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Identity metadata QBSheet keeps on a bare Match instead of copying into standard QBJ fields. */
export interface IResultSourceMetadata {
  scheduledMatchId?: unknown;
  tournamentId?: unknown;
  roundRevision?: unknown;
  assignmentRevision?: unknown;
}

/**
 * Read source metadata with QBSheet taking precedence over the older scoresheet spelling.
 *
 * The values remain unknown here on purpose. Identity extraction only accepts valid strings and
 * integers, while assignment validation must still be able to reject a malformed revision instead
 * of treating it as if the field had not been sent.
 */
export function readResultSourceMetadata(match: Record<string, unknown>): IResultSourceMetadata {
  const metadata: IResultSourceMetadata = {};
  for (const sourceKey of ['_qbsheet_source', '_scoresheet_source']) {
    const source = match[sourceKey];
    if (!isPlainObject(source)) continue;

    if (metadata.scheduledMatchId === undefined) {
      metadata.scheduledMatchId = source.scheduledMatchId ?? source.scheduled_match_id;
    }
    if (metadata.tournamentId === undefined) {
      metadata.tournamentId = source.tournamentId ?? source.tournament_id;
    }
    if (metadata.roundRevision === undefined) {
      metadata.roundRevision = source.roundRevision ?? source.round_revision;
    }
    if (metadata.assignmentRevision === undefined) {
      metadata.assignmentRevision = source.assignmentRevision ?? source.assignment_revision;
    }
  }
  return metadata;
}

/**
 * The QBJ `Match` inside a result document, whatever envelope it arrived in.
 *
 * QBSheet can send an official serialized document (`{version, objects}`) or, for compatibility, a
 * bare `Match`. The fingerprint is taken over the `Match` alone in both cases, so that the envelope
 * cannot make the same game hash differently.
 */
export function findResultMatch(document: unknown): Record<string, unknown> | null {
  return findResultMatchList(document)[0] ?? null;
}

/**
 * Every QBJ `Match` in a result document, in document order.
 *
 * A file can hold a whole day of games. Reading only the first one is right for a QBTCP session,
 * which carries exactly one game, and wrong for the manual import path, where one answer applied to
 * ten games says nine wrong things.
 */
export function findResultMatchList(document: unknown): Record<string, unknown>[] {
  if (!isPlainObject(document)) return [];
  if (Array.isArray(document.objects)) {
    const objects = document.objects.filter(isPlainObject);
    // Top-level matches first, so the first entry is the one a single-game document means. Match IDs
    // are QBJ's stable identity, so duplicate serializations of the same game are only returned once.
    const matches: Record<string, unknown>[] = [];
    const seenMatchIds = new Set<string>();
    const addMatch = (match: Record<string, unknown>) => {
      const matchId = typeof match.id === 'string' && match.id !== '' ? match.id : undefined;
      if (matchId && seenMatchIds.has(matchId)) return;
      if (matchId) seenMatchIds.add(matchId);
      matches.push(match);
    };
    for (const match of objects.filter((entry) => entry.type === 'Match')) addMatch(match);
    // A schedule may also write its games inline inside the rounds that hold them rather than as
    // top-level objects. Those are the same games, and a file whose games are spelled that way is
    // still a file whose games must not be imported twice.
    for (const entry of objects) {
      const rounds = entry.type === 'Round' ? [entry] : arrayOf(entry.phases).flatMap((phase) => arrayOf(phase.rounds));
      for (const round of rounds) {
        for (const match of arrayOf(round.matches)) {
          if (typeof match.$ref === 'string') continue;
          addMatch(match);
        }
      }
    }
    return matches;
  }
  // A bare Match has no envelope. `match_teams` is the field that makes it recognisable as one.
  if (Array.isArray(document.match_teams) || Array.isArray(document.matchTeams)) return [document];
  return [];
}

function arrayOf(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isPlainObject) : [];
}

/** The identity a result claims: the tournament that scopes it, and the scheduled game. */
export interface IResultIdentity {
  tournamentId?: string;
  matchId?: string;
  fingerprint: string;
  roundNumber?: number;
  roundRevision?: number;
  assignmentRevision?: number;
}

function positiveIntegerFrom(value: unknown): number | undefined {
  const text = String(value ?? '').trim();
  // The whole name has to be an integer. `parseInt` would read "3A" as 3, and a result filed
  // against the wrong round is worse than one that falls back to matching on teams.
  if (!/^\d+$/.test(text)) return undefined;
  const parsed = Number.parseInt(text, 10);
  return parsed > 0 ? parsed : undefined;
}

/** The round a serialized document's match belongs to, read from the Round that references it. */
function roundNumberForMatch(document: Record<string, unknown>, matchId: string): number | undefined {
  const objects = Array.isArray(document.objects) ? document.objects.filter(isPlainObject) : [];
  const rounds: Record<string, unknown>[] = [];
  for (const entry of objects) {
    if (entry.type === 'Round') rounds.push(entry);
    for (const phase of Array.isArray(entry.phases) ? entry.phases : []) {
      if (!isPlainObject(phase)) continue;
      for (const round of Array.isArray(phase.rounds) ? phase.rounds : []) {
        if (isPlainObject(round)) rounds.push(round);
      }
    }
  }
  for (const round of rounds) {
    const matches = Array.isArray(round.matches) ? round.matches : [];
    const refersToMatch = matches.some(
      (entry) => isPlainObject(entry) && (entry.$ref === matchId || entry.id === matchId),
    );
    if (!refersToMatch) continue;
    const number = positiveIntegerFrom(round.name);
    if (number !== undefined) return number;
  }
  return undefined;
}

/**
 * Read the identity and fingerprint out of a result document.
 *
 * Called on the raw parsed JSON, before any case conversion runs, so it does not depend on the
 * conversion table continuing to leave `_qbtcp` alone.
 */
export function readResultIdentity(document: unknown): IResultIdentity | null {
  const match = findResultMatch(document);
  return match ? identityForMatch(document, match) : null;
}

/** The identity carried by a `Match`, together with the `Match` it was read from. */
export interface IResultMatchIdentity extends IResultIdentity {
  match: Record<string, unknown>;
}

/**
 * The identity of every `Match` in a result document, in document order.
 *
 * Each identity is read against the whole envelope, so a match still learns its tournament and its
 * round from the objects that reference it rather than only from what it carries itself.
 */
export function readResultIdentities(document: unknown): IResultMatchIdentity[] {
  return findResultMatchList(document).map((match) => ({ ...identityForMatch(document, match), match }));
}

function identityForMatch(document: unknown, match: Record<string, unknown>): IResultIdentity {
  const fingerprint = resultFingerprint(match);
  const identity: IResultIdentity = { fingerprint };
  const source = readResultSourceMetadata(match);

  if (typeof match.id === 'string' && match.id !== '') identity.matchId = match.id;
  if (!identity.matchId && typeof source.scheduledMatchId === 'string' && source.scheduledMatchId !== '') {
    identity.matchId = source.scheduledMatchId;
  }

  if (isPlainObject(document) && Array.isArray(document.objects)) {
    const tournament = document.objects.filter(isPlainObject).find((entry) => entry.type === 'Tournament');
    if (typeof tournament?.id === 'string' && tournament.id !== '') identity.tournamentId = tournament.id;
    if (identity.matchId) identity.roundNumber = roundNumberForMatch(document, identity.matchId);
  }
  if (!identity.tournamentId && typeof source.tournamentId === 'string' && source.tournamentId !== '') {
    identity.tournamentId = source.tournamentId;
  }
  const extension = isPlainObject(match._qbtcp) ? match._qbtcp : undefined;
  const declaredRoundRevision = extension?.round_revision ?? extension?.roundRevision;
  const declaredAssignmentRevision = extension?.assignment_revision ?? extension?.assignmentRevision;
  if (
    identity.roundRevision === undefined &&
    typeof declaredRoundRevision === 'number' &&
    Number.isInteger(declaredRoundRevision)
  ) {
    identity.roundRevision = declaredRoundRevision;
  }
  if (
    identity.assignmentRevision === undefined &&
    typeof declaredAssignmentRevision === 'number' &&
    Number.isInteger(declaredAssignmentRevision)
  ) {
    identity.assignmentRevision = declaredAssignmentRevision;
  }
  if (typeof source.roundRevision === 'number' && Number.isInteger(source.roundRevision)) {
    identity.roundRevision = source.roundRevision;
  }
  if (typeof source.assignmentRevision === 'number' && Number.isInteger(source.assignmentRevision)) {
    identity.assignmentRevision = source.assignmentRevision;
  }
  // A bare Match from MODAQ and older workflows carries its round in `_round`.
  if (identity.roundNumber === undefined) {
    identity.roundNumber = positiveIntegerFrom(match._round ?? (match as { round?: unknown }).round);
  }

  return identity;
}

/** What a newly arrived result is, relative to what is already on record. */
export type ResultComparison =
  | { kind: 'new' }
  | { kind: 'duplicate'; existingId: string }
  | { kind: 'conflict'; existingId: string };

interface IRecordedResult {
  id: string;
  matchId: string;
  fingerprint: string;
}

/**
 * Compare an arriving result against those already recorded for this tournament.
 *
 * The implemented matching order is stable `Match.id` first, followed by a fingerprint-only fallback
 * only when the arriving result has no usable id. A different id is a different game even when its
 * statistics happen to hash identically. A different fingerprint with the same match identity is a
 * conflict that a person must review.
 *
 * The tournament half of the identity is the caller's concern: this function is only ever given the
 * results recorded for one tournament, so identical `Match.id` values in different tournaments
 * cannot collide.
 */
export function compareToRecorded(
  arriving: { matchId?: string; fingerprint: string },
  recorded: IRecordedResult[],
): ResultComparison {
  const matchId = typeof arriving.matchId === 'string' && arriving.matchId.trim() !== '' ? arriving.matchId : undefined;
  if (matchId) {
    // A correction can leave more than one historical result for one Match ID. Find an exact retry
    // before selecting the older conflicting copy, otherwise retrying the correction would create a
    // third review item instead of acknowledging the durable correction evidence.
    const sameResult = recorded.find(
      (entry) => entry.matchId === matchId && entry.fingerprint === arriving.fingerprint,
    );
    if (sameResult) return { kind: 'duplicate', existingId: sameResult.id };
    const sameGame = recorded.find((entry) => entry.matchId === matchId);
    return sameGame ? { kind: 'conflict', existingId: sameGame.id } : { kind: 'new' };
  }

  // A document without a stable identity can only use its statistics as a conservative fallback.
  // The caller records a missing-id discrepancy so this ambiguous match is visible to a director.
  const sameStats = recorded.find((entry) => entry.fingerprint === arriving.fingerprint);
  if (sameStats) return { kind: 'duplicate', existingId: sameStats.id };
  return { kind: 'new' };
}
