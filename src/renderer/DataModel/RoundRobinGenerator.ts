/**
 * A generic round-robin pairing generator.
 *
 * Nothing here knows how many teams it is given. The four-team schedules that ship with YellowFruit
 * are just the n = 4 case; a nine-team pool with a bye and a twenty-four-team pool go through the
 * same code, which is what stops "single round robin" meaning something subtly different at one size
 * than at another.
 *
 * # The algorithm
 *
 * The circle method. Teams are laid out in a ring, the first position is held fixed, the rest rotate
 * by one each round, and each round pairs position i against position n-1-i. For an even number of
 * teams that produces n-1 rounds of n/2 games covering every unordered pair exactly once. For an odd
 * number, one bye slot is added to make the count even: n rounds, floor(n/2) games each, and exactly
 * one team idle per round.
 *
 * # Repeated round robins
 *
 * A double or quadruple round robin is the same cycle run again on the rounds that follow, with
 * left/right swapped on alternate cycles. Alternating matters to a director: the second meeting of
 * two teams should not put the same team on the same side of the pairing sheet again, and doing it
 * here means every schedule gets it rather than only the ones somebody remembered to hand-write.
 */
import { Team } from './Team';

/** One pairing, and which round of the cycle it belongs to. */
export interface IRoundRobinPairing {
  /** 0-indexed offset from the first round of the schedule. */
  roundOffset: number;
  leftTeam: Team;
  rightTeam: Team;
}

/**
 * How many rounds one complete round robin takes for this many teams.
 *
 * Even: n-1. Odd: n, because the bye has to come round to everybody.
 */
export function roundsPerRoundRobin(numTeams: number): number {
  if (numTeams < 2) return 0;
  return numTeams % 2 === 0 ? numTeams - 1 : numTeams;
}

/** How many games are played simultaneously in one round of a round robin of this size. */
export function gamesPerRoundRobinRound(numTeams: number): number {
  return Math.floor(numTeams / 2);
}

/** Total rounds needed for the requested number of complete cycles. */
export function roundsNeededForRoundRobins(numTeams: number, numRoundRobins: number): number {
  if (numRoundRobins < 1) return 0;
  return roundsPerRoundRobin(numTeams) * numRoundRobins;
}

/**
 * Generate the pairings for one or more complete round robins among the given teams.
 *
 * The team order is the caller's: for a pool it is the pool's own team order, which is seeded order
 * for a template schedule. Round offsets start at 0 and run to
 * `roundsNeededForRoundRobins(teams.length, numRoundRobins) - 1`.
 *
 * Returns an empty list when there is nothing to schedule (fewer than two teams, or no cycles asked
 * for) rather than inventing a degenerate schedule.
 */
export function generateRoundRobin(teams: Team[], numRoundRobins: number = 1): IRoundRobinPairing[] {
  if (teams.length < 2 || numRoundRobins < 1) return [];

  const cycle = oneCycle(teams);
  const roundsInCycle = roundsPerRoundRobin(teams.length);
  const pairings: IRoundRobinPairing[] = [];

  for (let cycleNo = 0; cycleNo < numRoundRobins; cycleNo++) {
    // Every second cycle mirrors the pairing, so two teams that meet repeatedly alternate sides.
    const mirrored = cycleNo % 2 === 1;
    for (const entry of cycle) {
      pairings.push({
        roundOffset: cycleNo * roundsInCycle + entry.roundOffset,
        leftTeam: mirrored ? entry.rightTeam : entry.leftTeam,
        rightTeam: mirrored ? entry.leftTeam : entry.rightTeam,
      });
    }
  }
  return pairings;
}

/** The pairings of a single complete round robin, by the circle method. */
function oneCycle(teams: Team[]): IRoundRobinPairing[] {
  // A `null` slot is the bye. With an odd number of teams it makes the ring even, and the team drawn
  // against it simply does not play that round.
  const slots: (Team | null)[] = teams.slice();
  if (slots.length % 2 === 1) slots.push(null);

  const ringSize = slots.length;
  const numRounds = ringSize - 1;
  const gamesPerRound = ringSize / 2;
  const pairings: IRoundRobinPairing[] = [];

  for (let roundOffset = 0; roundOffset < numRounds; roundOffset++) {
    for (let i = 0; i < gamesPerRound; i++) {
      const left = slots[i];
      const right = slots[ringSize - 1 - i];
      // One of them is the bye. Nothing is scheduled, which is exactly what a bye is.
      if (left === null || right === null) continue;
      // Flip alternate pairs of the ring so one team does not sit on the left of every game it plays.
      if (i % 2 === 0) pairings.push({ roundOffset, leftTeam: left, rightTeam: right });
      else pairings.push({ roundOffset, leftTeam: right, rightTeam: left });
    }
    rotateRing(slots);
  }
  return pairings;
}

/** Hold position 0 and rotate the rest of the ring forward by one. Mutates the array. */
function rotateRing(slots: (Team | null)[]): void {
  if (slots.length < 3) return;
  const last = slots.pop() as Team | null;
  slots.splice(1, 0, last);
}
