/**
 * The assignment builder: what it produces, and what it must never produce.
 *
 * The credential and "unplayed" assertions are the important ones. Both describe things that would be
 * silently wrong rather than visibly broken - a token in an exported file works fine right up until
 * the file is emailed to somebody, and a fabricated zero score parses perfectly right up until an
 * importer treats an assignment as a nil-nil result.
 */
import { expect, test } from 'vitest';
import { assignmentFileName, buildAssignmentDocument } from '../renderer/DataModel/QbjAssignment';
import { makeTeam, makeTestTournament, objectsOfType, roundNumbered, teamNamed } from './QbtcpFixtures';

function buildFixtureAssignment(matchId = 'Match_abc123') {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  return {
    tournament,
    document: buildAssignmentDocument({
      tournament,
      phase,
      round,
      leftTeam: teamNamed(tournament, 'Ninety Six'),
      rightTeam: teamNamed(tournament, 'Greenwood'),
      matchId,
      roomName: 'Room 204',
      roomId: 'room-204',
      roundRevision: 1,
    }),
  };
}

test('assignment is an official serialized QBJ document', () => {
  const { document } = buildFixtureAssignment();
  expect((document as { version: string }).version).toBe('2.1.1');
  expect(Array.isArray((document as { objects: unknown[] }).objects)).toBe(true);
});

test('assignment contains exactly the objects one game needs', () => {
  const { document } = buildFixtureAssignment();

  expect(objectsOfType(document, 'Tournament')).toHaveLength(1);
  expect(objectsOfType(document, 'ScoringRules')).toHaveLength(1);
  expect(objectsOfType(document, 'Match')).toHaveLength(1);
  // Only the two teams that play, and only their registrations.
  expect(objectsOfType(document, 'Team')).toHaveLength(2);
  expect(objectsOfType(document, 'Registration')).toHaveLength(2);
});

test('assignment names only the two teams playing, not the whole field', () => {
  const { document } = buildFixtureAssignment();
  const names = objectsOfType(document, 'Team').map((team) => team.name);
  expect(names.sort()).toEqual(['Greenwood', 'Ninety Six']);
  expect(JSON.stringify(document)).not.toContain('Clinton');
  expect(JSON.stringify(document)).not.toContain('Emerald');
});

test('the phase carries the one relevant round, numerically named', () => {
  const { document } = buildFixtureAssignment();
  const tournament = objectsOfType(document, 'Tournament')[0];
  const phases = tournament.phases as { rounds: Record<string, unknown>[] }[];
  expect(phases).toHaveLength(1);
  expect(phases[0].rounds).toHaveLength(1);
  // "4", not "Round 4": a display string here makes the round unresolvable on the way back.
  expect(phases[0].rounds[0].name).toBe('4');
});

test('the round points at the match by reference', () => {
  const { document } = buildFixtureAssignment('Match_xyz');
  const tournament = objectsOfType(document, 'Tournament')[0];
  const phases = tournament.phases as { rounds: { matches: { $ref: string }[] }[] }[];
  expect(phases[0].rounds[0].matches).toEqual([{ $ref: 'Match_xyz' }]);
});

test('the match is represented as unplayed', () => {
  const { document } = buildFixtureAssignment();
  const match = objectsOfType(document, 'Match')[0];

  // No fabricated scoring content of any kind: its absence is the signal an importer relies on.
  expect(match.tossups_read).toBeUndefined();
  expect(match.overtime_tossups_read).toBeUndefined();
  const matchTeams = match.match_teams as Record<string, unknown>[];
  expect(matchTeams).toHaveLength(2);
  for (const matchTeam of matchTeams) {
    expect(matchTeam.points).toBeUndefined();
    expect(matchTeam.match_players).toBeUndefined();
    expect(matchTeam.team).toHaveProperty('$ref');
  }
});

test('the match carries the room and the _qbtcp operational block', () => {
  const { document } = buildFixtureAssignment();
  const match = objectsOfType(document, 'Match')[0];

  expect(match.location).toBe('Room 204');
  const extension = match._qbtcp as Record<string, unknown>;
  expect(extension.version).toBe(1);
  expect(extension.round_revision).toBe(1);
  expect(extension.room_id).toBe('room-204');
  // QBSheet refuses to start scoring without knowing whether the round is timed, so this is required.
  expect(extension.scorekeeper).toEqual({ timed: false });
});

