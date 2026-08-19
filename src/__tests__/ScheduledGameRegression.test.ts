/**
 * The original worked example, re-checked after the carryover, rebracketing, rename and deletion work.
 *
 * Four teams playing a quadruple round robin over twelve rounds: the case the scheduled-game feature
 * was built around, and the one most likely to be broken by a change made for a twelve-team playoff
 * bracket. Everything here was true before this pass and has to still be true after it, end to end -
 * generated, saved, reopened, offered to a room, and completed by an accepted result.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { camelCaseToSnakeCase, snakeCaseToCamelCase } from '../renderer/DataModel/CaseConversion';
import FileParser from '../renderer/DataModel/FileParsing';
import { IQbjWholeFile } from '../renderer/DataModel/Interfaces';
import { Match } from '../renderer/DataModel/Match';
import { Sched4TeamsQuadRR } from '../renderer/DataModel/Schedules/4-team';
import Tournament, { IQbjTournament } from '../renderer/DataModel/Tournament';
import { collectRefTargets, findTournamentObject } from '../renderer/DataModel/QbjUtils2';
import { TestTournamentManager, installRendererGlobals, restoreRendererGlobals } from './TournamentManagerFixtures';
import { bigCatNames, makeTemplateTournament, roundNumbered, teamNamed } from './ScheduledGameFixtures';

beforeEach(installRendererGlobals);
afterEach(restoreRendererGlobals);

function roundTrip(tournament: Tournament): Tournament {
  tournament.appVersion = '4.0.18';
  const wholeFile: IQbjWholeFile = { version: '2.1.1', objects: [tournament.toFileObject(false, true)] };
  camelCaseToSnakeCase(wholeFile);
  const fileObj = JSON.parse(JSON.stringify(wholeFile)) as IQbjWholeFile;
  snakeCaseToCamelCase(fileObj);
  const tournamentObj = findTournamentObject(fileObj.objects);
  if (!tournamentObj) throw new Error('serialized file has no Tournament object');
  const parser = new FileParser(collectRefTargets(fileObj.objects));
  const reopened = parser.parseTournament(tournamentObj as IQbjTournament);
  if (!reopened) throw new Error('failed to reopen the serialized tournament');
  return reopened;
}

/** The full shape of the worked example: rounds, games per round, and meetings per pair. */
function assertQuadRoundRobinShape(tournament: Tournament) {
  const [phase] = tournament.phases;
  expect(phase.rounds).toHaveLength(12);
  expect(tournament.getAllScheduledGames()).toHaveLength(24);

  const meetings = new Map<string, number>();
  for (const round of phase.rounds) {
    expect(round.scheduledGames).toHaveLength(2);
    // All four teams appear, none of them twice: every team plays exactly once per round.
    const names = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(names.slice().sort()).toEqual([...bigCatNames].sort());
    for (const game of round.scheduledGames) {
      const key = [game.leftTeam.name, game.rightTeam.name].sort().join('|');
      meetings.set(key, (meetings.get(key) ?? 0) + 1);
    }
  }
  // All six unordered pairs, each met four times.
  expect(meetings.size).toBe(6);
  expect([...meetings.values()]).toEqual([4, 4, 4, 4, 4, 4]);
}

test('the four-team quadruple round robin is still generated exactly as specified', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  assertQuadRoundRobinShape(tournament);
});

test('scheduling still creates no games and leaves the rules editable', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);

  tournament.calcHasMatchData();

  expect(tournament.phases[0].getAllMatches()).toHaveLength(0);
  expect(tournament.hasMatchData).toBe(false);
  expect(tournament.numberOfPhasesWithStats()).toBe(0);
});

test('the schedule survives a save and reopen with its identities intact', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const before = tournament
    .getAllScheduledGames()
    .map((game) => ({ id: game.id, name: game.displayName(), poolName: game.poolName, generated: game.generated }));

  const reopened = roundTrip(tournament);

  expect(
    reopened
      .getAllScheduledGames()
      .map((game) => ({ id: game.id, name: game.displayName(), poolName: game.poolName, generated: game.generated })),
  ).toEqual(before);
  assertQuadRoundRobinShape(reopened);
  reopened.calcHasMatchData();
  expect(reopened.hasMatchData).toBe(false);
});

test('Rooms still offers every unplayed, unassigned pairing', () => {
  const manager = new TestTournamentManager();
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  manager.loadTournament(tournament);

  const eligible = manager.roomsManager.eligibleScheduledGames(tournament, 'room-1');

  expect(eligible).toHaveLength(24);
  // Earliest round first, so the game offered by default is the next one to be played.
  expect(eligible[0].round.number).toBe(1);
  expect(eligible[eligible.length - 1].round.number).toBe(12);
});

test('an accepted result completes exactly one pairing', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const lion = teamNamed(tournament, 'Lion');
  const jaguar = teamNamed(tournament, 'Jaguar');
  const meetings = tournament.phases[0].rounds
    .flatMap((round) => round.scheduledGames.map((game) => ({ round, game })))
    .filter((entry) => entry.game.includesTeam(lion) && entry.game.includesTeam(jaguar));
  expect(meetings).toHaveLength(4);

  const [first] = meetings;
  const match = new Match(lion, jaguar, tournament.scoringRules.answerTypes);
  match.scheduledGameId = first.game.id;
  first.round.addMatch(match);

  expect(first.round.scheduledGameIsComplete(first.game)).toBe(true);
  for (const other of meetings.slice(1)) {
    expect(other.round.scheduledGameIsComplete(other.game)).toBe(false);
  }
  // Still 24 pairings: completing one does not remove it, it links it to the game that was entered.
  expect(tournament.getAllScheduledGames()).toHaveLength(24);
});

test('a pairing stays editable until a result exists for it', () => {
  const manager = new TestTournamentManager();
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  manager.loadTournament(tournament);
  const round = roundNumbered(tournament, 3);
  const [game] = round.scheduledGames;

  expect(manager.scheduledGameLockReason(game, round)).toBeUndefined();

  const match = new Match(game.leftTeam, game.rightTeam, tournament.scoringRules.answerTypes);
  match.scheduledGameId = game.id;
  round.addMatch(match);

  expect(manager.scheduledGameLockReason(game, round)).toContain('already been played');
});
