import { expect, test } from 'vitest';
import { validateResultAgainstAssignment } from '../main/qbtcp/QbtcpServer';
import { readResultIdentity, readResultSourceMetadata } from '../qbtcp/ResultFingerprint';
import { IRoomAssignment } from '../qbtcp/QbtcpState';
import { buildAssignmentDocument } from '../renderer/DataModel/QbjAssignment';
import { makeTestTournament, roundNumbered, teamNamed } from './QbtcpFixtures';

function buildFixture(): { assignment: IRoomAssignment; tournamentId: string } {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  const leftTeam = teamNamed(tournament, 'Ninety Six');
  const rightTeam = teamNamed(tournament, 'Greenwood');
  const matchId = 'Match_abc123';
  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam,
    rightTeam,
    matchId,
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 1,
  });
  return {
    tournamentId: tournament.tournamentId,
    assignment: {
      id: 'assignment-1',
      roomId: 'room-204',
      roundNumber: 4,
      leftTeamId: leftTeam.id,
      rightTeamId: rightTeam.id,
      matchId,
      revision: 1,
      document,
      leftTeamName: leftTeam.name,
      rightTeamName: rightTeam.name,
    },
  };
}

function bareQbsheetResult(tournamentId: string, matchId: string, roundRevision = 1): object {
  return {
    type: 'Match',
    tossupsRead: 20,
    matchTeams: [{ team: { name: 'Ninety Six' } }, { team: { name: 'Greenwood' } }],
    _qbsheet_source: {
      scheduledMatchId: matchId,
      tournamentId,
      roundRevision,
    },
  };
}

test('reads identity from the actual bare QBSheet result shape', () => {
  const { assignment, tournamentId } = buildFixture();
  const result = bareQbsheetResult(tournamentId, assignment.matchId);

  expect(readResultIdentity(result)).toMatchObject({
    matchId: assignment.matchId,
    tournamentId,
    roundRevision: 1,
  });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('uses the older scoresheet source when QBSheet source metadata is absent', () => {
  const { assignment, tournamentId } = buildFixture();
  const result = {
    ...bareQbsheetResult(tournamentId, assignment.matchId),
    _qbsheet_source: undefined,
    _scoresheet_source: {
      scheduledMatchId: assignment.matchId,
      tournamentId,
      roundRevision: assignment.revision,
    },
  };

  expect(readResultSourceMetadata(result as Record<string, unknown>)).toEqual({
    scheduledMatchId: assignment.matchId,
    tournamentId,
    roundRevision: assignment.revision,
  });
  expect(readResultIdentity(result)).toMatchObject({ matchId: assignment.matchId, tournamentId });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('prefers standard QBJ identity and team IDs when they are present', () => {
  const { assignment } = buildFixture();
  const result = JSON.parse(JSON.stringify(assignment.document)) as {
    objects: Record<string, unknown>[];
  };
  const match = result.objects.find((entry) => entry.type === 'Match');
  if (!match) throw new Error('fixture has no Match');

  expect(readResultIdentity(result)).toMatchObject({ matchId: assignment.matchId });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('rejects a bare result whose source revision is stale or whose names are misassigned', () => {
  const { assignment, tournamentId } = buildFixture();
  const stale = bareQbsheetResult(tournamentId, assignment.matchId, assignment.revision + 1);
  expect(validateResultAgainstAssignment(stale, assignment)).toBe(
    'That result belongs to an older assignment for this room.',
  );

  const wrongTeams = bareQbsheetResult(tournamentId, assignment.matchId);
  (wrongTeams as { matchTeams: { team: { name: string } }[] }).matchTeams[1].team.name = 'Clinton';
  expect(validateResultAgainstAssignment(wrongTeams, assignment)).toBe(
    'That result does not contain the two teams assigned to this scoring session.',
  );
});