test('the assignment carries the neutral default room procedure', () => {
  const { document } = buildFixtureAssignment();
  const match = objectsOfType(document, 'Match')[0];
  const extension = JSON.parse(JSON.stringify(match._qbtcp)) as Record<string, unknown>;

  expect(extension.procedure).toEqual({ version: 3, halves: false, timeoutsPerTeam: 0 });
  expect(extension.handoff_instruction).toBeUndefined();
});

test('a round procedure and handoff override are resolved into the assignment snapshot', () => {
  const tournament = makeTestTournament();
  tournament.roomProcedure = {
    version: 3,
    halves: true,
    breaks: [{ afterTossup: 10, label: 'Tournament break' }],
    halfLengthMinutes: 25,
    timeoutsPerTeam: 1,
    timeoutDurationSeconds: 60,
    protestCheckpoints: 'phase-boundaries',
    substitutionPolicy: 'any-boundary',
  };
  tournament.handoffInstruction = 'Tournament handoff';
  const round = roundNumbered(tournament, 4);
  round.roomProcedure = {
    version: 3,
    halves: false,
    timeoutsPerTeam: 2,
    timeoutDurationSeconds: 45,
    protestCheckpoints: 'strict-overtime',
    substitutionPolicy: 'breaks-timeouts-overtime',
  };
  round.handoffInstruction = 'Round handoff';
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');

  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam: teamNamed(tournament, 'Ninety Six'),
    rightTeam: teamNamed(tournament, 'Greenwood'),
    matchId: 'Match_procedure',
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 1,
  });
  const match = objectsOfType(document, 'Match')[0];
  const extension = JSON.parse(JSON.stringify(match._qbtcp)) as Record<string, unknown>;

  expect(extension.procedure).toEqual(round.roomProcedure);
  expect(extension.handoff_instruction).toBe('Round handoff');
  expect(extension.scorekeeper).toEqual({ timed: false });
});

test('_qbtcp restates no identity that standard QBJ already carries', () => {
  const { document } = buildFixtureAssignment();
  const extension = objectsOfType(document, 'Match')[0]._qbtcp as Record<string, unknown>;

  // A duplicated identity is two fields that can disagree, and a generic consumer reads the standard
  // one. So the extension carries neither the match nor the tournament nor a team name.
  expect(extension.scheduled_match_id).toBeUndefined();
  expect(extension.tournament_id).toBeUndefined();
  expect(extension.match_id).toBeUndefined();
  expect(extension.room_name).toBeUndefined();
});

test('the tournament id is published so a result can be reconciled', () => {
  const { tournament, document } = buildFixtureAssignment();
  const qbjTournament = objectsOfType(document, 'Tournament')[0];
  expect(qbjTournament.id).toBe(tournament.tournamentId);
  expect(tournament.tournamentId).not.toBe('');
});

test('scoring rules come from the tournament and are referenced, not inlined twice', () => {
  const { document } = buildFixtureAssignment();
  const rules = objectsOfType(document, 'ScoringRules')[0];
  const qbjTournament = objectsOfType(document, 'Tournament')[0];

  expect(qbjTournament.scoring_rules).toEqual({ $ref: rules.id });
  // The structural fields QBSheet derives scoring behaviour from, in snake_case.
  expect(rules.maximum_players_per_team).toBe(4);
  expect(rules.maximum_regulation_tossup_count).toBe(20);
  expect(rules.answer_types).toBeDefined();
  // Both bonus toggles are stated explicitly; their absence can change a score.
  expect(rules.bonuses_bounce_back).toBeDefined();
  expect(rules.overtime_includes_bonuses).toBeDefined();
});

test('every answer type says whether it awards a bonus', () => {
  const { document } = buildFixtureAssignment();
  const rules = objectsOfType(document, 'ScoringRules')[0];
  const answerTypes = rules.answer_types as { value: number; awards_bonus?: boolean }[];

  // Not optional in practice: a scoresheet given bonus structure without this refuses to score rather
  // than guess whether a neg leads to a bonus.
  for (const answerType of answerTypes) {
    expect(typeof answerType.awards_bonus).toBe('boolean');
  }
  expect(answerTypes.find((entry) => entry.value === 15)?.awards_bonus).toBe(true);
  expect(answerTypes.find((entry) => entry.value === 10)?.awards_bonus).toBe(true);
  expect(answerTypes.find((entry) => entry.value === -5)?.awards_bonus).toBe(false);
});

