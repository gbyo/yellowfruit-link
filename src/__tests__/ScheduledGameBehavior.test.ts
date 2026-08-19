/**
 * The things a scheduled game must NOT do.
 *
 * Throughout YellowFruit, a Match in `Round.matches` means "somebody entered a game". A great deal is
 * built on that: the scoring rules lock themselves once games exist, the stat report compiles from
 * those arrays, validation runs over them, and the Games page counts them. If a full schedule made any
 * of that behave as though the tournament had been played, a director would open a tournament they had
 * only scheduled and find the rules read-only and the standings full of nil-nil games.
 *
 * Every assertion here is on a tournament with a complete 24-game schedule and no results at all.
 */
import { expect, test } from 'vitest';
import { Match } from '../renderer/DataModel/Match';
import { Sched4TeamsQuadRR } from '../renderer/DataModel/Schedules/4-team';
import { makeTemplateTournament, roundNumbered, teamNamed } from './ScheduledGameFixtures';

function fullyScheduledTournament() {
  const tournament = makeTemplateTournament(Sched4TeamsQuadRR);
  expect(tournament.getAllScheduledGames()).toHaveLength(24);
  return tournament;
}

test('a schedule alone does not set hasMatchData, so the rules stay editable', () => {
  const tournament = fullyScheduledTournament();

  tournament.calcHasMatchData();

  // Every read-only gate on the Rules page is `tournament.hasMatchData`.
  expect(tournament.hasMatchData).toBe(false);
  expect(tournament.phases[0].anyMatchesExist()).toBe(false);
  expect(tournament.phases[0].getAllMatches()).toHaveLength(0);
});

test('a schedule alone does not lock seeding or stop a stage being deleted', () => {
  const tournament = fullyScheduledTournament();

  // The Teams page uses this to decide whether prelim pools may still be rearranged.
  expect(tournament.prelimSeedsReadOnly()).toBe(false);
  // The Schedule page disables Delete Stage on `phase.anyMatchesExist()`.
  expect(tournament.phases[0].anyMatchesExist()).toBe(false);
  expect(tournament.phases[0].preventConvertToNonNumericRounds()).toBe(false);
});

test('a schedule alone contributes nothing to the statistics', () => {
  const tournament = fullyScheduledTournament();

  expect(tournament.numberOfPhasesWithStats()).toBe(0);

  tournament.compileStats();

  for (const phaseStats of tournament.stats) {
    for (const poolStats of phaseStats.pools) {
      for (const poolTeamStats of poolStats.poolTeams) {
        expect(poolTeamStats.wins).toBe(0);
        expect(poolTeamStats.losses).toBe(0);
        expect(poolTeamStats.matches).toHaveLength(0);
      }
    }
  }
  for (const name of ['Tiger', 'Lion', 'Leopard', 'Jaguar']) {
    expect(tournament.teamHasPlayedAnyMatch(teamNamed(tournament, name))).toBe(false);
    expect(tournament.getPlayersWithData(teamNamed(tournament, name))).toHaveLength(0);
  }
});

test('a schedule alone produces no validation errors or warnings', () => {
  const tournament = fullyScheduledTournament();

  for (const round of tournament.phases[0].rounds) {
    // countErrorsAndWarnings walks `matches`, and there are none - a pairing has nothing to validate
    // because nothing has been entered for it.
    expect(round.countErrorsAndWarnings()).toEqual([0, 0]);
  }
  expect(tournament.phases[0].anyPoolErrors()).toBe(false);
});

test('a team scheduled in a round has not "played in" it', () => {
  const tournament = fullyScheduledTournament();
  const round = roundNumbered(tournament, 1);
  const lion = teamNamed(tournament, 'Lion');

  // Two different questions, and the duplicate-game warning depends on the difference. A team that is
  // merely scheduled must not trip "has already played a game in this round" when its result arrives.
  expect(round.teamIsScheduledIn(lion)).toBe(true);
  expect(round.teamHasPlayedIn(lion)).toBe(false);
});

test('completion is per pairing, not per pair of teams', () => {
  const tournament = fullyScheduledTournament();
  const lion = teamNamed(tournament, 'Lion');
  const jaguar = teamNamed(tournament, 'Jaguar');

  // Find the four meetings of one pair - a quadruple round robin has them on purpose.
  const meetings = tournament.phases[0].rounds
    .flatMap((round) => round.scheduledGames.map((game) => ({ round, game })))
    .filter((entry) => entry.game.includesTeam(lion) && entry.game.includesTeam(jaguar));
  expect(meetings).toHaveLength(4);

  // Record a game against the first of them only.
  const first = meetings[0];
  const match = new Match(lion, jaguar, tournament.scoringRules.answerTypes);
  match.scheduledGameId = first.game.id;
  first.round.addMatch(match);

  expect(first.round.scheduledGameIsComplete(first.game)).toBe(true);
  // The other three are still to be played. Matching on "these two teams have met in this phase"
  // would have called all four complete here, and three games would have vanished from the schedule.
  for (const other of meetings.slice(1)) {
    expect(other.round.scheduledGameIsComplete(other.game)).toBe(false);
  }
});

test('deleting the entered game makes its pairing incomplete again', () => {
  const tournament = fullyScheduledTournament();
  const round = roundNumbered(tournament, 1);
  const [scheduled] = round.scheduledGames;
  const match = new Match(scheduled.leftTeam, scheduled.rightTeam, tournament.scoringRules.answerTypes);
  match.scheduledGameId = scheduled.id;
  round.addMatch(match);
  expect(round.scheduledGameIsComplete(scheduled)).toBe(true);

  round.deleteMatch(match);

  // Completion is derived from the matches present rather than stored on the pairing, so undoing an
  // accepted result puts the game back in the queue with no extra bookkeeping to get wrong.
  expect(round.scheduledGameIsComplete(scheduled)).toBe(false);
});
