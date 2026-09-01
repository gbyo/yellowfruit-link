/**
 * Stable, persisted facts about a result that do not agree with the assignment context.
 *
 * These are deliberately not transport errors. A scorekeeper can finish a game with a stale
 * assignment, a renamed team, or a locally corrected rule, and the control table still needs the
 * document that arrived. The server uses this model both when receiving a QBTCP result and when a
 * caller previews a result for review.
 */
import { findResultMatch, readResultIdentity, readResultSourceMetadata, resultFingerprint } from './ResultFingerprint';

export const resultDiscrepancyCodes = [
  'tournament-id-mismatch',
  'match-id-mismatch',
  'match-id-missing',
  'round-mismatch',
  'stale-assignment',
  'unexpected-assignment-revision',
  'room-mismatch',
  'team-id-mismatch',
  'team-name-mismatch',
  'team-order-different',
  'unknown-team',
  'player-id-mismatch',
  'player-name-mismatch',
  'unknown-player',
  'roster-different',
  'scoring-rules-different',
  'procedure-different',
  'packet-different',
  'same-match-different-result',
  'source-tournament-different',
  'late-after-abandon',
  'unreadable-result',
  'invalid-assignment-metadata',
] as const;

export type ResultDiscrepancyCode = (typeof resultDiscrepancyCodes)[number];

export type ResultDiscrepancyResolution = 'unresolved' | 'accepted' | 'dismissed';

/** Safe values suitable for persistence and display. Arbitrary input objects are never retained. */
export type ResultDiscrepancyValue = string | number | boolean | null | readonly ResultDiscrepancyValue[];

export interface IResultDiscrepancy {
  code: ResultDiscrepancyCode;
  message: string;
  expected?: ResultDiscrepancyValue;
  received?: ResultDiscrepancyValue;
  resolution?: ResultDiscrepancyResolution;
}

/** Immutable assignment facts copied into a session and into every received result. */
export interface IResultReceiptContext {
  tournamentId: string;
  roomId: string;
  roomName: string;
  sessionId: string;
  assignmentId?: string;
  expectedMatchId: string;
  expectedRoundNumber?: number;
  expectedAssignmentRevision?: number;
  /** Compatibility name for the revision carried in the current QBTCP assignment extension. */
  expectedRoundRevision?: number;
  expectedLeftTeamId?: string;
  expectedRightTeamId?: string;
  expectedLeftTeamName?: string;
  expectedRightTeamName?: string;
}

const discrepancyMessages: Record<ResultDiscrepancyCode, string> = {
  'tournament-id-mismatch': 'That result names a different tournament.',
  'match-id-mismatch': 'That result names a different game than this session expected.',
  'match-id-missing': 'That result does not contain a Match ID for this scoring session.',
  'round-mismatch': 'That result names a different round than this session expected.',
  'stale-assignment': 'A newer assignment has superseded this game.',
  'unexpected-assignment-revision': 'That result does not match this room’s current assignment.',
  'room-mismatch': 'That result names a different room than this assignment.',
  'team-id-mismatch': 'That result does not contain the two teams assigned to this scoring session.',
  'team-name-mismatch': 'The result’s team name differs from the assignment.',
  'team-order-different': 'The result has the assigned teams in a different order.',
  'unknown-team': 'The result contains a team that is not in the assignment.',
  'player-id-mismatch': 'The result’s player identity differs from the assignment roster.',
  'player-name-mismatch': 'The result’s player name differs from the assignment roster.',
  'unknown-player': 'The result contains a player that is not in the assignment roster.',
  'roster-different': 'The result roster differs from the assignment roster.',
  'scoring-rules-different': 'The result uses scoring rules different from the assignment.',
  'procedure-different': 'The result uses room procedure different from the assignment.',
  'packet-different': 'The result names a different packet than the assignment.',
  'same-match-different-result': 'A different result is already recorded for this Match ID.',
  'source-tournament-different': 'The result source identifies a different tournament.',
  'late-after-abandon': 'This result arrived after the scoring session was abandoned.',
  'unreadable-result': 'The received document could not be interpreted as a usable Match.',
  'invalid-assignment-metadata': 'That result contains invalid QBTCP assignment metadata.',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeValue(value: unknown, depth = 0): ResultDiscrepancyValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return value.slice(0, 512);
  if (Array.isArray(value) && depth < 2) {
    return value.slice(0, 8).map((entry) => safeValue(entry, depth + 1) ?? null);
  }
  return undefined;
}

