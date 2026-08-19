/**
 * Deleting a team without orphaning a game a room is playing.
 *
 * Deleting a team takes every pairing that names it. For a schedule nobody has started on that is
 * right - a pairing naming a team the tournament no longer has would be offered in Rooms and would
 * build an assignment for a team with no roster. The moment a room is holding one of those pairings it
 * is wrong: the pairing's id is what the QBTCP session, the document served to the room and any result
 * on its way back are all keyed on, so removing it leaves a room scoring a game the tournament does
 * not contain and a returning result with nothing to resolve against.
 *
 * The rule is therefore refuse-the-whole-deletion, not delete-what-is-safe. Deleting the team and
 * keeping its busy pairings would leave pairings naming a team that no longer exists, which is the
 * problem this is meant to prevent.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import { Sched4TeamsQuadRR } from '../renderer/DataModel/Schedules/4-team';
import { Match } from '../renderer/DataModel/Match';
import Registration from '../renderer/DataModel/Registration';
import { Team } from '../renderer/DataModel/Team';
import {
  TestTournamentManager,
  installRendererGlobals,
  restoreRendererGlobals,
  roomWithAssignment,
} from './TournamentManagerFixtures';
import { makeTemplateTournament, roundNumbered, teamNamed } from './ScheduledGameFixtures';

beforeEach(installRendererGlobals);
afterEach(restoreRendererGlobals);

function scheduledTournament() {
  const manager = new TestTournamentManager();
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  manager.loadTournament(tournament);
  expect(tournament.getAllScheduledGames()).toHaveLength(24);
  return { manager, tournament };
}

function registrationFor(manager: TestTournamentManager, team: Team): Registration {
  const registration = manager.tournament.findRegistrationByTeam(team);
  if (!registration) throw new Error(`no registration holds ${team.name}`);
  return registration;
}

/** Everything about the tournament that a refused deletion must leave alone. */
function snapshot(manager: TestTournamentManager) {
  return {
    teams: manager.tournament.getListOfAllTeams().map((team) => team.name),
    seeds: manager.tournament.seeds.map((team) => team.name),
    registrations: manager.tournament.registrations.map((reg) => reg.name),
    games: manager.tournament.getAllScheduledGames().map((game) => ({ id: game.id, name: game.displayName() })),
    rooms: JSON.stringify(manager.roomsManager.status.rooms),
  };
}

test('deleting a team with only unplayed, unassigned pairings works as before', () => {
  const { manager, tournament } = scheduledTournament();
  const lion = teamNamed(tournament, 'Lion');

  manager.tryDeleteTeam(registrationFor(manager, lion), lion);
  manager.answerConfirmation(true);

  expect(
    tournament
      .getListOfAllTeams()
      .map((team) => team.name)
      .sort(),
  ).toEqual(['Jaguar', 'Leopard', 'Tiger']);
  expect(tournament.getAllScheduledGames().some((game) => game.includesTeam(lion))).toBe(false);
  // The pairings between the teams that remain are still valid pairings, and stay.
  expect(tournament.getAllScheduledGames()).toHaveLength(12); // 24 minus the 12 that named Lion
  expect(manager.toasts).toEqual([]);
});

test('deleting a team whose pairing is assigned to a room is refused', () => {
  const { manager, tournament } = scheduledTournament();
  const lion = teamNamed(tournament, 'Lion');
  const round = roundNumbered(tournament, 1);
  const live = round.scheduledGames.find((game) => game.includesTeam(lion));
  expect(live).toBeDefined();
  manager.setRooms([roomWithAssignment('room-1', 'Room 1', live!.id, round.number)]);
  const before = snapshot(manager);

  manager.tryDeleteTeam(registrationFor(manager, lion), lion);

  // Refused before the confirmation is even offered, so nothing is asked that cannot be honoured.
  expect(manager.genericModalManager.isOpen).toBe(false);
  expect(manager.toasts).toHaveLength(1);
  expect(manager.toasts[0].severity).toBe('warning');
  expect(manager.toasts[0].message).toContain('Lion');
  expect(manager.toasts[0].message).toContain('Room 1');
  expect(snapshot(manager)).toEqual(before);
});

test('deleting a team whose game is being scored is refused', () => {
  const { manager, tournament } = scheduledTournament();
  const tiger = teamNamed(tournament, 'Tiger');
  const round = roundNumbered(tournament, 1);
  const live = round.scheduledGames.find((game) => game.includesTeam(tiger));
  manager.setRooms([
    roomWithAssignment('room-2', 'Room 2', live!.id, round.number, {
      session: { id: 'session-1', scoring: true, tossupsRead: 9, finalReceived: false },
    }),
  ]);
  const before = snapshot(manager);

  manager.tryDeleteTeam(registrationFor(manager, tiger), tiger);

  expect(manager.toasts[0].message).toContain('Room 2');
  expect(snapshot(manager)).toEqual(before);
});

