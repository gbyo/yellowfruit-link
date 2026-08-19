/**
 * Scheduled games across a save and a reopen.
 *
 * The round trip is done the way the application does it - the same serializer, the same case
 * conversion, real JSON in between, the same parser - because the failures worth catching here are the
 * ones that only appear when all of those run: a key the conversion table rewrites, a team reference
 * that resolves to nothing, an id regenerated on the way back in.
 *
 * The identity assertions matter most. A pairing whose id changed when the file was reopened would
 * look correct on screen and would have quietly lost its link to the game a room already played.
 */
import { expect, test } from 'vitest';
import { camelCaseToSnakeCase, snakeCaseToCamelCase } from '../renderer/DataModel/CaseConversion';
import FileParser from '../renderer/DataModel/FileParsing';
import { IQbjWholeFile } from '../renderer/DataModel/Interfaces';
import { Match } from '../renderer/DataModel/Match';
import { Sched4TeamsQuadRR, Sched4TeamsSingleRR } from '../renderer/DataModel/Schedules/4-team';
import Tournament, { IQbjTournament } from '../renderer/DataModel/Tournament';
import { collectRefTargets, findTournamentObject } from '../renderer/DataModel/QbjUtils2';
import {
  applyCustomTwelveRoundSchedule,
  customTwelveRoundSchedule,
  makeTemplateTournament,
  pairingNames,
  roundNumbered,
} from './ScheduledGameFixtures';

/** Serialize a tournament exactly as saving a .yft does, and return the JSON text. */
function writeYft(tournament: Tournament): string {
  tournament.appVersion = '4.0.18';
  const wholeFile: IQbjWholeFile = { version: '2.1.1', objects: [tournament.toFileObject(false, true)] };
  camelCaseToSnakeCase(wholeFile);
  return JSON.stringify(wholeFile);
}

/** Parse .yft text exactly as opening one does. */
function readYft(text: string): Tournament {
  const fileObj = JSON.parse(text) as IQbjWholeFile;
  snakeCaseToCamelCase(fileObj);
  const tournamentObj = findTournamentObject(fileObj.objects);
  if (!tournamentObj) throw new Error('serialized file has no Tournament object');
  const parser = new FileParser(collectRefTargets(fileObj.objects));
  const reopened = parser.parseTournament(tournamentObj as IQbjTournament);
  if (!reopened) throw new Error('failed to reopen the serialized tournament');
  return reopened;
}

function roundTrip(tournament: Tournament): Tournament {
  return readYft(writeYft(tournament));
}

test('a generated schedule survives a save and a reopen, ids included', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const before = tournament.phases[0].rounds.map((round) =>
    round.scheduledGames.map((game) => ({
      id: game.id,
      left: game.leftTeam.name,
      right: game.rightTeam.name,
      poolName: game.poolName,
      generated: game.generated,
    })),
  );

  const reopened = roundTrip(tournament);

  const after = reopened.phases[0].rounds.map((round) =>
    round.scheduledGames.map((game) => ({
      id: game.id,
      left: game.leftTeam.name,
      right: game.rightTeam.name,
      poolName: game.poolName,
      generated: game.generated,
    })),
  );
  expect(after).toEqual(before);
  expect(reopened.getAllScheduledGames()).toHaveLength(24);
});

test('reopened pairings point at the reopened tournament’s own team objects', () => {
  const reopened = roundTrip(makeTemplateTournament(Sched4TeamsSingleRR));
  const allTeams = reopened.getListOfAllTeams();

  for (const game of reopened.getAllScheduledGames()) {
    // Not a copy of a team that happens to share a name: the same object the rest of the tournament
    // uses, or pool membership and Rooms assignment would silently disagree with the schedule.
    expect(allTeams).toContain(game.leftTeam);
    expect(allTeams).toContain(game.rightTeam);
  }
});

test('a hand-built 12-round schedule is represented and reopened exactly', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const phase = applyCustomTwelveRoundSchedule(tournament);
  const expectedByRound = customTwelveRoundSchedule.map((pairings) =>
    pairings.map(([left, right]) => `${left} vs ${right}`),
  );
  expect(phase.rounds.map((round) => pairingNames(round))).toEqual(expectedByRound);
  const idsBefore = tournament.getAllScheduledGames().map((game) => game.id);

  const reopened = roundTrip(tournament);

  // The exact round ordering the director chose, including left/right within each pairing.
  expect(reopened.phases[0].rounds.map((round) => pairingNames(round))).toEqual(expectedByRound);
  expect(reopened.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
  // Hand-made, so a later reseeding will not replace them.
  expect(reopened.getAllScheduledGames().every((game) => !game.generated)).toBe(true);
});