test('two teams from one school produce one Registration object, not two with the same id', () => {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  // An A and a B squad from the same school, which is an ordinary game to schedule.
  const registration = tournament.registrations[0];
  const bTeam = makeTeam(`${registration.name} B`, ['Robin', 'Kit', 'Sasha', 'Frankie']);
  registration.addTeam(bTeam);

  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam: registration.teams[0],
    rightTeam: bTeam,
    matchId: 'Match_intramural',
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 1,
  });

  const registrations = objectsOfType(document, 'Registration');
  // One object per registration. Two objects sharing an id would make every $ref to it ambiguous.
  expect(registrations).toHaveLength(1);
  expect(registrations[0].teams).toHaveLength(2);
  const qbjTournament = objectsOfType(document, 'Tournament')[0];
  expect(qbjTournament.registrations).toEqual([{ $ref: registrations[0].id }]);
});

test('a tournament without bonuses does not tell a scoresheet that answers award them', () => {
  const tournament = makeTestTournament();
  tournament.scoringRules.useBonuses = false;
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');

  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam: teamNamed(tournament, 'Ninety Six'),
    rightTeam: teamNamed(tournament, 'Greenwood'),
    matchId: 'Match_tossups_only',
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 1,
  });

  const rules = objectsOfType(document, 'ScoringRules')[0];
  expect(rules.maximum_bonus_score).toBeUndefined();
  const answerTypes = rules.answer_types as { value: number; awards_bonus?: boolean }[];
  // Every type still states the field; none of them claims a bonus this format does not have.
  for (const answerType of answerTypes) {
    expect(answerType.awards_bonus).toBe(false);
  }
});

test('the document names no rule set by name in a way that invites branching', () => {
  const { document } = buildFixtureAssignment();
  const rules = objectsOfType(document, 'ScoringRules')[0];
  // A name is allowed - it is a label. What matters is that the structural fields are all present, so
  // no consumer has to infer anything from the label.
  expect(rules.answer_types).toBeDefined();
  expect(rules.points_per_bonus_part).toBeDefined();
});

test('an assignment contains no credential of any kind', () => {
  const { document } = buildFixtureAssignment();
  const serialized = JSON.stringify(document).toLowerCase();

  for (const forbidden of [
    'pairingcode',
    'pairing_code',
    'roomtoken',
    'room_token',
    'sessiontoken',
    'session_token',
    'deviceid',
    'device_id',
    'accesstoken',
    'authorization',
    'secret',
    'http://',
    'https://',
  ]) {
    expect(serialized).not.toContain(forbidden);
  }
});

test('the same request produces the same document, so file and network cannot drift', () => {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  const request = {
    tournament,
    phase,
    round,
    leftTeam: teamNamed(tournament, 'Ninety Six'),
    rightTeam: teamNamed(tournament, 'Greenwood'),
    matchId: 'Match_same',
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 2,
  };
  // Two invocations of the one builder. The network serves the stored output of this call and the
  // export writes the same stored bytes, so equality here is the parity guarantee.
  expect(JSON.stringify(buildAssignmentDocument(request))).toBe(JSON.stringify(buildAssignmentDocument(request)));
});

test('a timed rule set is reported as timed', () => {
  const tournament = makeTestTournament();
  tournament.scoringRules.timed = true;
  const round = roundNumbered(tournament, 2);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam: teamNamed(tournament, 'Clinton'),
    rightTeam: teamNamed(tournament, 'Emerald'),
    matchId: 'Match_timed',
    roomName: 'Room 1',
    roomId: 'room-1',
    roundRevision: 1,
  });
  const extension = objectsOfType(document, 'Match')[0]._qbtcp as { scorekeeper: { timed: boolean } };
  expect(extension.scorekeeper.timed).toBe(true);
});

test('rosters travel with the teams so a room can pick a lineup', () => {
  const { document } = buildFixtureAssignment();
  for (const team of objectsOfType(document, 'Team')) {
    const players = team.players as { type: string; id: string; name: string }[];
    expect(players).toHaveLength(4);
    expect(players[0].type).toBe('Player');
    expect(players[0].id).toBeTruthy();
    expect(players[0].name).toBeTruthy();
  }
});

test('the suggested file name describes the game without being an identity', () => {
  expect(
    assignmentFileName({
      roundNumber: 4,
      roomName: 'Room 204',
      leftTeamName: 'Ninety Six',
      rightTeamName: 'Greenwood',
    }),
  ).toBe('R04_Room-204_Ninety-Six_vs_Greenwood.assignment.qbj');
});
