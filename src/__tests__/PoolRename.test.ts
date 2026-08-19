/**
 * Renaming a pool without losing its schedule.
 *
 * `ScheduledGame.poolName` is a copy of the pool's display name - a name rather than an object
 * reference, because pools are rebuilt wholesale when a file is opened or a phase is rebracketed. The
 * cost of that choice is that a rename has to be propagated: leave it out and the pool's own pairings
 * stop looking like the pool's, so the next generation writes a second schedule beside the first and
 * every team is paired twice a round.
 */
import { expect, test } from 'vitest';
import { PairingGenerationMode, scheduledGameBelongsToPool } from '../renderer/DataModel/PairingGeneration';
import TempPoolManager from '../renderer/Modal Managers/TempPoolManager';
import { camelCaseToSnakeCase, snakeCaseToCamelCase } from '../renderer/DataModel/CaseConversion';
import FileParser from '../renderer/DataModel/FileParsing';
import { IQbjWholeFile } from '../renderer/DataModel/Interfaces';
import { ScheduledGame } from '../renderer/DataModel/ScheduledGame';
import Tournament, { IQbjTournament } from '../renderer/DataModel/Tournament';
import { collectRefTargets, findTournamentObject } from '../renderer/DataModel/QbjUtils2';
import { makeTwoPoolTournament, teamNamed } from './ScheduledGameFixtures';

/** Save and reopen exactly as the application does. */
function roundTrip(tournament: Tournament): Tournament {
  tournament.appVersion = '4.0.18';
  const wholeFile: IQbjWholeFile = { version: '2.1.1', objects: [tournament.toFileObject(false, true)] };
  camelCaseToSnakeCase(wholeFile);
  const text = JSON.stringify(wholeFile);

  const fileObj = JSON.parse(text) as IQbjWholeFile;
  snakeCaseToCamelCase(fileObj);
  const tournamentObj = findTournamentObject(fileObj.objects);
  if (!tournamentObj) throw new Error('serialized file has no Tournament object');
  const parser = new FileParser(collectRefTargets(fileObj.objects));
  const reopened = parser.parseTournament(tournamentObj as IQbjTournament);
  if (!reopened) throw new Error('failed to reopen the serialized tournament');
  return reopened;
}

/** Two pools of four with a generated single round robin each. */
function generatedTwoPoolTournament() {
  const tournament = makeTwoPoolTournament();
  const [phase] = tournament.phases;
  tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);
  expect(tournament.getAllScheduledGames()).toHaveLength(12);
  return { tournament, phase };
}

/** Rename through the pool edit modal, which is the only way a director can do it. */
function renameThroughTheModal(tournament: Tournament, phaseIndex: number, poolIndex: number, newName: string) {
  const phase = tournament.phases[phaseIndex];
  const pool = phase.pools[poolIndex];
  const manager = new TempPoolManager();
  manager.openModal(
    pool,
    phase.pools.filter((other) => other !== pool).map((other) => other.name),
    phase,
    false,
  );
  manager.setPoolName(newName);
  manager.closeModal(true);
  return pool;
}

test('renaming a pool keeps its pairings, with the same ids', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  const before = tournament
    .getAllScheduledGames()
    .filter((game) => game.poolName === 'Pool A')
    .map((game) => ({ id: game.id, left: game.leftTeam.name, right: game.rightTeam.name, generated: game.generated }));
  expect(before).toHaveLength(6);

  const renamed = renameThroughTheModal(tournament, 0, 0, 'Championship');

  expect(renamed.name).toBe('Championship');
  const after = tournament
    .getAllScheduledGames()
    .filter((game) => game.poolName === 'Championship')
    .map((game) => ({ id: game.id, left: game.leftTeam.name, right: game.rightTeam.name, generated: game.generated }));
  // Same objects with a new label on them - not a rebuilt schedule that happens to look similar.
  expect(after).toEqual(before);
  // Nothing is left pointing at the old name.
  expect(tournament.getAllScheduledGames().some((game) => game.poolName === 'Pool A')).toBe(false);
  // And the other pool was not touched.
  expect(tournament.getAllScheduledGames().filter((game) => game.poolName === 'Pool B')).toHaveLength(6);
  expect(phase.getAllScheduledGames()).toHaveLength(12);
});

