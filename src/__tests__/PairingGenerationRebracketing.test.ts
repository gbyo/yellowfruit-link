/**
 * When a playoff phase's pairings get written.
 *
 * A template's prelim pairings can be generated as teams are registered, because the prelim pools are
 * known from the moment the template is applied. Playoff pools are not: they are empty until teams
 * have earned their way into them, so their schedules cannot exist until a rebracketing has put them
 * there. This is about picking that moment - after the whole operation, not after each team lands in a
 * pool that is still half-built.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Phase } from '../renderer/DataModel/Phase';
import { Pool } from '../renderer/DataModel/Pool';
import { Team } from '../renderer/DataModel/Team';
import Tournament from '../renderer/DataModel/Tournament';
import {
  TestTournamentManager,
  installRendererGlobals,
  restoreRendererGlobals,
  roomWithAssignment,
} from './TournamentManagerFixtures';
import {
  carriedOverMeetingKeys,
  makeTwelveTeamCarryoverTournament,
  meetingKeysInPhase,
  playScheduledGames,
} from './ScheduledGameFixtures';

beforeEach(installRendererGlobals);
afterEach(restoreRendererGlobals);

/** A 12-team template with prelims played and stats compiled, ready to be rebracketed. */
function preparedForRebracketing() {
  const manager = new TestTournamentManager();
  const tournament = makeTwelveTeamCarryoverTournament();
  manager.loadTournament(tournament);
  const [prelims, playoffs] = tournament.phases;
  playScheduledGames(tournament, prelims);
  manager.compileStats();
  return { manager, tournament, prelims, playoffs };
}

/** Rebracket every prelim pool, the way the Teams page's per-pool button does. */
function rebracketEverything(manager: TestTournamentManager, tournament: Tournament, playoffs: Phase) {
  const prelimStats = tournament.stats[0];
  for (const poolStats of prelimStats.pools) {
    manager.rebracketPool(poolStats, playoffs);
  }
}

function assertPlayableCarryoverSchedule(tournament: Tournament, playoffs: Phase) {
  expect(playoffs.getAllScheduledGames()).toHaveLength(18);
  for (const round of playoffs.rounds) {
    expect(round.scheduledGames).toHaveLength(6);
    const names = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(new Set(names).size).toBe(names.length);
  }
  // Counting the carryover, every pair in each playoff pool has met exactly once.
  const effective = meetingKeysInPhase(playoffs).concat(carriedOverMeetingKeys(tournament, playoffs));
  const counts = new Map<string, number>();
  for (const key of effective) counts.set(key, (counts.get(key) ?? 0) + 1);
  for (const pool of playoffs.pools) {
    const names = pool.poolTeams.map((pt) => pt.team.name);
    for (let i = 0; i < names.length - 1; i++) {
      for (let j = i + 1; j < names.length; j++) {
        expect(counts.get([names[i], names[j]].sort().join('|'))).toBe(1);
      }
    }
  }
}

test('a template playoff phase has no pairings until its pools are populated', () => {
  const { tournament, playoffs } = preparedForRebracketing();

  // The prelim schedule was written as the teams were registered. The playoff pools are still empty,
  // and a schedule for an empty pool would be a schedule for nobody.
  expect(tournament.phases[0].getAllScheduledGames()).toHaveLength(30);
  expect(playoffs.pools.every((pool) => pool.poolTeams.length === 0)).toBe(true);
  expect(playoffs.anyScheduledGamesExist()).toBe(false);
});

test('a half-rebracketed playoff pool is not given a schedule for half its teams', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();
  const prelimStats = tournament.stats[0];

  manager.rebracketPool(prelimStats.pools[0], playoffs);

  // Three of six in each playoff pool. Generating here would produce a three-team round robin and
  // then throw it away a moment later, which is exactly what the transaction boundary avoids.
  expect(playoffs.pools.every((pool) => pool.poolTeams.length === 3)).toBe(true);
  expect(playoffs.anyScheduledGamesExist()).toBe(false);
});

