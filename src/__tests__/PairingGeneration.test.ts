/**
 * When pairings are generated, and - more importantly - when they are not.
 *
 * The generator itself is covered in RoundRobinGenerator.test.ts. What is checked here is the policy
 * wrapped around it: pools wait until their teams are known, a shipped template produces the schedule
 * it advertises without any four-team special case, and regeneration refuses to touch a pairing that a
 * director wrote, a room is scoring, or a played game already references.
 */
import { expect, test } from 'vitest';
import { PairingGenerationMode, generatePairingsForPhase } from '../renderer/DataModel/PairingGeneration';
import { Sched4TeamsQuadRR, Sched4TeamsSingleRR } from '../renderer/DataModel/Schedules/4-team';
import { Sched5TeamsSingleRR } from '../renderer/DataModel/Schedules/5-team';
import { Sched9TeamsSingleRR } from '../renderer/DataModel/Schedules/9-team';
import { Match } from '../renderer/DataModel/Match';
import Registration from '../renderer/DataModel/Registration';
import { ScheduledGame } from '../renderer/DataModel/ScheduledGame';
import {
  bigCatNames,
  makeCustomRoundRobinTournament,
  makeTeam,
  makeTemplateTournament,
  makeTwoPoolTournament,
  pairKeys,
  roundNumbered,
  teamNamed,
} from './ScheduledGameFixtures';

/** Every unordered pair in the tournament, counted across all of its rounds. */
function meetingCounts(rounds: { scheduledGames: ScheduledGame[] }[]) {
  const counts = new Map<string, number>();
  for (const round of rounds) {
    for (const game of round.scheduledGames) {
      const key = [game.leftTeam.name, game.rightTeam.name].sort().join('|');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

test('a template schedule waits for its pool to fill, then produces the pairings', () => {
  // Applied with no teams registered: the pool's membership is unknown, so there is nothing to derive.
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR, []);
  expect(tournament.anyScheduledGamesExist()).toBe(false);

  // Register three of the four. Still nothing: a round robin among three of a pool of four is a
  // schedule for a tournament nobody is running.
  const partial = makeTemplateTournament(Sched4TeamsSingleRR, bigCatNames.slice(0, 3));
  expect(partial.anyScheduledGamesExist()).toBe(false);

  const full = makeTemplateTournament(Sched4TeamsSingleRR);
  expect(full.getAllScheduledGames()).toHaveLength(6);
});

test('Sched4TeamsQuadRR produces 12 rounds of 2, with no four-team special case', () => {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  const [phase] = tournament.phases;

  expect(phase.rounds).toHaveLength(12);
  expect(tournament.getAllScheduledGames()).toHaveLength(24);
  for (const round of phase.rounds) {
    expect(round.scheduledGames).toHaveLength(2);
    // Each team plays exactly once per round, so all four appear and none appears twice.
    const teamNames = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(teamNames.sort()).toEqual([...bigCatNames].sort());
  }

  // Every pair meets exactly four times, and every team has 12 games.
  expect([...meetingCounts(phase.rounds).values()]).toEqual([4, 4, 4, 4, 4, 4]);
  for (const name of bigCatNames) {
    const team = teamNamed(tournament, name);
    const games = tournament.getAllScheduledGames().filter((game) => game.includesTeam(team));
    expect(games).toHaveLength(12);
  }
});

test('an odd-sized template pool gets byes rather than a broken round', () => {
  const fiveTeams = ['Tiger', 'Lion', 'Leopard', 'Jaguar', 'Puma'];
  const tournament = makeTemplateTournament(Sched5TeamsSingleRR, fiveTeams);
  const [phase] = tournament.phases;

  expect(phase.rounds).toHaveLength(5);
  expect(tournament.getAllScheduledGames()).toHaveLength(10);
  for (const round of phase.rounds) {
    expect(round.scheduledGames).toHaveLength(2);
    const teamNames = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    expect(new Set(teamNames).size).toBe(4); // four play, one has the bye
  }
  expect([...meetingCounts(phase.rounds).values()].every((count) => count === 1)).toBe(true);
});

test('a nine-team template round robin is generated the same way', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'];
  const tournament = makeTemplateTournament(Sched9TeamsSingleRR, names);
  const [phase] = tournament.phases;

  expect(tournament.getAllScheduledGames()).toHaveLength(36); // C(9,2)
  for (const round of phase.rounds.slice(0, 9)) {
    expect(round.scheduledGames).toHaveLength(4);
  }
  expect([...meetingCounts(phase.rounds).values()].every((count) => count === 1)).toBe(true);
});

test('a custom pool generates the same 24-game structure on request', () => {
  const tournament = makeCustomRoundRobinTournament(4, 4, 12);
  const [phase] = tournament.phases;
  // Nothing until asked: a custom schedule's pairings belong to the director.
  expect(tournament.anyScheduledGamesExist()).toBe(false);

  const outcome = tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);

  expect(outcome.gamesCreated).toBe(24);
  expect(outcome.skipped).toEqual([]);
  expect(phase.rounds.every((round) => round.scheduledGames.length === 2)).toBe(true);
  expect([...meetingCounts(phase.rounds).values()]).toEqual([4, 4, 4, 4, 4, 4]);
});

