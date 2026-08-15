import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test } from 'vitest';
import QbtcpServer, { validateResultAgainstAssignment } from '../main/qbtcp/QbtcpServer';
import QbtcpStore from '../main/qbtcp/QbtcpStore';
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

test('a multi-game file is classified and recorded one game at a time', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-multi-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('multi-game-tournament');

    const game = (id: string, points: number) => ({
      type: 'Match',
      id,
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
    });
    const file = (ids: string[]) => ({
      version: '2.1.1',
      objects: [
        { type: 'Tournament', id: 'multi-game-tournament', name: 'Spring Invitational' },
        ...ids.map((id, index) => game(id, 300 + index * 10)),
      ],
    });

    // The first game arrives on its own and goes on record.
    await server.recordFileResult(file(['Match_1']));
    expect(server.getState().results).toHaveLength(1);

    // Now a file whose first game is that one and whose other two are new.
    const comparisons = server.classifyResults(file(['Match_1', 'Match_2', 'Match_3']));
    expect(comparisons.map((entry) => entry.kind)).toEqual(['duplicate', 'new', 'new']);

    await server.recordFileResult(file(['Match_1', 'Match_2', 'Match_3']));
    // Three games on record, not one - the games after the first are remembered too.
    expect(server.getState().results.map((entry) => entry.matchId)).toEqual(['Match_1', 'Match_2', 'Match_3']);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a game from another tournament is not mistaken for this tournament's", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-foreign-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('this-tournament');

    const bareGame = (tournamentId: string) => ({
      type: 'Match',
      // The kind of match id two tournaments running the same software both hand out.
      id: 'Match_1000',
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points: 300 },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
      _qbsheet_source: { tournamentId },
    });

    await server.recordFileResult(bareGame('this-tournament'));
    expect(server.getState().results).toHaveLength(1);

    // Same match id, different tournament, different statistics: a different game entirely.
    const foreign = { ...bareGame('some-other-tournament'), tossups_read: 24 };
    expect(server.classifyResults(foreign)).toEqual([{ kind: 'new' }]);
    await expect(server.recordFileResult(foreign)).rejects.toThrow('different tournament');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
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