test('rebracketing the last pool writes the playoff schedule', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();

  rebracketEverything(manager, tournament, playoffs);

  assertPlayableCarryoverSchedule(tournament, playoffs);
  // Generated, so a later reseeding may still rewrite them, and recorded against their pools.
  expect(playoffs.getAllScheduledGames().every((game) => game.generated)).toBe(true);
  const poolNames = new Set(playoffs.getAllScheduledGames().map((game) => game.poolName));
  expect([...poolNames].sort()).toEqual(playoffs.pools.map((pool) => pool.name).sort());
});

test('a director override refreshes the affected pools and leaves a playable schedule', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();
  const [prelims] = tournament.phases;
  rebracketEverything(manager, tournament, playoffs);
  const [topPool, bottomPool] = playoffs.pools;

  // Swap two teams that came out of the same prelim pool, so both playoff pools still hold three
  // teams from each prelim pool and the carryover arithmetic still works out to three rounds.
  const demoted = topPool.poolTeams[0].team;
  const prelimPool = prelims.findPoolWithTeam(demoted) as Pool;
  const promoted = bottomPool.poolTeams
    .map((pt) => pt.team)
    .find((team) => prelims.findPoolWithTeam(team) === prelimPool) as Team;
  expect(promoted).toBeDefined();

  manager.overridePlayoffPoolAssignment(demoted, playoffs, bottomPool);
  manager.overridePlayoffPoolAssignment(promoted, playoffs, topPool);

  expect(topPool.includesTeam(promoted)).toBe(true);
  expect(bottomPool.includesTeam(demoted)).toBe(true);
  assertPlayableCarryoverSchedule(tournament, playoffs);
});

test('a hand-edited playoff pairing stops its pool being regenerated', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();
  rebracketEverything(manager, tournament, playoffs);
  const [topPool, bottomPool] = playoffs.pools;

  // The director fixed one pairing by hand. From here the pool's schedule is theirs.
  const edited = playoffs.getAllScheduledGames().find((game) => game.poolName === topPool.name);
  expect(edited).toBeDefined();
  edited!.generated = false;
  const idsBefore = playoffs.getAllScheduledGames().map((game) => game.id);

  // Something that would otherwise rewrite the top pool: a team leaving it.
  manager.overridePlayoffPoolAssignment(topPool.poolTeams[0].team, playoffs, bottomPool);

  expect(playoffs.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
});

test('a pairing a room is holding stops its pool being regenerated', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();
  rebracketEverything(manager, tournament, playoffs);
  const [topPool, bottomPool] = playoffs.pools;

  const live = playoffs.getAllScheduledGames().find((game) => game.poolName === topPool.name);
  expect(live).toBeDefined();
  manager.setRooms([roomWithAssignment('room-1', 'Room 1', live!.id, playoffs.rounds[0].number)]);
  const idsBefore = playoffs.getAllScheduledGames().map((game) => game.id);

  manager.overridePlayoffPoolAssignment(topPool.poolTeams[0].team, playoffs, bottomPool);

  // The pool is left exactly as it is - including the pairing the room is about to score, whose id is
  // what the QBTCP session and any returning result are keyed on.
  expect(playoffs.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
  expect(tournament.findScheduledGameById(live!.id)).toBeDefined();
});

test('adding one team to a playoff pool outside a rebracketing still generates', () => {
  const { manager, tournament, playoffs } = preparedForRebracketing();
  const [topPool] = playoffs.pools;

  rebracketEverything(manager, tournament, playoffs);
  // A team the director had held back, added on its own from the standings view.
  const spare = topPool.poolTeams[0].team;
  manager.overridePlayoffPoolAssignment(spare, playoffs, undefined);
  expect(topPool.poolTeams).toHaveLength(5);

  manager.addTeamtoPlayoffPool(spare, topPool, playoffs);

  expect(topPool.poolTeams).toHaveLength(6);
  assertPlayableCarryoverSchedule(tournament, playoffs);
});
