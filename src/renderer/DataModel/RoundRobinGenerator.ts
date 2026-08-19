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

/**
 * One meeting that still has to be given a round, in the order its teams should be paired.
 *
 * A list of these is what remains of a pool's round robin once games carried over from an earlier
 * phase have been taken out of it. Unlike a complete round robin, the leftovers have no regular shape
 * - a pool of six that has already played two internal triangles needs nine games among six teams,
 * which the circle method has no way to express - so they are placed by `packMeetingsIntoRounds`
 * rather than derived.
 */
export interface IUnscheduledMeeting {
  leftTeam: Team;
  rightTeam: Team;
}

/**
 * Place every meeting into one of `numRounds` rounds, with no team playing twice in a round.
 *
 * This is graph edge colouring - teams are vertices, meetings are edges, a round is a colour class -
 * and plain greed is not good enough for it. The nine cross-pool games a six-team carryover bracket
 * owes form a 3-regular bipartite graph that fits in exactly three rounds, but a round-at-a-time
 * greedy filling can take a first round that leaves two games with nowhere to go. Since it is exactly
 * the shipped schedules that are tight, the search has to be able to take a choice back.
 *
 * So: a depth-first assignment, taking the meeting with the fewest rounds still open to it first and
 * trying that meeting's emptiest round first. The first ordering finds the dead ends early, the
 * second spreads games across the phase instead of stacking them at the front. Repeated meetings of
 * the same pair are made to take rounds in ascending order, which costs nothing - any schedule can be
 * relabelled that way - and removes the identical branches that would otherwise be explored once per
 * permutation of them.
 *
 * Returns undefined when no assignment exists, and also when the search runs past its step budget -
 * a caller has to tell the director either way, and neither answer may be a schedule with games
 * missing from it.
 */
export function packMeetingsIntoRounds(
  meetings: IUnscheduledMeeting[],
  numRounds: number,
): IRoundRobinPairing[] | undefined {
  if (meetings.length === 0) return [];
  if (numRounds < 1) return undefined;

  const assignedRound: number[] = meetings.map(() => -1);
  const previousCopy = indexOfPreviousCopy(meetings);
  const busyTeams: Set<Team>[] = [];
  const gamesInRound: number[] = [];
  for (let round = 0; round < numRounds; round++) {
    busyTeams.push(new Set<Team>());
    gamesInRound.push(0);
  }

  /** Rounds this meeting could still go in, respecting the ascending order of repeated meetings. */
  const openRounds = (index: number): number[] => {
    const { leftTeam, rightTeam } = meetings[index];
    const earliest = previousCopy[index] === -1 ? 0 : assignedRound[previousCopy[index]] + 1;
    const open: number[] = [];
    for (let round = earliest; round < numRounds; round++) {
      if (busyTeams[round].has(leftTeam) || busyTeams[round].has(rightTeam)) continue;
      open.push(round);
    }
    return open;
  };

  // A budget rather than an unbounded search. Every real schedule is found in about as many steps as
  // it has games; a pathological one must not hang the application while a director waits.
  let stepsLeft = 20000;

  const place = (stillToPlace: number): boolean => {
    if (stillToPlace === 0) return true;
    if (stepsLeft-- <= 0) return false;

    // Most constrained first. Only meetings whose earlier copies are already placed are considered,
    // which is what keeps the repeats in ascending order; there is always at least one.
    let chosen = -1;
    let chosenRounds: number[] = [];
    for (let index = 0; index < meetings.length; index++) {
      if (assignedRound[index] !== -1) continue;
      if (previousCopy[index] !== -1 && assignedRound[previousCopy[index]] === -1) continue;
      const rounds = openRounds(index);
      if (rounds.length === 0) return false;
      if (chosen === -1 || rounds.length < chosenRounds.length) {
        chosen = index;
        chosenRounds = rounds;
      }
      if (chosenRounds.length === 1) break;
    }
    if (chosen === -1) return false;

    const { leftTeam, rightTeam } = meetings[chosen];
    chosenRounds.sort((a, b) => gamesInRound[a] - gamesInRound[b] || a - b);
    for (const round of chosenRounds) {
      assignedRound[chosen] = round;
      busyTeams[round].add(leftTeam);
      busyTeams[round].add(rightTeam);
      gamesInRound[round]++;

      if (place(stillToPlace - 1)) return true;

      assignedRound[chosen] = -1;
      busyTeams[round].delete(leftTeam);
      busyTeams[round].delete(rightTeam);
      gamesInRound[round]--;
    }
    return false;
  };

  if (!place(meetings.length)) return undefined;

  return meetings
    .map((meeting, index) => ({ roundOffset: assignedRound[index], ...meeting }))
    .sort((a, b) => a.roundOffset - b.roundOffset);
}

/**
 * For each meeting, the index of the previous meeting of the same pair, or -1 if it is the first.
 *
 * Only repeated round robins produce these. They are the reason a naive search is slow: two copies of
 * one pair can be swapped between their rounds without changing the schedule at all.
 */
function indexOfPreviousCopy(meetings: IUnscheduledMeeting[]): number[] {
  const lastSeen = new Map<Team, Map<Team, number>>();
  return meetings.map((meeting, index) => {
    // Keyed both ways round, because the two copies of one pair are deliberately mirrored.
    const previous = lastSeen.get(meeting.leftTeam)?.get(meeting.rightTeam) ?? -1;
    for (const [one, other] of [
      [meeting.leftTeam, meeting.rightTeam],
      [meeting.rightTeam, meeting.leftTeam],
    ]) {
      let forOne = lastSeen.get(one);
      if (!forOne) {
        forOne = new Map<Team, number>();
        lastSeen.set(one, forOne);
      }
      forOne.set(other, index);
    }
    return previous;
  });
}

/** How many games each team still has left to place. */
function countDegrees(meetings: IUnscheduledMeeting[]): Map<Team, number> {
  const degrees = new Map<Team, number>();
  for (const meeting of meetings) {
    degrees.set(meeting.leftTeam, (degrees.get(meeting.leftTeam) ?? 0) + 1);
    degrees.set(meeting.rightTeam, (degrees.get(meeting.rightTeam) ?? 0) + 1);
  }
  return degrees;
}

/**
 * The fewest rounds this set of meetings could possibly take.
 *
 * Two independent floors: a team with k games left needs k rounds, and m games among n teams need at
 * least m / floor(n/2) rounds. Used only to explain a failure to the director - the packer itself is
 * the authority on whether a schedule exists.
 */
export function minimumRoundsForMeetings(meetings: IUnscheduledMeeting[]): number {
  if (meetings.length === 0) return 0;
  const degrees = countDegrees(meetings);
  const maxDegree = Math.max(...degrees.values());
  const perRound = Math.max(1, Math.floor(degrees.size / 2));
  return Math.max(maxDegree, Math.ceil(meetings.length / perRound));
}
