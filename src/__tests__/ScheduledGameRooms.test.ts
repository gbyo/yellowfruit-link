/**
 * Sending a scheduled game to a room, and recognising the result when it comes back.
 *
 * The claim being tested is that there is exactly one identity in this path. The pairing's id is what
 * the assignment publishes as its QBJ `Match.id`, what the server stores for the room, what a result
 * carries back over the network, and what the file a scorekeeper carries across the building carries
 * too - so the two routes resolve to the same pairing rather than to two games that happen to have the
 * same teams in them.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { snakeCaseToCamelCase } from '../renderer/DataModel/CaseConversion';
import FileParser from '../renderer/DataModel/FileParsing';
import { IIndeterminateQbj, IQbjObject } from '../renderer/DataModel/Interfaces';
import { Match } from '../renderer/DataModel/Match';
import MatchImportResult from '../renderer/DataModel/MatchImportResult';
import MatchImportResultsManager from '../renderer/Modal Managers/MatchImportResultsManager';
import RoomsManager from '../renderer/Modal Managers/RoomsManager';
import { Round } from '../renderer/DataModel/Round';
import { ScheduledGame } from '../renderer/DataModel/ScheduledGame';
import { Sched4TeamsQuadRR } from '../renderer/DataModel/Schedules/4-team';
import Tournament from '../renderer/DataModel/Tournament';
import { IRoomView } from '../qbtcp/QbtcpState';
import { readResultIdentity } from '../qbtcp/ResultFingerprint';
import { makeResultFrom } from './QbtcpFixtures';
import { makeTemplateTournament, roundNumbered } from './ScheduledGameFixtures';

/** Commands the manager sent, in order. The reply carries no status, so a test's own stays put. */
let sentCommands: Record<string, unknown>[] = [];
let originalWindow: unknown;

/**
 * The renderer's global, as the manager reaches it.
 *
 * `globalThis` rather than `window`, because these tests run under node where there is no window
 * object until one is installed. The lint environment here predates it being a declared global.
 */
// eslint-disable-next-line no-undef
const rendererGlobal = globalThis as { window?: unknown };

beforeEach(() => {
  sentCommands = [];
  originalWindow = rendererGlobal.window;
  rendererGlobal.window = {
    electron: {
      ipcRenderer: {
        invoke: async (_channel: string, command: Record<string, unknown>) => {
          sentCommands.push(command);
          return { ok: true };
        },
      },
    },
  };
});

afterEach(() => {
  rendererGlobal.window = originalWindow;
});

function roomView(id: string, name: string, overrides: Partial<IRoomView> = {}): IRoomView {
  return { id, name, pairingCode: 'ABCD', enabled: true, paired: true, connected: true, ...overrides };
}

function assignmentView(scheduledGameId: string, roundNumber: number) {
  return {
    id: `assignment-${scheduledGameId}`,
    roundNumber,
    leftTeamName: 'Left',
    rightTeamName: 'Right',
    matchId: scheduledGameId,
    revision: 1,
  };
}

function managerFor(tournament: Tournament, rooms: IRoomView[]): RoomsManager {
  const manager = new RoomsManager();
  manager.getTournament = () => tournament;
  manager.status = {
    running: true,
    scoresheetUrl: 'https://example.invalid/qbsheet',
    addresses: ['http://192.168.1.5:8710'],
    hasActiveWork: false,
    rooms,
  };
  return manager;
}

/** The last setAssignment command, which is what the server would store and serve. */
function lastAssignment() {
  const assignment = sentCommands.filter((command) => command.kind === 'setAssignment').pop();
  if (!assignment) throw new Error('no setAssignment command was sent');
  return assignment;
}

test('assigning a scheduled game publishes the pairing’s own identity', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const rooms = managerFor(tournament, [roomView('room-1', 'Room 1')]);

  await rooms.assignScheduledGame('room-1', round, game);

  const command = lastAssignment();
  // Not a new opaque id: the pairing's own, so the result that comes back names this pairing.
  expect(command.matchId).toBe(game.id);
  expect(command.roundNumber).toBe(1);
  expect(command.leftTeamId).toBe(game.leftTeam.id);
  expect(command.rightTeamId).toBe(game.rightTeam.id);

  // The document is the one shared builder's output, with that same id inside it.
  const document = command.document as { objects: Record<string, unknown>[] };
  const matches = document.objects.filter((entry) => entry.type === 'Match');
  expect(matches).toHaveLength(1);
  expect(matches[0].id).toBe(game.id);
  // Still an unplayed game: no scoring content of any kind.
  expect(matches[0].tossups_read).toBeUndefined();
  const round1 = (
    document.objects.find((entry) => entry.type === 'Tournament') as
      | { phases: { rounds: { matches: { $ref: string }[] }[] }[] }
      | undefined
  )?.phases[0].rounds[0];
  expect(round1?.matches).toEqual([{ $ref: game.id }]);
  // No credential travels with an assignment, over the wire or in a file.
  expect(JSON.stringify(document)).not.toContain('ABCD');
});