test('scheduled games do not become entered games', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const text = writeYft(tournament);

  // Not one Match in the file, in any round, even though 24 games are scheduled.
  const fileObj = JSON.parse(text) as { objects: unknown[] };
  expect(text).not.toContain('"type":"Match"');
  expect(JSON.stringify(fileObj)).toContain('scheduledGames');

  const reopened = readYft(text);
  expect(reopened.phases[0].rounds.every((round) => round.matches.length === 0)).toBe(true);
  expect(reopened.hasMatchData).toBe(false);
});

test('a QBJ-only export carries no scheduled games at all', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const qbjOnly = { version: '2.1.1', objects: [tournament.toFileObject(true, true)] };
  camelCaseToSnakeCase(qbjOnly);
  const text = JSON.stringify(qbjOnly);

  // A QBJ consumer reading this file must not be told that 24 games were played. YfData is where
  // scheduled games live, and qbj-only serialization omits YfData entirely.
  expect(text).not.toContain('scheduledGames');
  expect(text).not.toContain('scheduled_games');
  expect(text).not.toContain('YfData');
  const rounds = ((qbjOnly.objects[0] as { phases: { rounds: { matches: unknown[] }[] }[] }).phases ?? []).flatMap(
    (phase) => phase.rounds,
  );
  expect(rounds).toHaveLength(12);
  expect(rounds.every((round) => round.matches.length === 0)).toBe(true);
});

test('a .yft written before scheduled games existed still opens', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const parsed = JSON.parse(writeYft(tournament)) as {
    objects: { phases: { rounds: { YfData: { scheduledGames?: unknown } }[] }[] }[];
  };
  // Strip the field, reproducing a file from a build that did not have it.
  for (const phase of parsed.objects[0].phases) {
    for (const round of phase.rounds) {
      delete round.YfData.scheduledGames;
      expect(Object.keys(round.YfData)).not.toContain('scheduledGames');
    }
  }

  const reopened = readYft(JSON.stringify(parsed));

  expect(reopened.getListOfAllTeams()).toHaveLength(4);
  expect(reopened.phases[0].rounds).toHaveLength(3);
  expect(reopened.anyScheduledGamesExist()).toBe(false);
});

test('scheduled-game keys survive the case conversion unrewritten', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const parsed = JSON.parse(writeYft(tournament)) as {
    objects: { phases: { rounds: { YfData: { scheduledGames?: Record<string, unknown>[] } }[] }[] }[];
  };
  const [game] = parsed.objects[0].phases[0].rounds[0].YfData.scheduledGames ?? [];

  // The conversion between YellowFruit's camelCase and QBJ's snake_case works from a fixed table of
  // names. None of these are in it, so they are written and read exactly as spelled - which is what
  // the parser relies on, and is worth asserting rather than assuming.
  expect(Object.keys(game).sort()).toEqual(['generated', 'id', 'leftTeam', 'poolName', 'rightTeam']);
  expect(game.left_team).toBeUndefined();
});

test('a pairing naming a team the file no longer has is dropped, not thrown', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const parsed = JSON.parse(writeYft(tournament)) as {
    objects: { phases: { rounds: { YfData: { scheduledGames?: { leftTeam: { $ref: string } }[] } }[] }[] }[];
  };
  const firstRound = parsed.objects[0].phases[0].rounds[0];
  const games = firstRound.YfData.scheduledGames ?? [];
  expect(games).toHaveLength(2);
  games[0].leftTeam = { $ref: 'Team_A Team That Left' };

  const reopened = readYft(JSON.stringify(parsed));

  // The file opens, the other five pairings are intact, and the unresolvable one is simply absent.
  expect(reopened.getAllScheduledGames()).toHaveLength(5);
  expect(roundNumbered(reopened, 1).scheduledGames).toHaveLength(1);
});

test('completion survives a save and a reopen', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [scheduled] = round.scheduledGames;
  const match = new Match(scheduled.leftTeam, scheduled.rightTeam, tournament.scoringRules.answerTypes);
  match.leftTeam.points = 310;
  match.rightTeam.points = 180;
  match.tossupsRead = 20;
  match.scheduledGameId = scheduled.id;
  round.addMatch(match);
  expect(round.scheduledGameIsComplete(scheduled)).toBe(true);

  const reopened = roundTrip(tournament);

  const reopenedRound = roundNumbered(reopened, 1);
  const reopenedScheduled = reopenedRound.findScheduledGameById(scheduled.id);
  expect(reopenedScheduled).toBeDefined();
  expect(reopenedRound.matches).toHaveLength(1);
  expect(reopenedRound.matches[0].scheduledGameId).toBe(scheduled.id);
  expect(reopenedRound.scheduledGameIsComplete(reopenedScheduled!)).toBe(true);
  // The other 23 are still waiting, including the three other meetings of the same pair - which is
  // the case pair-matching would have got wrong.
  const completedCount = reopened.phases[0].rounds.reduce((sum, rd) => sum + rd.countCompletedScheduledGames(), 0);
  expect(completedCount).toBe(1);
});
