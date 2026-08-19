/**
 * What the round-robin generator produces, at sizes nobody hand-wrote a schedule for.
 *
 * The assertions are the properties a round robin has, not a fixed list of pairings. A test that
 * pinned the exact ordering would break the moment the algorithm changed while saying nothing about
 * whether the schedule was still valid; these say the things a director would notice being wrong -
 * a team playing twice in a round, a pair meeting the wrong number of times, a bye going missing.
 */
import { describe, expect, test } from 'vitest';
import {
  gamesPerRoundRobinRound,
  generateRoundRobin,
  roundsNeededForRoundRobins,
  roundsPerRoundRobin,
} from '../renderer/DataModel/RoundRobinGenerator';
import { Team } from '../renderer/DataModel/Team';

function makeTeams(count: number): Team[] {
  const teams: Team[] = [];
  for (let i = 0; i < count; i++) teams.push(new Team(`Team ${i + 1}`));
  return teams;
}

/** "A|B" for a pairing, in a fixed order so the two orientations of one meeting collapse together. */
function pairKey(left: Team, right: Team): string {
  return [left.name, right.name].sort().join('|');
}

interface IPairingProperties {
  /** How many times each unordered pair appears. */
  meetingsByPair: Map<string, number>;
  /** Round offsets that contain at least one game. */
  roundOffsets: number[];
  /** Number of games in each round offset. */
  gamesByRound: Map<number, number>;
  /** Teams that appear more than once in some round. */
  doubleBooked: string[];
}

function analyze(pairings: ReturnType<typeof generateRoundRobin>): IPairingProperties {
  const meetingsByPair = new Map<string, number>();
  const gamesByRound = new Map<number, number>();
  const teamsPerRound = new Map<number, Set<string>>();
  const doubleBooked: string[] = [];

  for (const pairing of pairings) {
    const key = pairKey(pairing.leftTeam, pairing.rightTeam);
    meetingsByPair.set(key, (meetingsByPair.get(key) ?? 0) + 1);
    gamesByRound.set(pairing.roundOffset, (gamesByRound.get(pairing.roundOffset) ?? 0) + 1);

    let seen = teamsPerRound.get(pairing.roundOffset);
    if (!seen) {
      seen = new Set<string>();
      teamsPerRound.set(pairing.roundOffset, seen);
    }
    for (const team of [pairing.leftTeam, pairing.rightTeam]) {
      if (seen.has(team.name)) doubleBooked.push(`${team.name} in round offset ${pairing.roundOffset}`);
      seen.add(team.name);
    }
  }

  return {
    meetingsByPair,
    roundOffsets: [...gamesByRound.keys()].sort((a, b) => a - b),
    gamesByRound,
    doubleBooked,
  };
}

/** Every unordered pair of the given teams. */
function allPairs(teams: Team[]): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < teams.length - 1; i++) {
    for (let j = i + 1; j < teams.length; j++) pairs.push(pairKey(teams[i], teams[j]));
  }
  return pairs;
}

test('round and game counts follow from the number of teams', () => {
  // Even: n-1 rounds of n/2 games.
  expect(roundsPerRoundRobin(4)).toBe(3);
  expect(gamesPerRoundRobinRound(4)).toBe(2);
  // Odd: n rounds, because the bye has to come round to everybody, and one team sits out each round.
  expect(roundsPerRoundRobin(5)).toBe(5);
  expect(gamesPerRoundRobinRound(5)).toBe(2);
  expect(roundsNeededForRoundRobins(4, 4)).toBe(12);
  expect(roundsNeededForRoundRobins(9, 2)).toBe(18);
});

test('4 teams, single round robin: 3 rounds of 2, every pair once', () => {
  const teams = makeTeams(4);
  const result = analyze(generateRoundRobin(teams, 1));

  expect(result.roundOffsets).toEqual([0, 1, 2]);
  expect([...result.gamesByRound.values()]).toEqual([2, 2, 2]);
  expect(result.doubleBooked).toEqual([]);
  expect([...result.meetingsByPair.keys()].sort()).toEqual(allPairs(teams).sort());
  expect([...result.meetingsByPair.values()].every((count) => count === 1)).toBe(true);
});