test('generated and regenerated schedules advance each touched round exactly once', () => {
  const tournament = makeCustomRoundRobinTournament(4, 1, 4);
  const [phase] = tournament.phases;
  const before = phase.rounds.map((round) => round.revision);

  const first = tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);
  expect(first.gamesCreated).toBe(6);
  const touched = phase.rounds.map((round) => round.scheduledGames.length > 0);
  expect(phase.rounds.map((round) => round.revision)).toEqual(
    before.map((revision, index) => revision + (touched[index] ? 1 : 0)),
  );

  const afterFirst = phase.rounds.map((round) => round.revision);
  const second = tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);
  expect(second.gamesRemoved).toBe(6);
  expect(phase.rounds.map((round) => round.revision)).toEqual(
    afterFirst.map((revision, index) => revision + (touched[index] ? 1 : 0)),
  );
});

test('parallel pools are generated independently and share round numbers', () => {
  const tournament = makeTwoPoolTournament();
  const [phase] = tournament.phases;

  const outcome = generatePairingsForPhase(phase, { mode: PairingGenerationMode.ReplaceAll });

  expect(outcome.gamesCreated).toBe(12); // two pools of four, single round robin each
  for (const round of phase.rounds) {
    // Four games per round: two from each pool, at the same time, which is what parallel pools are.
    expect(round.scheduledGames).toHaveLength(4);
    const teamNames = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    // Pools are team-disjoint, so no team can appear twice even though the rounds overlap.
    expect(new Set(teamNames).size).toBe(8);
  }
  // Each pool's pairings are recorded against that pool.
  const poolNames = new Set(tournament.getAllScheduledGames().map((game) => game.poolName));
  expect([...poolNames].sort()).toEqual(['Pool A', 'Pool B']);
});

test('a pool with no round robin gets no invented pairings', () => {
  const tournament = makeCustomRoundRobinTournament(4, 0, 12);
  const [phase] = tournament.phases;

  const outcome = generatePairingsForPhase(phase, { mode: PairingGenerationMode.ReplaceAll });

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.skipped).toEqual([]);
  expect(tournament.anyScheduledGamesExist()).toBe(false);
});

test('a phase too short for its round robin is reported rather than lengthened', () => {
  const tournament = makeCustomRoundRobinTournament(4, 4, 6);
  const [phase] = tournament.phases;

  const outcome = generatePairingsForPhase(phase, { mode: PairingGenerationMode.ReplaceAll });

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.skipped).toHaveLength(1);
  expect(outcome.skipped[0]).toContain('needs 12 rounds');
  expect(phase.rounds).toHaveLength(6);
});

test('automatic regeneration replaces its own pairings but not a director’s', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const generatedIds = tournament.getAllScheduledGames().map((game) => game.id);

  // A reseeding regenerates: nothing was hand-made, so the schedule is the template's to rewrite.
  tournament.swapSeeds(1, 2);
  expect(tournament.getAllScheduledGames()).toHaveLength(6);
  const idsAfterReseed = tournament.getAllScheduledGames().map((game) => game.id);
  expect(idsAfterReseed).not.toEqual(generatedIds);

  // Now the director edits one pairing. From here the pool's schedule is theirs.
  const edited = roundNumbered(tournament, 1).scheduledGames[0];
  edited.generated = false;
  const idsAfterEdit = tournament.getAllScheduledGames().map((game) => game.id);

  tournament.swapSeeds(1, 3);
  expect(tournament.getAllScheduledGames().map((game) => game.id)).toEqual(idsAfterEdit);
});