function addDiscrepancy(
  warnings: IResultDiscrepancy[],
  code: ResultDiscrepancyCode,
  expected?: unknown,
  received?: unknown,
): void {
  if (warnings.some((warning) => warning.code === code)) return;
  const safeExpected = safeValue(expected);
  const safeReceived = safeValue(received);
  warnings.push({
    code,
    message: discrepancyMessages[code],
    ...(safeExpected === undefined ? {} : { expected: safeExpected }),
    ...(safeReceived === undefined ? {} : { received: safeReceived }),
  });
}

function teamIdFromMatchTeam(value: unknown): string | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.team)) return undefined;
  if (typeof value.team.$ref === 'string') return value.team.$ref;
  return typeof value.team.id === 'string' ? value.team.id : undefined;
}

function teamNameFromMatchTeam(value: unknown): string | undefined {
  if (!isPlainObject(value) || !isPlainObject(value.team)) return undefined;
  return typeof value.team.name === 'string' ? value.team.name : undefined;
}

function teamValues(match: Record<string, unknown>): {
  ids: (string | undefined)[];
  names: (string | undefined)[];
  present: boolean;
} {
  const rawTeams = match.match_teams ?? match.matchTeams;
  if (!Array.isArray(rawTeams)) return { ids: [], names: [], present: false };
  return {
    ids: rawTeams.map(teamIdFromMatchTeam),
    names: rawTeams.map(teamNameFromMatchTeam),
    present: true,
  };
}

function declaredRevisions(match: Record<string, unknown>): { round?: unknown; assignment?: unknown } {
  const extension = isPlainObject(match._qbtcp) ? match._qbtcp : undefined;
  const source = readResultSourceMetadata(match);
  let round: unknown;
  if (extension?.round_revision !== undefined || extension?.roundRevision !== undefined) {
    round = extension.round_revision ?? extension.roundRevision;
  } else if (source.roundRevision !== undefined) {
    round = source.roundRevision;
  }
  let assignment: unknown;
  if (extension?.assignment_revision !== undefined || extension?.assignmentRevision !== undefined) {
    assignment = extension.assignment_revision ?? extension.assignmentRevision;
  } else if (source.assignmentRevision !== undefined) {
    assignment = source.assignmentRevision;
  }
  return {
    ...(round !== undefined ? { round } : {}),
    ...(assignment !== undefined ? { assignment } : {}),
  };
}

function valueFromAliases(record: Record<string, unknown> | undefined, aliases: string[]): unknown {
  if (!record) return undefined;
  for (const alias of aliases) {
    if (record[alias] !== undefined) return record[alias];
  }
  return undefined;
}

function objectOfType(objects: Record<string, unknown>[], typeNames: string[]): Record<string, unknown> | undefined {
  return objects.find((entry) => typeof entry.type === 'string' && typeNames.includes(entry.type));
}

function objectsIn(document: unknown): Record<string, unknown>[] {
  if (!isPlainObject(document) || !Array.isArray(document.objects)) return [];
  return document.objects.filter(isPlainObject);
}

