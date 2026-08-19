/**
 * Generating a schedule for a pool that brings games with it.
 *
 * A playoff pool with carryover has already played some of its own round robin. YellowFruit's 12-team,
 * 8-round schedule is built on exactly that: two playoff pools of six, three rounds each, where a
 * fresh six-team round robin would take five. The three rounds are not a mistake in the template - the
 * other six meetings happened in prelims and count.
 *
 * So the question these tests ask is always the same one: does each pair of teams in the pool end up
 * having met exactly the number of times the pool declares, counting the games they carried in?
 */
import { expect, test } from 'vitest';
import { PairingGenerationMode } from '../renderer/DataModel/PairingGeneration';
import { Sched12Teams8Rounds } from '../renderer/DataModel/Schedules/12-team';
import { Phase } from '../renderer/DataModel/Phase';
import { Pool } from '../renderer/DataModel/Pool';
import Tournament from '../renderer/DataModel/Tournament';
import {
  carriedOverMeetingKeys,
  makeSingleCarryoverGameTournament,
  makeTwelveTeamCarryoverTournament,
  meetingKeysInPhase,
  playScheduledGames,
  rebracketIntoCarryoverPools,
  twelveTeamNames,
} from './ScheduledGameFixtures';

/** Every unordered pair of a pool's teams, as the sorted "Jaguar|Lion" keys the fixtures produce. */
function allPairsInPool(pool: Pool): string[] {
  const names = pool.poolTeams.map((pt) => pt.team.name);
  const pairs: string[] = [];
  for (let i = 0; i < names.length - 1; i++) {
    for (let j = i + 1; j < names.length; j++) {
      pairs.push([names[i], names[j]].sort().join('|'));
    }
  }
  return pairs;
}

function countByKey(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** No team may be in two of a round's games, whichever pool each game came from. */
function assertNoTeamPlaysTwicePerRound(phase: Phase) {
  for (const round of phase.rounds) {
    const names = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(new Set(names).size).toBe(names.length);
  }
}

/** The generated schedule plus the carryover, which is what the teams actually end up playing. */
function effectiveMeetings(tournament: Tournament, phase: Phase): Map<string, number> {
  return countByKey(meetingKeysInPhase(phase).concat(carriedOverMeetingKeys(tournament, phase)));
}

test('the 12-team 8-round template fills its three playoff rounds with the games that are left', () => {
  const tournament = makeTwelveTeamCarryoverTournament();
  const [prelims] = tournament.phases;
  expect(prelims.rounds).toHaveLength(5);
  expect(prelims.getAllScheduledGames()).toHaveLength(30); // two pools of six, C(6,2) each

  playScheduledGames(tournament, prelims);
  const playoffs = rebracketIntoCarryoverPools(tournament);
  expect(playoffs.rounds).toHaveLength(3);

  const outcome = tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  // Nine games per pool, not the fifteen a fresh six-team round robin would be: six meetings per pool
  // came over from prelims. Fifteen would not have fit in three rounds, which is the bug this is for.
  expect(outcome.skipped).toEqual([]);
  expect(outcome.gamesCreated).toBe(18);
  for (const round of playoffs.rounds) {
    expect(round.scheduledGames).toHaveLength(6); // three per pool, six teams each
  }
  assertNoTeamPlaysTwicePerRound(playoffs);

  // Every pair in every playoff pool has met exactly once, whether in prelims or in the playoffs.
  const effective = effectiveMeetings(tournament, playoffs);
  for (const pool of playoffs.pools) {
    for (const pair of allPairsInPool(pool)) {
      expect(effective.get(pair)).toBe(1);
    }
  }
});

test('a carried-over pair is not paired again in a single round robin', () => {
  const tournament = makeTwelveTeamCarryoverTournament();
  const [prelims] = tournament.phases;
  playScheduledGames(tournament, prelims);
  const playoffs = rebracketIntoCarryoverPools(tournament);
  tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  const carried = carriedOverMeetingKeys(tournament, playoffs);
  expect(carried).toHaveLength(12); // six per playoff pool
  const scheduled = new Set(meetingKeysInPhase(playoffs));
  for (const pair of carried) {
    expect(scheduled.has(pair)).toBe(false);
  }
});

test('the carried-over matches themselves are left exactly as they were', () => {
  const tournament = makeTwelveTeamCarryoverTournament();
  const [prelims] = tournament.phases;
  playScheduledGames(tournament, prelims);
  const playoffs = rebracketIntoCarryoverPools(tournament);

  const before = prelims.getAllMatches().map((match) => ({
    id: match.id,
    scheduledGameId: match.scheduledGameId,
    phases: match.carryoverPhases.map((ph) => ph.name),
  }));
  const prelimGameCount = prelims.getAllMatches().length;

  tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  // Carryover is history. Generation reads it and writes nothing back to it - no duplicated Match, no
  // Match moved into the playoff phase, no pairing invented to stand in for one.
  expect(prelims.getAllMatches()).toHaveLength(prelimGameCount);
  expect(
    prelims.getAllMatches().map((match) => ({
      id: match.id,
      scheduledGameId: match.scheduledGameId,
      phases: match.carryoverPhases.map((ph) => ph.name),
    })),
  ).toEqual(before);
  expect(playoffs.getAllMatches()).toHaveLength(0);
});

test('a two-round-robin pool with one game carried in schedules one more meeting for that pair', () => {
  const { tournament, playoffs, championship } = makeSingleCarryoverGameTournament(2, 6);

  const outcome = tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  expect(outcome.skipped).toEqual([]);
  // 2 x C(4,2) = 12 meetings required, one of which was carried in.
  expect(outcome.gamesCreated).toBe(11);

  const scheduled = countByKey(meetingKeysInPhase(playoffs));
  // The carried-over pair still owes one more game, not none and not two.
  expect(scheduled.get('Lion|Tiger')).toBe(1);
  for (const pair of allPairsInPool(championship)) {
    expect(effectiveMeetings(tournament, playoffs).get(pair)).toBe(2);
  }
  assertNoTeamPlaysTwicePerRound(playoffs);
});

test('a carryover pool that cannot fit its remaining games keeps the schedule it had', () => {
  // Eleven games among four teams need six rounds; this phase has five.
  const { tournament, playoffs, championship } = makeSingleCarryoverGameTournament(2, 5);

  const outcome = tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.gamesRemoved).toBe(0);
  expect(outcome.skipped).toHaveLength(1);
  expect(outcome.skipped[0]).toContain(championship.name);
  expect(outcome.skipped[0]).toContain('carried over');
  expect(playoffs.getAllScheduledGames()).toHaveLength(0);
  expect(playoffs.rounds).toHaveLength(5); // no rounds quietly added to make it fit
});