test('a completed pairing blocks its whole pool from being regenerated', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const [phase] = tournament.phases;
  const round = roundNumbered(tournament, 1);
  const played = round.scheduledGames[0];

  // The result has been accepted: an entered game references this pairing.
  const match = new Match(played.leftTeam, played.rightTeam);
  match.scheduledGameId = played.id;
  round.addMatch(match);

  const idsBefore = tournament.getAllScheduledGames().map((game) => game.id);
  const outcome = generatePairingsForPhase(phase, { mode: PairingGenerationMode.ReplaceAll });

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.skipped).toHaveLength(1);
  expect(outcome.skipped[0]).toContain('already been played');
  // Partial regeneration would be worse than none, so the untouched pairings stay too.
  expect(tournament.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
});

test('a pairing a room is scoring blocks regeneration, even an explicit one', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const [phase] = tournament.phases;
  const live = roundNumbered(tournament, 2).scheduledGames[0];
  const idsBefore = tournament.getAllScheduledGames().map((game) => game.id);

  const outcome = generatePairingsForPhase(phase, {
    mode: PairingGenerationMode.ReplaceAll,
    isBusy: (game) => (game.id === live.id ? 'it is assigned to Room 3' : undefined),
  });

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.skipped[0]).toContain('Room 3');
  expect(tournament.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
});

test('fill-only generation never disturbs an existing schedule', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const [phase] = tournament.phases;
  const idsBefore = tournament.getAllScheduledGames().map((game) => game.id);

  const outcome = generatePairingsForPhase(phase, { mode: PairingGenerationMode.FillOnly });

  expect(outcome.gamesCreated).toBe(0);
  expect(outcome.gamesRemoved).toBe(0);
  expect(tournament.getAllScheduledGames().map((game) => game.id)).toEqual(idsBefore);
});

test('deleting a team removes the pairings that named it', () => {
  const tournament = makeTemplateTournament(Sched4TeamsSingleRR);
  const lion = teamNamed(tournament, 'Lion');
  const registration = tournament.findRegistrationByTeam(lion);
  expect(registration).toBeDefined();
  expect(tournament.getAllScheduledGames().some((game) => game.includesTeam(lion))).toBe(true);

  tournament.deleteTeam(registration!, lion);

  // Every pairing naming the departed team is gone; the ones between the teams that remain are still
  // valid pairings and are left in place. The pool is now short of its declared size, so nothing is
  // regenerated in their place - a round robin among three of a pool of four is not a schedule.
  expect(tournament.getAllScheduledGames().some((game) => game.includesTeam(lion))).toBe(false);
  expect(
    pairKeys(roundNumbered(tournament, 1))
      .concat(pairKeys(roundNumbered(tournament, 2)), pairKeys(roundNumbered(tournament, 3)))
      .sort(),
  ).toEqual(['Jaguar|Leopard', 'Jaguar|Tiger', 'Leopard|Tiger']);

  // Registering a replacement fills the pool again, and the schedule is rebuilt in full.
  tournament.addRegistration(new Registration('Puma', makeTeam('Puma', ['Puma One', 'Puma Two'])));
  expect(tournament.getAllScheduledGames()).toHaveLength(6);
});

test('regenerating twice in a row produces the same set of meetings', () => {
  const tournament = makeCustomRoundRobinTournament(7, 2, 14);
  const [phase] = tournament.phases;

  tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);
  const first = phase.rounds.map((round) => pairKeys(round));

  const second = tournament.generatePairingsForOnePhase(phase, PairingGenerationMode.ReplaceAll);
  expect(second.gamesRemoved).toBe(42); // C(7,2) * 2
  expect(second.gamesCreated).toBe(42);
  expect(phase.rounds.map((round) => pairKeys(round))).toEqual(first);
});
