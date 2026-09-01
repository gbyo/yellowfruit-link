import { expect, test } from 'vitest';
import { camelCaseToSnakeCase, snakeCaseToCamelCase } from '../renderer/DataModel/CaseConversion';
import FileParser from '../renderer/DataModel/FileParsing';
import { IQbjWholeFile } from '../renderer/DataModel/Interfaces';
import { collectRefTargets, findTournamentObject } from '../renderer/DataModel/QbjUtils2';
import {
  defaultRoomProcedure,
  normalizeRoomProcedure,
  resolveHandoffInstruction,
  resolveRoomProcedure,
} from '../renderer/DataModel/RoomProcedure';
import Tournament from '../renderer/DataModel/Tournament';
import { makeTestTournament, roundNumbered } from './QbtcpFixtures';

function roundTrip(tournament: Tournament): Tournament {
  const wholeFile: IQbjWholeFile = { version: '2.1.1', objects: [tournament.toFileObject(false, true)] };
  camelCaseToSnakeCase(wholeFile);
  const reopenedFile = JSON.parse(JSON.stringify(wholeFile)) as IQbjWholeFile;
  snakeCaseToCamelCase(reopenedFile);
  const tournamentObject = findTournamentObject(reopenedFile.objects);
  if (!tournamentObject) throw new Error('serialized file has no Tournament object');
  return new FileParser(collectRefTargets(reopenedFile.objects)).parseTournament(tournamentObject);
}

test('missing or malformed procedure data resolves to the neutral v3 default', () => {
  expect(normalizeRoomProcedure(undefined)).toEqual(defaultRoomProcedure());
  expect(
    normalizeRoomProcedure({
      version: 1,
      halves: false,
      breaks: [{ afterTossup: 8 }, { afterTossup: 8 }, { afterTossup: 0 }],
      timeoutsPerTeam: -2,
    }),
  ).toEqual({ version: 3, halves: true, breaks: [{ afterTossup: 8 }], timeoutsPerTeam: 0 });
});

test('tournament defaults and round overrides survive a YFT save and reopen', () => {
  const tournament = makeTestTournament();
  tournament.roomProcedure = {
    version: 3,
    halves: true,
    breaks: [{ afterTossup: 10, label: 'Mid-game' }],
    halfLengthMinutes: 20,
    timeoutsPerTeam: 2,
    timeoutDurationSeconds: 60,
    protestCheckpoints: 'phase-boundaries',
    substitutionPolicy: 'any-boundary',
  };
  tournament.handoffInstruction = 'Pass the scoresheet to the next director.';
  const round = roundNumbered(tournament, 4);
  round.roomProcedure = { version: 3, halves: false, timeoutsPerTeam: 1 };
  round.handoffInstruction = 'Use the printed packet for this round.';

  const reopened = roundTrip(tournament);
  const reopenedRound = roundNumbered(reopened, 4);

  expect(reopened.roomProcedure).toEqual(tournament.roomProcedure);
  expect(reopened.handoffInstruction).toBe(tournament.handoffInstruction);
  expect(reopenedRound.roomProcedure).toEqual(round.roomProcedure);
  expect(reopenedRound.handoffInstruction).toBe(round.handoffInstruction);
  expect(reopened.roomProcedureForRound(reopenedRound)).toEqual(round.roomProcedure);
  expect(reopened.handoffInstructionForRound(reopenedRound)).toBe(round.handoffInstruction);
});

test('undefined round overrides inherit tournament procedure and handoff', () => {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 2);
  tournament.handoffInstruction = 'Tournament handoff';

  expect(resolveRoomProcedure(tournament.roomProcedure, round.roomProcedure)).toEqual(tournament.roomProcedure);
  expect(resolveHandoffInstruction(tournament.handoffInstruction, round.handoffInstruction)).toBe('Tournament handoff');
});