test('a manual assignment still works and mints its own identity', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [tiger, lion] = tournament.getListOfAllTeams();
  const rooms = managerFor(tournament, [roomView('room-1', 'Room 1')]);

  await rooms.assign('room-1', round, tiger, lion);

  const command = lastAssignment();
  // A manually paired game has no prior identity to reuse, so one is created - and it is not
  // mistakable for a scheduled game's.
  expect(typeof command.matchId).toBe('string');
  expect(command.matchId as string).toMatch(/^Match_/);
  expect(tournament.findScheduledGameById(command.matchId as string)).toBeUndefined();
});

test('the same scheduled game is not offered to a second room', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [taken, free] = round.scheduledGames;
  const rooms = managerFor(tournament, [
    roomView('room-1', 'Room 1', { assignment: assignmentView(taken.id, 1) }),
    roomView('room-2', 'Room 2'),
  ]);

  const offeredToRoom2 = rooms.eligibleScheduledGames(tournament, 'room-2');

  expect(offeredToRoom2.some((entry) => entry.game.id === taken.id)).toBe(false);
  expect(offeredToRoom2.some((entry) => entry.game.id === free.id)).toBe(true);
  expect(rooms.scheduledGameBusyReason(taken.id, 'room-2')).toBe('it is assigned to Room 1');

  // The room that has it still sees it, so "Change" can show what the room is scoring.
  const offeredToRoom1 = rooms.eligibleScheduledGames(tournament, 'room-1');
  expect(offeredToRoom1.some((entry) => entry.game.id === taken.id)).toBe(true);
});

test('a game that has been played is not offered again', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [played] = round.scheduledGames;
  const match = new Match(played.leftTeam, played.rightTeam, tournament.scoringRules.answerTypes);
  match.scheduledGameId = played.id;
  round.addMatch(match);
  const rooms = managerFor(tournament, [roomView('room-1', 'Room 1')]);

  const offered = rooms.eligibleScheduledGames(tournament, 'room-1');

  expect(offered.some((entry) => entry.game.id === played.id)).toBe(false);
  expect(offered).toHaveLength(23);
});

test('a pairing whose result is awaiting review stays where it is', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [underReview] = round.scheduledGames;
  const rooms = managerFor(tournament, [
    roomView('room-1', 'Room 1', {
      assignment: assignmentView(underReview.id, 1),
      result: {
        id: 'result-1',
        matchId: underReview.id,
        status: 'needs-review',
        fingerprint: 'abc',
        receivedAt: '2026-08-19T12:00:00Z',
      },
    }),
    roomView('room-2', 'Room 2'),
  ]);

  expect(rooms.scheduledGameBusyReason(underReview.id, 'room-2')).toBe('Room 1 has a result waiting for review');
  expect(rooms.eligibleScheduledGames(tournament, 'room-2').some((e) => e.game.id === underReview.id)).toBe(false);
  // A conflict is the same situation: a person has to decide before the pairing can move.
  const conflicted = managerFor(tournament, [
    roomView('room-1', 'Room 1', {
      assignment: assignmentView(underReview.id, 1),
      result: {
        id: 'result-1',
        matchId: underReview.id,
        status: 'conflict',
        fingerprint: 'abc',
        receivedAt: '2026-08-19T12:00:00Z',
      },
    }),
  ]);
  expect(conflicted.scheduledGameBusyReason(underReview.id, 'room-2')).toContain('waiting for review');
});

test('procedure warnings include live assignments before a final and retained results after release', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [issued] = round.scheduledGames;

  const live = managerFor(tournament, [
    roomView('room-1', 'Room 1', {
      assignment: assignmentView(issued.id, 1),
      session: { id: 'session-1', scoring: true, finalReceived: false },
    }),
  ]);
  expect(live.hasReceivedResultForScheduledGame(issued.id)).toBe(true);

  const retained = managerFor(tournament, [
    roomView('room-1', 'Room 1', {
      result: {
        id: 'result-1',
        matchId: issued.id,
        status: 'accepted',
        fingerprint: 'abc',
        receivedAt: '2026-08-19T12:00:00Z',
      },
    }),
  ]);
  expect(retained.hasReceivedResultForScheduledGame(issued.id)).toBe(true);
});

test('the earliest round with an available game comes first', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const rooms = managerFor(tournament, [roomView('room-1', 'Room 1')]);

  const offered = rooms.eligibleScheduledGames(tournament, 'room-1');

  expect(offered).toHaveLength(24);
  expect(offered[0].round.number).toBe(1);
  expect(offered.map((entry) => entry.round.number)).toEqual(
    [...offered.map((entry) => entry.round.number)].sort((a, b) => a - b),
  );
});

// --- results coming back -----------------------------------------------------------------------

/** Parse a result document the way the importer does, and return the YellowFruit Match. */
function parseResult(tournament: Tournament, document: object, round: Round): Match {
  const copy = JSON.parse(JSON.stringify(document)) as { objects: IQbjObject[] };
  snakeCaseToCamelCase(copy);
  const parser = new FileParser({}, tournament);
  parser.buildTypesByIdArrays(copy.objects);
  parser.importPhase = tournament.findPhaseByRound(round);
  const matchObj = copy.objects.find((entry) => entry.type === 'Match');
  const parsed = parser.parseMatch(matchObj as unknown as IIndeterminateQbj);
  if (!parsed) throw new Error('the result document did not parse into a match');
  return parsed;
}