function metadataValue(document: unknown, category: 'scoringRules' | 'procedure' | 'packet'): unknown {
  const objects = objectsIn(document);
  const match = findResultMatch(document);
  const extension = match && isPlainObject(match._qbtcp) ? match._qbtcp : undefined;

  if (category === 'procedure') {
    return valueFromAliases(extension, ['procedure', 'room_procedure', 'roomProcedure']);
  }
  if (category === 'packet') {
    const round = objectOfType(objects, ['Round']);
    return (
      valueFromAliases(round, ['packets', 'packet']) ?? valueFromAliases(match ?? undefined, ['packets', 'packet'])
    );
  }

  const scoringRules = objectOfType(objects, ['ScoringRules', 'ScoringRule']);
  if (scoringRules) return scoringRules;
  const tournament = objectOfType(objects, ['Tournament']);
  const reference = valueFromAliases(tournament, ['scoring_rules', 'scoringRules']);
  if (isPlainObject(reference) && typeof reference.$ref === 'string') {
    return objects.find((entry) => entry.id === reference.$ref) ?? reference;
  }
  return reference;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => {
      if (left === right) return 0;
      return left < right ? -1 : 1;
    })
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
    .join(',')}}`;
}

function metadataFingerprint(value: unknown): string | undefined {
  return value === undefined ? undefined : resultFingerprint(value);
}

function compareTeams(
  match: Record<string, unknown>,
  expected: IResultReceiptContext,
  warnings: IResultDiscrepancy[],
): void {
  const received = teamValues(match);
  const expectedIds = [expected.expectedLeftTeamId, expected.expectedRightTeamId];
  const expectedNames = [expected.expectedLeftTeamName, expected.expectedRightTeamName];
  if (!received.present || received.ids.length !== 2) {
    addDiscrepancy(warnings, 'unreadable-result', 'two teams', received.present ? received.ids.length : 'missing');
    return;
  }

  const expectedIdsAvailable = expectedIds.every((id) => id !== undefined);
  const receivedIdsAvailable = received.ids.every((id) => id !== undefined);
  if (expectedIdsAvailable && receivedIdsAvailable) {
    if (received.ids[0] === expectedIds[1] && received.ids[1] === expectedIds[0]) {
      addDiscrepancy(warnings, 'team-order-different', expectedIds, received.ids);
    } else if (received.ids[0] !== expectedIds[0] || received.ids[1] !== expectedIds[1]) {
      addDiscrepancy(warnings, 'team-id-mismatch', expectedIds, received.ids);
      if (received.ids.every((id) => id !== undefined && !expectedIds.includes(id))) {
        addDiscrepancy(warnings, 'unknown-team', expectedIds, received.ids);
      }
    }
  }

  const expectedNamesAvailable = expectedNames.every((name) => name !== undefined);
  const receivedNamesAvailable = received.names.every((name) => name !== undefined);
  if (!expectedNamesAvailable || !receivedNamesAvailable) return;
  if (
    received.names[0] === expectedNames[1] &&
    received.names[1] === expectedNames[0] &&
    !(received.ids[0] === expectedIds[1] && received.ids[1] === expectedIds[0])
  ) {
    addDiscrepancy(warnings, 'team-order-different', expectedNames, received.names);
  } else if (received.names[0] !== expectedNames[0] || received.names[1] !== expectedNames[1]) {
    addDiscrepancy(warnings, 'team-name-mismatch', expectedNames, received.names);
    if (received.names.every((name) => name !== undefined && !expectedNames.includes(name))) {
      addDiscrepancy(warnings, 'unknown-team', expectedNames, received.names);
    }
  }
}

function referenceId(value: unknown): string | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.$ref === 'string' && value.$ref !== '') return value.$ref;
  if (typeof value.id === 'string' && value.id !== '') return value.id;
  return undefined;
}

function objectIndex(document: object): Map<string, Record<string, unknown>> {
  return new Map(
    objectsIn(document)
      .filter((entry) => typeof entry.id === 'string' && entry.id !== '')
      .map((entry) => [entry.id as string, entry]),
  );
}

function resolvedObject(
  value: unknown,
  objects: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = referenceId(value);
  return (id ? objects.get(id) : undefined) ?? value;
}

function playerIdentityValues(
  values: unknown,
  objects: Map<string, Record<string, unknown>>,
): { id?: string; name?: string }[] {
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const player = resolvedObject(isPlainObject(value) && 'player' in value ? value.player : value, objects);
    if (!player) return [];
    const id = referenceId(isPlainObject(value) && 'player' in value ? value.player : player);
    const name = typeof player.name === 'string' && player.name.trim() !== '' ? player.name : undefined;
    return id || name ? [{ ...(id ? { id } : {}), ...(name ? { name } : {}) }] : [];
  });
}

/** Compare only players that appear in the result; bench players are intentionally absent from QBJ results. */
function comparePlayers(
  match: Record<string, unknown>,
  expected: IResultReceiptContext,
  expectedDocument: object,
  receivedDocument: object,
  warnings: IResultDiscrepancy[],
): void {
  // A result normally carries the player objects it references. Prefer the assignment's copy when
  // an id exists in both documents, but also resolve an id that is present only in the received
  // document so a genuinely unknown player is reported rather than silently disappearing.
  const objects = new Map([...objectIndex(receivedDocument), ...objectIndex(expectedDocument)]);
  const expectedTeamIds = [expected.expectedLeftTeamId, expected.expectedRightTeamId];
  const rawTeams = match.match_teams ?? match.matchTeams;
  if (!Array.isArray(rawTeams)) return;

  rawTeams.slice(0, 2).forEach((rawTeam, position) => {
    const expectedTeam = objects.get(expectedTeamIds[position] ?? '');
    const expectedPlayers = expectedTeam ? playerIdentityValues(expectedTeam.players, objects) : [];
    if (expectedPlayers.length === 0) return;
    const receivedPlayers = isPlainObject(rawTeam)
      ? playerIdentityValues(rawTeam.match_players ?? rawTeam.matchPlayers, objects)
      : [];
    if (receivedPlayers.length === 0) return;

    const expectedIds = expectedPlayers.flatMap((player) => (player.id ? [player.id] : []));
    const expectedNames = expectedPlayers.flatMap((player) => (player.name ? [player.name] : []));
    const receivedIds = receivedPlayers.flatMap((player) => (player.id ? [player.id] : []));
    const receivedNames = receivedPlayers.flatMap((player) => (player.name ? [player.name] : []));
    const expectedIdByName = new Map(
      expectedPlayers.flatMap((player) => (player.name && player.id ? [[player.name, player.id] as const] : [])),
    );
    const expectedNameById = new Map(
      expectedPlayers.flatMap((player) => (player.id && player.name ? [[player.id, player.name] as const] : [])),
    );

    if (receivedIds.some((id) => !expectedIds.includes(id))) {
      addDiscrepancy(warnings, 'unknown-player', expectedIds, receivedIds);
    }
    if (receivedNames.some((name) => !expectedNames.includes(name))) {
      addDiscrepancy(warnings, 'unknown-player', expectedNames, receivedNames);
    }
    if (
      receivedIds.some((id) => expectedIds.includes(id) && expectedNameById.get(id) !== undefined) &&
      receivedPlayers.some((player) => player.id && player.name && expectedNameById.get(player.id) !== player.name)
    ) {
      addDiscrepancy(warnings, 'player-name-mismatch', expectedNames, receivedNames);
    }
    if (
      receivedPlayers.some(
        (player) =>
          player.name &&
          expectedIdByName.has(player.name) &&
          player.id &&
          expectedIdByName.get(player.name) !== player.id,
      )
    ) {
      addDiscrepancy(warnings, 'player-id-mismatch', expectedIds, receivedIds);
    }
    if (
      receivedIds.length > 0 &&
      expectedIds.length > 0 &&
      receivedIds.length !== expectedIds.length &&
      receivedIds.every((id) => expectedIds.includes(id))
    ) {
      addDiscrepancy(warnings, 'roster-different', expectedIds, receivedIds);
    }
  });
}

/** Calculate all stable content discrepancies for one result against one immutable assignment. */
export function resultDiscrepancies(
  document: unknown,
  expected: IResultReceiptContext,
  expectedDocument?: object,
): IResultDiscrepancy[] {
  const warnings: IResultDiscrepancy[] = [];
  const match = findResultMatch(document);
  if (!match) {
    addDiscrepancy(warnings, 'unreadable-result');
    return warnings;
  }

  const identity = readResultIdentity(document);
  const source = readResultSourceMetadata(match);
  if (expected.tournamentId && identity?.tournamentId && identity.tournamentId !== expected.tournamentId) {
    addDiscrepancy(warnings, 'tournament-id-mismatch', expected.tournamentId, identity.tournamentId);
  }
  if (typeof source.tournamentId === 'string' && source.tournamentId !== expected.tournamentId) {
    addDiscrepancy(warnings, 'source-tournament-different', expected.tournamentId, source.tournamentId);
  }
  if (!identity?.matchId) {
    addDiscrepancy(warnings, 'match-id-missing', expected.expectedMatchId);
  } else if (identity.matchId !== expected.expectedMatchId) {
    addDiscrepancy(warnings, 'match-id-mismatch', expected.expectedMatchId, identity.matchId);
  }
  if (
    expected.expectedRoundNumber !== undefined &&
    identity?.roundNumber !== undefined &&
    identity.roundNumber !== expected.expectedRoundNumber
  ) {
    addDiscrepancy(warnings, 'round-mismatch', expected.expectedRoundNumber, identity.roundNumber);
  }

  const declared = declaredRevisions(match);
  // A pre-split result used `round_revision` for the room assignment revision. New results carry
  // both values, so only the old shape takes this compatibility branch.
  const legacyAssignmentRevision = declared.assignment === undefined ? declared.round : undefined;
  const assignmentRevision = declared.assignment ?? legacyAssignmentRevision;
  const roundRevision = legacyAssignmentRevision === undefined ? declared.round : undefined;
  if (assignmentRevision !== undefined) {
    if (typeof assignmentRevision !== 'number' || !Number.isInteger(assignmentRevision)) {
      addDiscrepancy(warnings, 'invalid-assignment-metadata', 'integer assignment revision', assignmentRevision);
    } else if (
      expected.expectedAssignmentRevision !== undefined &&
      assignmentRevision < expected.expectedAssignmentRevision
    ) {
      addDiscrepancy(warnings, 'stale-assignment', expected.expectedAssignmentRevision, assignmentRevision);
    } else if (
      expected.expectedAssignmentRevision !== undefined &&
      assignmentRevision > expected.expectedAssignmentRevision
    ) {
      addDiscrepancy(
        warnings,
        'unexpected-assignment-revision',
        expected.expectedAssignmentRevision,
        assignmentRevision,
      );
    }
  }
  if (roundRevision !== undefined) {
    const expectedRoundRevision = expected.expectedRoundRevision ?? expected.expectedAssignmentRevision;
    if (typeof roundRevision !== 'number' || !Number.isInteger(roundRevision)) {
      addDiscrepancy(warnings, 'invalid-assignment-metadata', 'integer round revision', roundRevision);
    } else if (expectedRoundRevision !== undefined && roundRevision < expectedRoundRevision) {
      addDiscrepancy(warnings, 'stale-assignment', expectedRoundRevision, roundRevision);
    } else if (expectedRoundRevision !== undefined && roundRevision > expectedRoundRevision) {
      addDiscrepancy(warnings, 'unexpected-assignment-revision', expectedRoundRevision, roundRevision);
    }
  }

  const location = match.location ?? match.room;
  if (expected.roomName && typeof location === 'string' && location !== expected.roomName) {
    addDiscrepancy(warnings, 'room-mismatch', expected.roomName, location);
  }
  const extension = isPlainObject(match._qbtcp) ? match._qbtcp : undefined;
  const receivedRoomId = valueFromAliases(extension, ['room_id', 'roomId']);
  if (expected.roomId && typeof receivedRoomId === 'string' && receivedRoomId !== expected.roomId) {
    addDiscrepancy(warnings, 'room-mismatch', expected.roomId, receivedRoomId);
  }
  compareTeams(match, expected, warnings);

  if (expectedDocument) {
    const metadataChecks: Array<{
      category: 'scoringRules' | 'procedure' | 'packet';
      code: 'scoring-rules-different' | 'procedure-different' | 'packet-different';
    }> = [
      { category: 'scoringRules', code: 'scoring-rules-different' },
      { category: 'procedure', code: 'procedure-different' },
      { category: 'packet', code: 'packet-different' },
    ];
    for (const check of metadataChecks) {
      const expectedValue = metadataValue(expectedDocument, check.category);
      const receivedValue = metadataValue(document, check.category);
      if (
        expectedValue !== undefined &&
        receivedValue !== undefined &&
        canonical(expectedValue) !== canonical(receivedValue)
      ) {
        addDiscrepancy(warnings, check.code, metadataFingerprint(expectedValue), metadataFingerprint(receivedValue));
      }
    }
    comparePlayers(match, expected, expectedDocument, isPlainObject(document) ? document : {}, warnings);
  }

  return warnings;
}

export function discrepancyMessage(code: ResultDiscrepancyCode): string {
  return discrepancyMessages[code];
}