test('deleting a team whose result is waiting for review is refused, and says so', () => {
  const { manager, tournament } = scheduledTournament();
  const jaguar = teamNamed(tournament, 'Jaguar');
  const round = roundNumbered(tournament, 2);
  const live = round.scheduledGames.find((game) => game.includesTeam(jaguar));
  manager.setRooms([
    roomWithAssignment('room-3', 'Room 3', live!.id, round.number, {
      session: { id: 'session-2', scoring: true, tossupsRead: 20, finalReceived: true },
      result: { id: 'result-1', status: 'needs-review', fingerprint: 'abc', receivedAt: '2026-08-19T12:00:00Z' },
    }),
  ]);
  const before = snapshot(manager);

  manager.tryDeleteTeam(registrationFor(manager, jaguar), jaguar);

  expect(manager.toasts[0].message).toContain('waiting for review');
  expect(snapshot(manager)).toEqual(before);
});

test('a room that takes the pairing while the confirmation is open still stops the deletion', () => {
  const { manager, tournament } = scheduledTournament();
  const leopard = teamNamed(tournament, 'Leopard');
  const round = roundNumbered(tournament, 1);
  const game = round.scheduledGames.find((entry) => entry.includesTeam(leopard));

  // Nothing is live yet, so the confirmation opens.
  manager.tryDeleteTeam(registrationFor(manager, leopard), leopard);
  expect(manager.genericModalManager.isOpen).toBe(true);

  // ...and while it is on screen, a room is given one of this team's games.
  manager.setRooms([roomWithAssignment('room-4', 'Room 4', game!.id, round.number)]);
  const before = snapshot(manager);

  manager.answerConfirmation(true);

  // The answer is checked again at the moment of the mutation, not only when the question was asked.
  expect(snapshot(manager)).toEqual(before);
  expect(manager.toasts[0].message).toContain('Room 4');
});

test('once the room lets go, the same deletion succeeds', () => {
  const { manager, tournament } = scheduledTournament();
  const lion = teamNamed(tournament, 'Lion');
  const round = roundNumbered(tournament, 1);
  const live = round.scheduledGames.find((game) => game.includesTeam(lion));
  manager.setRooms([roomWithAssignment('room-1', 'Room 1', live!.id, round.number)]);

  manager.tryDeleteTeam(registrationFor(manager, lion), lion);
  expect(tournament.getListOfAllTeams()).toHaveLength(4);

  manager.setRooms([
    { id: 'room-1', name: 'Room 1', pairingCode: 'ABCD', enabled: true, paired: true, connected: true },
  ]);
  manager.tryDeleteTeam(registrationFor(manager, lion), lion);
  manager.answerConfirmation(true);

  expect(tournament.getListOfAllTeams()).toHaveLength(3);
  expect(tournament.getAllScheduledGames().some((game) => game.includesTeam(lion))).toBe(false);
});

test('a played pairing also stops the team being deleted', () => {
  const { manager, tournament } = scheduledTournament();
  const tiger = teamNamed(tournament, 'Tiger');
  const round = roundNumbered(tournament, 1);
  const played = round.scheduledGames.find((game) => game.includesTeam(tiger))!;
  const match = new Match(played.leftTeam, played.rightTeam, tournament.scoringRules.answerTypes);
  match.scheduledGameId = played.id;
  round.addMatch(match);
  const before = snapshot(manager);

  manager.tryDeleteTeam(registrationFor(manager, tiger), tiger);

  // The Teams page already disables its delete button once a team has played, so this is the same
  // rule stated where it cannot be got around - and the entered game keeps the pairing it names.
  expect(manager.toasts[0].message).toContain('already been played');
  expect(snapshot(manager)).toEqual(before);
  expect(round.getMatchForScheduledGame(played)).toBe(match);
});

test('a busy pairing for one team does not block deleting a different team', () => {
  const { manager, tournament } = scheduledTournament();
  const round = roundNumbered(tournament, 1);
  const [firstGame, secondGame] = round.scheduledGames;
  manager.setRooms([roomWithAssignment('room-1', 'Room 1', firstGame.id, round.number)]);

  // The other game in the round involves neither of the busy pairing's teams.
  const uninvolved = secondGame.leftTeam;
  expect(firstGame.includesTeam(uninvolved)).toBe(false);

  manager.tryDeleteTeam(registrationFor(manager, uninvolved), uninvolved);
  manager.answerConfirmation(true);

  expect(tournament.getListOfAllTeams().includes(uninvolved)).toBe(false);
  // The busy pairing is untouched and still resolvable by the id the room is holding.
  expect(tournament.findScheduledGameById(firstGame.id)).toBeDefined();
});
