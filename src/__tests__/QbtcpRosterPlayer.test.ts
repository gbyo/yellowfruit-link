import { afterEach, beforeEach, expect, test } from 'vitest';
import { makeTestTournament, teamNamed } from './QbtcpFixtures';
import { installRendererGlobals, restoreRendererGlobals, TestTournamentManager } from './TournamentManagerFixtures';

let manager: TestTournamentManager;

beforeEach(() => {
  installRendererGlobals();
  manager = new TestTournamentManager();
  manager.loadTournament(makeTestTournament());
  manager.unsavedData = false;
});

afterEach(restoreRendererGlobals);

test('a QBSheet roster request immediately adds the player needed by the incoming result', async () => {
  const team = teamNamed(manager.tournament, 'Ninety Six');
  const originalCount = team.players.length;

  await manager.handleQbtcpRosterPlayerRequest({
    requestId: 'roster-1',
    roomId: 'room-1',
    sessionId: 'session-1',
    teamId: team.id,
    teamName: team.name,
    playerName: '  New Player  ',
  });

  expect(team.players.map((player) => player.name)).toContain('New Player');
  expect(team.players).toHaveLength(originalCount + 1);
  expect(manager.unsavedData).toBe(true);
  expect(manager.toasts).toContainEqual({
    message: 'New Player was added to Ninety Six from QBSheet.',
    severity: 'info',
  });

  await manager.handleQbtcpRosterPlayerRequest({
    requestId: 'roster-retry',
    roomId: 'room-1',
    sessionId: 'session-1',
    teamId: team.id,
    teamName: team.name,
    playerName: 'new player',
  });
  expect(team.players).toHaveLength(originalCount + 1);
});

test('a roster request cannot mutate a team with an unknown stable ID', async () => {
  const team = teamNamed(manager.tournament, 'Ninety Six');
  const originalNames = team.players.map((player) => player.name);

  await manager.handleQbtcpRosterPlayerRequest({
    requestId: 'roster-wrong-team',
    roomId: 'room-1',
    sessionId: 'session-1',
    teamId: 'Team_not-in-this-tournament',
    teamName: 'Greenwood',
    playerName: 'Should Not Exist',
  });

  expect(team.players.map((player) => player.name)).toEqual(originalNames);
  expect(manager.unsavedData).toBe(false);
});

test('a stable team ID wins when the scorekeeper sends a stale team name', async () => {
  const team = teamNamed(manager.tournament, 'Ninety Six');
  const originalCount = team.players.length;

  await manager.handleQbtcpRosterPlayerRequest({
    requestId: 'roster-renamed-team',
    roomId: 'room-1',
    sessionId: 'session-1',
    teamId: team.id,
    teamName: 'The old team name',
    playerName: 'Recovered Player',
  });

  expect(team.players.map((player) => player.name)).toContain('Recovered Player');
  expect(team.players).toHaveLength(originalCount + 1);
  expect(manager.unsavedData).toBe(true);
});