test('generating again after a rename replaces the pairings rather than duplicating them', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  renameThroughTheModal(tournament, 0, 0, 'Championship');

  const outcome = tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);

  // Six removed and six written for each pool. Before the rename was propagated, the renamed pool
  // looked empty and its six old games were left in place beside six new ones.
  expect(outcome.gamesRemoved).toBe(12);
  expect(outcome.gamesCreated).toBe(12);
  expect(tournament.getAllScheduledGames()).toHaveLength(12);
  for (const round of phase.rounds) {
    const names = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(new Set(names).size).toBe(names.length);
  }
});

test('a renamed pool keeps its pairings across a save and a reopen', () => {
  const { tournament } = generatedTwoPoolTournament();
  renameThroughTheModal(tournament, 0, 0, 'Championship');
  const before = tournament
    .getAllScheduledGames()
    .map((game) => ({ id: game.id, poolName: game.poolName, name: game.displayName() }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const reopened = roundTrip(tournament);

  expect(reopened.phases[0].pools.map((pool) => pool.name)).toEqual(['Championship', 'Pool B']);
  expect(
    reopened
      .getAllScheduledGames()
      .map((game) => ({ id: game.id, poolName: game.poolName, name: game.displayName() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  ).toEqual(before);

  // And the relationship still works after the round trip: a regeneration replaces, not duplicates.
  const outcome = reopened.generatePairingsForOnePhase(reopened.phases[0], PairingGenerationMode.ReplaceAll);
  expect(outcome.gamesRemoved).toBe(12);
  expect(reopened.getAllScheduledGames()).toHaveLength(12);
});

test('a pairing whose recorded pool no longer exists is claimed only when both teams are in the pool', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  const [poolA, poolB] = phase.pools;

  const withinA = new ScheduledGame(teamNamed(tournament, 'Tiger'), teamNamed(tournament, 'Lion'), {
    poolName: 'A Pool That Was Deleted',
  });
  const acrossPools = new ScheduledGame(teamNamed(tournament, 'Tiger'), teamNamed(tournament, 'Puma'), {
    poolName: 'A Pool That Was Deleted',
  });

  // Both teams here, so this stale pairing is unambiguously Pool A's business.
  expect(scheduledGameBelongsToPool(withinA, poolA, phase)).toBe(true);
  expect(scheduledGameBelongsToPool(withinA, poolB, phase)).toBe(false);
  // One team in each pool. Claiming it for both would have each pool generate over the other's
  // schedule, so neither claims it and it stays where the director put it.
  expect(scheduledGameBelongsToPool(acrossPools, poolA, phase)).toBe(false);
  expect(scheduledGameBelongsToPool(acrossPools, poolB, phase)).toBe(false);
});

test('a pairing recorded against another live pool is never claimed by this one', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  const [poolA, poolB] = phase.pools;

  // A director's cross-pool pairing, filed under Pool B. Pool A does not get to regenerate over it
  // just because one of its teams is named in it.
  const crossPool = new ScheduledGame(teamNamed(tournament, 'Tiger'), teamNamed(tournament, 'Puma'), {
    poolName: poolB.name,
  });

  expect(scheduledGameBelongsToPool(crossPool, poolA, phase)).toBe(false);
  expect(scheduledGameBelongsToPool(crossPool, poolB, phase)).toBe(true);
});

test('a pairing with no recorded pool is still claimed by a pool holding either team', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  const [poolA] = phase.pools;

  // Hand-built in the editor, or written before pool names were recorded. The one-sided fallback is
  // deliberate: a game pairing one of this pool's teams with somebody who should not be there is the
  // mistake regeneration exists to clear.
  const handMade = new ScheduledGame(teamNamed(tournament, 'Tiger'), teamNamed(tournament, 'Puma'));

  expect(scheduledGameBelongsToPool(handMade, poolA, phase)).toBe(true);
});

test('renaming a pool does not touch anything else about it', () => {
  const { tournament, phase } = generatedTwoPoolTournament();
  const pool = phase.pools[0];
  pool.roundRobins = 1;
  const sizeBefore = pool.size;
  const seedsBefore = pool.seeds.slice();
  const teamsBefore = pool.poolTeams.map((pt) => pt.team.name);

  renameThroughTheModal(tournament, 0, 0, 'Championship');

  expect(pool.size).toBe(sizeBefore);
  expect(pool.seeds).toEqual(seedsBefore);
  expect(pool.poolTeams.map((pt) => pt.team.name)).toEqual(teamsBefore);
});
