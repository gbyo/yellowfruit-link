/**
 * What a QBJ file's rounds, phases and matches turn into.
 *
 * These are the cases where reading a file slightly wrongly costs match data rather than producing a
 * visible error: a round whose name is not a number, a phase with no rounds yet, and a scheduled game
 * that has not been played.
 */
import { expect, test } from 'vitest';
import FileParser, { roundNumberFromName } from '../renderer/DataModel/FileParsing';
import { IIndeterminateQbj } from '../renderer/DataModel/Interfaces';
import { makeTestTournament } from './QbtcpFixtures';

function parserFor() {
  const tournament = makeTestTournament();
  const parser = new FileParser({}, tournament);
  return { parser, tournament };
}

/** A parser set up the way importing games into a known stage sets one up: teams matched by name. */
function importParserFor() {
  const { parser, tournament } = parserFor();
  [parser.importPhase] = tournament.phases;
  return { parser, tournament };
}

test('a round name is a number only when the whole name is one', () => {
  expect(roundNumberFromName('4')).toBe(4);
  // Tiebreaker and finals rounds are ordered with fractional numbers, so these stay numeric.
  expect(roundNumberFromName('4.5')).toBe(4.5);
  // "3A" is a round called 3A, not round 3. Filing its games into round 3 puts them in the wrong round.
  expect(Number.isNaN(roundNumberFromName('3A'))).toBe(true);
  expect(Number.isNaN(roundNumberFromName('Final'))).toBe(true);
  expect(Number.isNaN(roundNumberFromName(''))).toBe(true);
  expect(Number.isNaN(roundNumberFromName(undefined))).toBe(true);
  expect(Number.isNaN(roundNumberFromName(true))).toBe(true);
  expect(Number.isNaN(roundNumberFromName([5]))).toBe(true);
});

test('a round with a non-numeric name keeps its packet and its games', () => {
  const { parser } = importParserFor();
  const round = parser.parseRound(
    {
      type: 'Round',
      name: 'Tiebreaker',
      packets: [{ type: 'Packet', name: 'Spare 1' }],
      matches: [
        {
          type: 'Match',
          tossupsRead: 20,
          matchTeams: [
            { team: { name: 'Ninety Six' }, points: 300 },
            { team: { name: 'Greenwood' }, points: 200 },
          ],
        },
      ],
    } as unknown as IIndeterminateQbj,
    7,
  );

  expect(round).not.toBeNull();
  expect(round?.name).toBe('Tiebreaker');
  expect(round?.number).toBe(7);
  expect(round?.packet.name).toBe('Spare 1');
  expect(round?.matches).toHaveLength(1);
});

test('a YFT round missing its stored number falls back to file order', () => {
  const { parser } = parserFor();
  const round = parser.parseRound(
    { type: 'Round', name: 'Final', YfData: {}, matches: [] } as unknown as IIndeterminateQbj,
    9,
  );

  expect(round?.number).toBe(9);
  expect(round?.name).toBe('Final');
});

test('non-string round names are not stored in the Round model', () => {
  const { parser } = parserFor();
  const malformedName = parser.parseRound(
    { type: 'Round', name: true, matches: [] } as unknown as IIndeterminateQbj,
    6,
  );
  const malformedYftName = parser.parseRound(
    {
      type: 'Round',
      name: '4',
      YfData: { number: 4, nonNumericName: [5] },
      matches: [],
    } as unknown as IIndeterminateQbj,
    6,
  );

  expect(malformedName?.number).toBe(6);
  expect(malformedName?.name).toBe('6');
  expect(malformedYftName?.number).toBe(4);
  expect(malformedYftName?.name).toBe('4');
});

test('a round named with a numeric prefix is not treated as that number', () => {
  const { parser } = parserFor();
  const round = parser.parseRound({ type: 'Round', name: '3A', matches: [] } as unknown as IIndeterminateQbj, 9);

  expect(round?.name).toBe('3A');
  expect(round?.number).toBe(9);
});

test('a match that omits the optional carry-over phases list is read rather than refused', () => {
  const { parser } = parserFor();
  expect(parser.parseMatchCarryoverPhasesStart(undefined as never)).toEqual([]);
});

test('a phase that lists no rounds yet is parsed instead of crashing', () => {
  const { parser } = parserFor();
  const phase = parser.parsePhase(
    { type: 'Phase', name: 'Playoffs' } as unknown as IIndeterminateQbj,
    1 as never,
    8,
    '2',
  );

  expect(phase?.name).toBe('Playoffs');
  expect(phase?.rounds).toHaveLength(1);
  expect(phase?.rounds[0].number).toBe(8);
});

test('an unplayed scheduled game is not given a regulation tossup count', () => {
  const { parser, tournament } = importParserFor();
  expect(tournament.scoringRules.timed).toBe(false);

  // The shape the assignment builder emits: two teams named, and nothing about what happened.
  const unplayed = parser.parseMatch({
    type: 'Match',
    id: 'Match_scheduled',
    matchTeams: [{ team: { name: 'Ninety Six' } }, { team: { name: 'Greenwood' } }],
  } as unknown as IIndeterminateQbj);
  expect(unplayed?.tossupsRead).toBeUndefined();

  // A played game that simply omits the count still gets it, which is what the default is for.
  const played = parser.parseMatch({
    type: 'Match',
    id: 'Match_played',
    matchTeams: [
      { team: { name: 'Ninety Six' }, points: 300 },
      { team: { name: 'Greenwood' }, points: 200 },
    ],
  } as unknown as IIndeterminateQbj);
  expect(played?.tossupsRead).toBe(tournament.scoringRules.regulationTossupCount);
});