/** Assign a scheduled game and return the document that was published for it. */
async function publishAssignment(tournament: Tournament, round: Round, game: ScheduledGame) {
  const rooms = managerFor(tournament, [roomView('room-1', 'Room 1')]);
  await rooms.assignScheduledGame('room-1', round, game);
  return lastAssignment().document as object;
}

test('a result maps back to the scheduled game it was scored against', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const assignment = await publishAssignment(tournament, round, game);
  const result = makeResultFrom(assignment);

  // Whatever route it took, the identity the document carries is the pairing's.
  expect(readResultIdentity(result)?.matchId).toBe(game.id);

  const match = parseResult(tournament, result, round);
  expect(match.scheduledGameId).toBe(game.id);
  // The pairing's id is deliberately not absorbed into the match's own numbering.
  expect(match.id).toMatch(/^Match_\d+~/);
});

test('the network result and the offline file resolve to the same pairing', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const assignment = await publishAssignment(tournament, round, game);

  // "Over the network" and "exported for a room scoring offline" are the same bytes by construction,
  // so a result built from either names the same pairing.
  const overTheNetwork = makeResultFrom(assignment);
  const fromTheFile = makeResultFrom(JSON.parse(JSON.stringify(assignment)) as object);

  expect(readResultIdentity(overTheNetwork)?.matchId).toBe(readResultIdentity(fromTheFile)?.matchId);
  expect(parseResult(tournament, fromTheFile, round).scheduledGameId).toBe(game.id);
});

/** A review list holding one accepted result for the given pairing. */
function reviewFor(tournament: Tournament, round: Round, match: Match) {
  const importResult = new MatchImportResult('R01_Room-1.result.qbj');
  importResult.round = round;
  importResult.phase = tournament.findPhaseByRound(round);
  importResult.evaluateMatch(match);
  const manager = new MatchImportResultsManager();
  manager.openModal([importResult], round);
  return { manager, importResult };
}

test('accepting a result creates exactly one game and completes the pairing', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const match = parseResult(tournament, makeResultFrom(await publishAssignment(tournament, round, game)), round);
  const { manager, importResult } = reviewFor(tournament, round, match);
  expect(importResult.proceedWithImport).toBe(true);

  manager.closeModal(true);

  expect(round.matches).toHaveLength(1);
  expect(round.matches[0].scheduledGameId).toBe(game.id);
  expect(round.scheduledGameIsComplete(game)).toBe(true);
  // Reaching the server was never enough; this is the point at which it counted.
  tournament.calcHasMatchData();
  expect(tournament.hasMatchData).toBe(true);
});

test('cancelling the review leaves the pairing uncompleted', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const match = parseResult(tournament, makeResultFrom(await publishAssignment(tournament, round, game)), round);
  const { manager } = reviewFor(tournament, round, match);

  manager.closeModal(false);

  expect(round.matches).toHaveLength(0);
  expect(round.scheduledGameIsComplete(game)).toBe(false);
});

test('a rejected game in an accepted review is not recorded', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const match = parseResult(tournament, makeResultFrom(await publishAssignment(tournament, round, game)), round);
  const { manager, importResult } = reviewFor(tournament, round, match);

  // The director unticked this one - the same thing the adapter does to a conflicting result.
  manager.setProceedWithImport(importResult, false);
  manager.closeModal(true);

  expect(round.matches).toHaveLength(0);
  expect(round.scheduledGameIsComplete(game)).toBe(false);
});

test('the same result arriving twice does not create a second game', async () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const [game] = round.scheduledGames;
  const assignment = await publishAssignment(tournament, round, game);

  const first = parseResult(tournament, makeResultFrom(assignment), round);
  reviewFor(tournament, round, first).manager.closeModal(true);
  expect(round.matches).toHaveLength(1);

  // The retry, parsed and committed with no adapter available to call it a duplicate. One pairing,
  // one game: the commit step refuses it on the pairing's identity alone.
  const retry = parseResult(tournament, makeResultFrom(assignment), round);
  reviewFor(tournament, round, retry).manager.closeModal(true);

  expect(round.matches).toHaveLength(1);
  expect(round.matches[0]).toBe(first);
  expect(round.scheduledGameIsComplete(game)).toBe(true);
});

test('a result for an unrelated file is imported as an ordinary game', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const teams = tournament.getListOfAllTeams();

  // A QBJ Match whose id names no pairing in this tournament - a file from somewhere else.
  const copy = {
    objects: [
      {
        type: 'Match',
        id: 'Match_from_another_tournament',
        tossups_read: 20,
        match_teams: [
          { team: { name: teams[0].name }, points: 300 },
          { team: { name: teams[1].name }, points: 200 },
        ],
      },
    ] as unknown as IQbjObject[],
  };
  const match = parseResult(tournament, copy, round);

  expect(match.scheduledGameId).toBeUndefined();
  expect(round.scheduledGames.every((game) => !round.scheduledGameIsComplete(game))).toBe(true);
});