test('a failed carryover generation does not destroy the pairings already there', () => {
  const { tournament, playoffs } = makeSingleCarryoverGameTournament(2, 6);
  tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);
  const idsBefore = playoffs.getAllScheduledGames().map((game) => game.id);
  expect(idsBefore).toHaveLength(11);

  // Now the pool is asked for more than the phase can hold. The plan is worked out before anything is
  // deleted, so the pool keeps the schedule it had rather than being left with nothing.
  playoffs.pools[0].roundRobins = 4;
  const outcome = tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  expect(outcome.gamesRemoved).toBe(0);
  expect(outcome.gamesCreated).toBe(0);
  expect(playoffs.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
});

test('a pool that declares carryover but has none is still given its whole round robin', () => {
  // Before rebracketing there is nothing to carry, and "carryover" must not be read as "fewer games".
  const tournament = makeTwelveTeamCarryoverTournament();
  const [, playoffs] = tournament.phases;
  const wholeField = tournament.getListOfAllTeams();
  const pool = new Pool(6, 1, 'Championship', true);
  wholeField.slice(0, 6).forEach((team) => pool.addTeam(team));
  playoffs.pools = [pool];

  const outcome = tournament.generatePairingsForOnePhase(playoffs, PairingGenerationMode.ReplaceAll);

  // A six-team round robin needs five rounds and this phase has three, so it is reported rather than
  // silently shortened to whatever happens to fit.
  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.skipped[0]).toContain('needs 5 rounds');
});

test('the shipped 12-team template is unchanged by all of this', () => {
  // The template still says what it always said; the fix is in how it is read.
  expect(Sched12Teams8Rounds.rounds).toBe(8);
  const phases = Sched12Teams8Rounds.constructPhases();
  expect(phases[1].pools.every((pool) => pool.hasCarryover)).toBe(true);
  expect(phases[1].pools.every((pool) => pool.roundRobins === 1)).toBe(true);
  expect(twelveTeamNames).toHaveLength(Sched12Teams8Rounds.size);
});
