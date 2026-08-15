import { expect, test } from 'vitest';
import { Sched30Teams10RoundsPlusF } from '../renderer/DataModel/Schedules/30-team';
import { Sched24Teams11Rounds2Phases5Prelim } from '../renderer/DataModel/Schedules/24-team';
import { Phase, PhaseTypes } from '../renderer/DataModel/Phase';
import { Match } from '../renderer/DataModel/Match';

/** A phase covering rounds 1-5, with a game in every round so any loss of one is visible. */
function phaseWithGamesInEveryRound(): Phase {
  const phase = new Phase(PhaseTypes.Prelim, 1, 5, '1');
  for (const round of phase.rounds) round.matches = [new Match()];
  return phase;
}

test('narrowing a round range from the start keeps the games in the rounds that remain', () => {
  const phase = phaseWithGamesInEveryRound();

  phase.setRoundRange(2, 5);

  expect(phase.rounds.map((round) => round.number)).toEqual([2, 3, 4, 5]);
  // Round 1 is gone because it was asked to be. Rounds 2 through 5 are the same round objects, with
  // the same games in them - not blank rounds recreated in their place.
  expect(phase.rounds.every((round) => round.matches.length === 1)).toBe(true);
});

test('widening a round range adds the new rounds and disturbs none of the existing ones', () => {
  const phase = phaseWithGamesInEveryRound();

  phase.setRoundRange(1, 7);

  expect(phase.rounds.map((round) => round.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  expect(phase.rounds.slice(0, 5).every((round) => round.matches.length === 1)).toBe(true);
  expect(phase.rounds.slice(5).every((round) => round.matches.length === 0)).toBe(true);
});

test('getTopWildCardSeed01', () => {
  const prelims = Sched30Teams10RoundsPlusF.constructPhases()[0];

  expect(prelims.getTopWildCardSeed()).toBe(11);
});

test('getTopWildCardSeed02', () => {
  const prelims = Sched24Teams11Rounds2Phases5Prelim.constructPhases()[0];

  expect(prelims.getTopWildCardSeed()).toBe(0);
});
