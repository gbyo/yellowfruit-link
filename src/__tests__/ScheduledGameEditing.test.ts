/**
 * The pairing editor's validation, and what an edit does to a pairing's identity.
 *
 * The three refusals here are the mistakes that cost a round: a team against itself, a team in two
 * games in the same round, and a game between teams from different pools. They are cheap to refuse
 * while the dialog is open and expensive to discover from a room at the start of the round.
 */
import { expect, test } from 'vitest';
import ScheduledGameManager from '../renderer/Modal Managers/ScheduledGameManager';
import { Sched4TeamsQuadRR } from '../renderer/DataModel/Schedules/4-team';
import {
  makeTemplateTournament,
  makeTwoPoolTournament,
  pairingNames,
  roundNumbered,
  teamNamed,
} from './ScheduledGameFixtures';
import Tournament from '../renderer/DataModel/Tournament';
import { Round } from '../renderer/DataModel/Round';

function editorFor(tournament: Tournament, round: Round, gameIndex?: number) {
  const [phase] = tournament.phases;
  const manager = new ScheduledGameManager();
  const game = gameIndex === undefined ? undefined : round.scheduledGames[gameIndex];
  manager.openModal(phase, round, tournament.getListOfAllTeams(), game);
  return manager;
}

test('a team cannot be scheduled against itself', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const manager = editorFor(tournament, round);
  const lion = teamNamed(tournament, 'Lion');

  manager.setTeam('left', lion);
  manager.setTeam('right', lion);

  expect(manager.hasAnyErrors()).toBe(true);
  expect(manager.teamsError).toBe('A team cannot play itself.');
  expect(manager.closeModal(true)).toBe(false);
  expect(manager.modalIsOpen).toBe(true);
});

test('a team cannot be in two scheduled games in one round', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const existing = round.scheduledGames[0];
  const manager = editorFor(tournament, round);

  manager.setTeam('left', existing.leftTeam);
  manager.setTeam('right', round.scheduledGames[1].leftTeam);

  expect(manager.hasAnyErrors()).toBe(true);
  expect(manager.teamsError).toContain('already scheduled in Round 1');
  expect(round.scheduledGames).toHaveLength(2);
});

test('editing a pairing does not count as a conflict with itself', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const game = round.scheduledGames[0];
  const manager = editorFor(tournament, round, 0);

  // Reopened with the pairing's own teams already selected, which must not read as a double booking.
  expect(manager.hasAnyErrors()).toBe(false);
  // Swap the sides, which is a real thing a director does to a pairing sheet.
  manager.setTeam('left', game.rightTeam);
  manager.setTeam('right', game.leftTeam);
  expect(manager.hasAnyErrors()).toBe(false);
});

test('teams from different pools cannot be paired', () => {
  const tournament = makeTwoPoolTournament();
  const [phase] = tournament.phases;
  const round = roundNumbered(tournament, 1);
  const manager = new ScheduledGameManager();
  manager.openModal(phase, round, tournament.getListOfAllTeams());

  const inPoolA = phase.pools[0].poolTeams[0].team;
  const inPoolB = phase.pools[1].poolTeams[0].team;
  manager.setTeam('left', inPoolA);
  manager.setTeam('right', inPoolB);

  expect(manager.hasAnyErrors()).toBe(true);
  expect(manager.teamsError).toContain('Pool A');
  expect(manager.teamsError).toContain('Pool B');
});

test('an unassigned team is a warning, not a refusal', () => {
  const tournament = makeTwoPoolTournament();
  const [phase] = tournament.phases;
  const round = roundNumbered(tournament, 1);
  const unassigned = phase.pools[1].poolTeams[3].team;
  // Take one team out of its pool, as a tiebreaker or an odd final would leave it.
  phase.pools[1].removeTeam(unassigned);

  const manager = new ScheduledGameManager();
  manager.openModal(phase, round, tournament.getListOfAllTeams());
  manager.setTeam('left', phase.pools[0].poolTeams[0].team);
  manager.setTeam('right', unassigned);

  expect(manager.hasAnyErrors()).toBe(false);
  expect(manager.warning).toContain('not in any pool');
  expect(manager.closeModal(true)).toBe(true);
  expect(round.scheduledGames).toHaveLength(1);
  // No shared pool, so none is recorded - the pairing is simply not a pool's business.
  expect(round.scheduledGames[0].poolName).toBeUndefined();
});

test('adding a pairing marks it as the director’s, not the generator’s', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  // Clear the round so there is room to add one without a double booking.
  round.scheduledGames = [];
  const manager = editorFor(tournament, round);

  manager.setTeam('left', teamNamed(tournament, 'Lion'));
  manager.setTeam('right', teamNamed(tournament, 'Jaguar'));
  expect(manager.closeModal(true)).toBe(true);

  expect(pairingNames(round)).toEqual(['Lion vs Jaguar']);
  expect(round.scheduledGames[0].generated).toBe(false);
  expect(round.scheduledGames[0].poolName).toBe('Round Robin');
});

test('editing a pairing keeps its identity and moves it between rounds', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round1 = roundNumbered(tournament, 1);
  const round2 = roundNumbered(tournament, 2);
  const game = round1.scheduledGames[0];
  const originalId = game.id;
  round2.scheduledGames = []; // make room in the destination

  const manager = editorFor(tournament, round1, 0);
  manager.setRound(round2);
  expect(manager.closeModal(true)).toBe(true);

  // Same object, same id. A room may already be serving this identity, and a completed match may
  // already reference it, so an edit must never replace the pairing with a new one.
  expect(round1.scheduledGames).toHaveLength(1);
  expect(round2.scheduledGames).toContain(game);
  expect(round2.scheduledGames[0].id).toBe(originalId);
  // Touched by a person, so automatic regeneration will now leave this pool's schedule alone.
  expect(game.generated).toBe(false);
});

test('cancelling the editor changes nothing', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const round = roundNumbered(tournament, 1);
  const before = pairingNames(round);
  const manager = editorFor(tournament, round, 0);

  manager.setTeam('left', teamNamed(tournament, 'Tiger'));
  manager.closeModal(false);

  expect(pairingNames(round)).toEqual(before);
  expect(round.scheduledGames.every((game) => game.generated)).toBe(true);
});