test('4 teams, quadruple round robin: the shape Sched4TeamsQuadRR promises', () => {
  const teams = makeTeams(4);
  const pairings = generateRoundRobin(teams, 4);
  const result = analyze(pairings);

  // 12 rounds, 2 games each, 24 games total.
  expect(result.roundOffsets).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  expect([...result.gamesByRound.values()]).toEqual(Array(12).fill(2));
  expect(pairings).toHaveLength(24);
  // Every team plays once per round, so every team has 12 games.
  expect(result.doubleBooked).toEqual([]);
  for (const team of teams) {
    expect(pairings.filter((p) => p.leftTeam === team || p.rightTeam === team)).toHaveLength(12);
  }
  // Every pair meets exactly four times.
  expect([...result.meetingsByPair.keys()].sort()).toEqual(allPairs(teams).sort());
  expect([...result.meetingsByPair.values()]).toEqual([4, 4, 4, 4, 4, 4]);
});

test('repeated meetings alternate which team is on the left', () => {
  const teams = makeTeams(4);
  const pairings = generateRoundRobin(teams, 2);

  // Take one pair and check the two meetings are not oriented the same way. A director reading a
  // pairing sheet should not see the same team on the same side both times.
  const key = pairKey(teams[0], teams[1]);
  const meetings = pairings.filter((p) => pairKey(p.leftTeam, p.rightTeam) === key);
  expect(meetings).toHaveLength(2);
  expect(meetings[0].leftTeam).not.toBe(meetings[1].leftTeam);
});

describe('odd numbers of teams get byes rather than a broken schedule', () => {
  for (const numTeams of [5, 7, 9, 11]) {
    test(`${numTeams} teams, single round robin`, () => {
      const teams = makeTeams(numTeams);
      const result = analyze(generateRoundRobin(teams, 1));

      // n rounds, each with floor(n/2) games: exactly one team idle per round.
      expect(result.roundOffsets).toHaveLength(numTeams);
      expect([...result.gamesByRound.values()]).toEqual(Array(numTeams).fill(Math.floor(numTeams / 2)));
      expect(result.doubleBooked).toEqual([]);
      expect([...result.meetingsByPair.keys()].sort()).toEqual(allPairs(teams).sort());
      expect([...result.meetingsByPair.values()].every((count) => count === 1)).toBe(true);
      // Each team sits out exactly once across the cycle.
      for (const team of teams) {
        const games = generateRoundRobin(teams, 1).filter((p) => p.leftTeam === team || p.rightTeam === team);
        expect(games).toHaveLength(numTeams - 1);
      }
    });
  }
});

describe('even numbers of teams above four are no different', () => {
  for (const numTeams of [6, 8, 12, 16] as const) {
    test(`${numTeams} teams, double round robin`, () => {
      const teams = makeTeams(numTeams);
      const result = analyze(generateRoundRobin(teams, 2));

      expect(result.roundOffsets).toHaveLength(2 * (numTeams - 1));
      expect([...result.gamesByRound.values()].every((count) => count === numTeams / 2)).toBe(true);
      expect(result.doubleBooked).toEqual([]);
      expect([...result.meetingsByPair.values()].every((count) => count === 2)).toBe(true);
      expect(result.meetingsByPair.size).toBe((numTeams * (numTeams - 1)) / 2);
    });
  }
});

test('nothing is invented when there is nothing to schedule', () => {
  expect(generateRoundRobin(makeTeams(4), 0)).toEqual([]);
  expect(generateRoundRobin(makeTeams(1), 1)).toEqual([]);
  expect(generateRoundRobin([], 1)).toEqual([]);
  expect(roundsNeededForRoundRobins(4, 0)).toBe(0);
});
