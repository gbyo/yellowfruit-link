/**
 * Fixtures for the scheduled-game tests.
 *
 * Built through the ordinary data model - a template applied, teams registered one at a time, seeds
 * distributed the way the Teams page distributes them. If these tests needed a special construction
 * path to produce a schedule, that would itself be the finding.
 *
 * The four teams are the ones from the worked example: Tiger, Lion, Leopard, Jaguar.
 */
import { Match } from '../renderer/DataModel/Match';
import { Phase, PhaseTypes } from '../renderer/DataModel/Phase';
import { Player } from '../renderer/DataModel/Player';
import { Pool } from '../renderer/DataModel/Pool';
import Registration from '../renderer/DataModel/Registration';
import { Round } from '../renderer/DataModel/Round';
import { CommonRuleSets } from '../renderer/DataModel/ScoringRules';
import StandardSchedule from '../renderer/DataModel/StandardSchedule';
import { Team } from '../renderer/DataModel/Team';
import Tournament from '../renderer/DataModel/Tournament';
import { ScheduledGame } from '../renderer/DataModel/ScheduledGame';
import { Sched12Teams8Rounds } from '../renderer/DataModel/Schedules/12-team';

export const bigCatNames = ['Tiger', 'Lion', 'Leopard', 'Jaguar'];

export function makeTeam(name: string, playerNames: string[]): Team {
  const team = new Team(name);
  team.players = playerNames.map((playerName) => new Player(playerName));
  return team;
}

function addBigCats(tournament: Tournament, names: string[] = bigCatNames) {
  for (const name of names) {
    const team = makeTeam(name, [`${name} One`, `${name} Two`, `${name} Three`, `${name} Four`]);
    tournament.addRegistration(new Registration(name, team));
  }
}

/**
 * A tournament using one of the shipped templates, with its teams registered afterwards.
 *
 * Teams are added after the template on purpose: that is the order a director works in, and it is the
 * order that exercises "generate once the pool's teams are known" rather than "generate when the
 * template is chosen".
 */
export function makeTemplateTournament(schedule: StandardSchedule, teamNames: string[] = bigCatNames): Tournament {
  const tournament = new Tournament('Big Cat Invitational');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);
  tournament.setStandardSchedule(schedule);
  addBigCats(tournament, teamNames);
  return tournament;
}

/**
 * A custom (non-template) tournament: one pool of four playing a quadruple round robin over 12 rounds.
 *
 * No pairings until something asks for them, because a custom schedule's pairings belong to the
 * director rather than to a template.
 */
export function makeCustomRoundRobinTournament(
  numTeams: number = 4,
  numRoundRobins: number = 4,
  numRounds: number = 12,
): Tournament {
  const tournament = new Tournament('Big Cat Custom');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);

  const pool = new Pool(numTeams, 1, 'Round Robin');
  pool.roundRobins = numRoundRobins;
  const phase = new Phase(PhaseTypes.Prelim, 1, numRounds, '1');
  phase.pools = [pool];
  tournament.phases = [phase];
  tournament.usingScheduleTemplate = false;

  const names = numTeams <= bigCatNames.length ? bigCatNames.slice(0, numTeams) : generatedNames(numTeams);
  addBigCats(tournament, names);
  return tournament;
}

function generatedNames(count: number): string[] {
  const names: string[] = [];
  for (let i = 0; i < count; i++) names.push(`Team ${i + 1}`);
  return names;
}

/** A tournament with two parallel pools in one phase, so cross-pool behaviour can be checked. */
export function makeTwoPoolTournament(): Tournament {
  const tournament = new Tournament('Two Pool Invitational');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);

  const poolA = new Pool(4, 1, 'Pool A');
  const poolB = new Pool(4, 1, 'Pool B');
  const phase = new Phase(PhaseTypes.Prelim, 1, 3, '1');
  phase.pools = [poolA, poolB];
  tournament.phases = [phase];
  tournament.usingScheduleTemplate = false;

  addBigCats(tournament, ['Tiger', 'Lion', 'Leopard', 'Jaguar', 'Puma', 'Ocelot', 'Caracal', 'Serval']);
  return tournament;
}

export function teamNamed(tournament: Tournament, name: string): Team {
  const team = tournament.getListOfAllTeams().find((entry) => entry.name === name);
  if (!team) throw new Error(`test fixture has no team called ${name}`);
  return team;
}

export function roundNumbered(tournament: Tournament, number: number): Round {
  const round = tournament.getRoundObjByNumber(number);
  if (!round) throw new Error(`test fixture has no round ${number}`);
  return round;
}

/** "Lion vs Jaguar" for every pairing in a round, in the order the round holds them. */
export function pairingNames(round: Round): string[] {
  return round.scheduledGames.map((game) => game.displayName());
}

/** Sorted "Jaguar|Lion" keys, so the two orientations of one meeting compare equal. */
export function pairKeys(round: Round): string[] {
  return round.scheduledGames.map((game) => [game.leftTeam.name, game.rightTeam.name].sort().join('|')).sort();
}

/**
 * The worked example from the specification: one explicitly customized 12-round quadruple round robin.
 *
 * Written out in full rather than generated, because the point of the fixture is that a schedule a
 * director chose - this exact round ordering, which the generic algorithm has no reason to produce -
 * can be represented, saved and reopened.
 */
export const customTwelveRoundSchedule: [string, string][][] = [
  [
    ['Lion', 'Jaguar'],
    ['Tiger', 'Leopard'],
  ],
  [
    ['Lion', 'Leopard'],
    ['Tiger', 'Jaguar'],
  ],
  [
    ['Tiger', 'Lion'],
    ['Leopard', 'Jaguar'],
  ],
  [
    ['Tiger', 'Leopard'],
    ['Lion', 'Jaguar'],
  ],
  [
    ['Tiger', 'Jaguar'],
    ['Lion', 'Leopard'],
  ],
  [
    ['Leopard', 'Jaguar'],
    ['Tiger', 'Lion'],
  ],
  [
    ['Lion', 'Jaguar'],
    ['Tiger', 'Leopard'],
  ],
  [
    ['Tiger', 'Jaguar'],
    ['Lion', 'Leopard'],
  ],
  [
    ['Tiger', 'Lion'],
    ['Leopard', 'Jaguar'],
  ],
  [
    ['Tiger', 'Leopard'],
    ['Lion', 'Jaguar'],
  ],
  [
    ['Lion', 'Leopard'],
    ['Tiger', 'Jaguar'],
  ],
  [
    ['Leopard', 'Jaguar'],
    ['Tiger', 'Lion'],
  ],
];

/** Replace a phase's pairings with the worked example, as though a director had typed each one in. */
export function applyCustomTwelveRoundSchedule(tournament: Tournament) {
  const [phase] = tournament.phases;
  phase.clearScheduledGames();
  customTwelveRoundSchedule.forEach((roundPairings, index) => {
    const round = phase.rounds[index];
    for (const [leftName, rightName] of roundPairings) {
      round.addScheduledGame(
        new ScheduledGame(teamNamed(tournament, leftName), teamNamed(tournament, rightName), {
          poolName: phase.pools[0]?.name,
          generated: false,
        }),
      );
    }
  });
  return phase;
}

// --- carryover fixtures --------------------------------------------------------------------------
//
// The 12-team, 8-round template is the case the carryover work exists for: two prelim pools of six
// over five rounds, then two playoff pools of six over *three*, because half of each playoff pool's
// round robin was already played in prelims. These helpers build that tournament the way a director
// would - apply the template, register twelve teams, play the prelims, rebracket - so the tests are
// asserting about the shipped schedule rather than about a fixture invented to suit them.

export const twelveTeamNames = [
  'Tiger',
  'Lion',
  'Leopard',
  'Jaguar',
  'Puma',
  'Ocelot',
  'Caracal',
  'Serval',
  'Lynx',
  'Cheetah',
  'Margay',
  'Kodkod',
];

/** The 12-team / 8-round template with its teams registered and nothing played yet. */
export function makeTwelveTeamCarryoverTournament(): Tournament {
  return makeTemplateTournament(Sched12Teams8Rounds, twelveTeamNames);
}

/**
 * Enter a game for every pairing in a phase, with the team on the left winning.
 *
 * Real Match objects carrying the scheduled game's id, which is what an accepted result produces.
 * The scoreline is arbitrary but deterministic, so the standings - and therefore the rebracketing -
 * come out the same every run.
 */
export function playScheduledGames(tournament: Tournament, phase: Phase) {
  for (const round of phase.rounds) {
    for (const game of round.scheduledGames.slice()) {
      const match = new Match(game.leftTeam, game.rightTeam, tournament.scoringRules.answerTypes);
      match.scheduledGameId = game.id;
      match.tossupsRead = tournament.scoringRules.regulationTossupCount;
      match.leftTeam.points = 300;
      match.rightTeam.points = 200;
      round.addMatch(match);
    }
  }
  tournament.calcHasMatchData();
}

/**
 * Put the playoff pools together and carry the prelim games into them.
 *
 * The top half of each prelim pool goes to the top playoff pool and the bottom half to the other,
 * which is what the template's advancement rules say. Carryover is then applied by the tournament's
 * own `carryOverMatches`, so what the tests see is the real carryover record rather than a marking
 * invented here.
 */
export function rebracketIntoCarryoverPools(tournament: Tournament) {
  const [prelims, playoffs] = tournament.phases;
  const half = prelims.pools[0].poolTeams.length / 2;

  for (const prelimPool of prelims.pools) {
    const teams = prelimPool.poolTeams.map((pt) => pt.team);
    teams.slice(0, half).forEach((team) => playoffs.pools[0].addTeam(team));
    teams.slice(half).forEach((team) => playoffs.pools[1].addTeam(team));
  }
  for (const playoffPool of playoffs.pools) {
    tournament.carryOverMatches(
      playoffs,
      playoffPool.poolTeams.map((pt) => pt.team),
    );
  }
  return playoffs;
}

/** Sorted "Jaguar|Lion" keys for every pairing in a phase, so meetings can be counted. */
export function meetingKeysInPhase(phase: Phase): string[] {
  return phase.rounds.flatMap((round) =>
    round.scheduledGames.map((game) => [game.leftTeam.name, game.rightTeam.name].sort().join('|')),
  );
}

/** The unordered pairs that were carried into this phase, as the same sorted keys. */
export function carriedOverMeetingKeys(tournament: Tournament, phase: Phase): string[] {
  return tournament.getCarryoverMatches(phase).map((match) => {
    const names = [match.leftTeam.team?.name ?? '', match.rightTeam.team?.name ?? ''];
    return names.sort().join('|');
  });
}

/**
 * A small hand-built tournament whose playoff pool carries exactly one game in.
 *
 * The 12-team template covers the realistic case; this one exists to make the arithmetic of repeated
 * round robins checkable by eye. Four teams in a playoff pool declaring `roundRobins` cycles, of
 * which Tiger and Lion have already met once in prelims.
 */
export function makeSingleCarryoverGameTournament(roundRobins: number, playoffRounds: number) {
  const tournament = new Tournament('Carryover Custom');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);
  tournament.usingScheduleTemplate = false;
  // Registered before any phase exists, so nothing is auto-assigned to a pool we are about to build.
  addBigCats(tournament);
  const teams = bigCatNames.map((name) => teamNamed(tournament, name));
  const [tiger, lion] = teams;

  const prelims = new Phase(PhaseTypes.Prelim, 1, 1, '1');
  const prelimPool = new Pool(2, 1, 'Prelim A');
  prelimPool.addTeam(tiger);
  prelimPool.addTeam(lion);
  prelims.pools = [prelimPool];

  const playoffs = new Phase(PhaseTypes.Playoff, 2, playoffRounds + 1, '2');
  const championship = new Pool(4, 1, 'Championship', true);
  championship.roundRobins = roundRobins;
  teams.forEach((team) => championship.addTeam(team));
  playoffs.pools = [championship];

  tournament.phases = [prelims, playoffs];

  // The one prelim game, and the tournament's own carryover marking of it.
  const match = new Match(tiger, lion, tournament.scoringRules.answerTypes);
  match.tossupsRead = tournament.scoringRules.regulationTossupCount;
  match.leftTeam.points = 300;
  match.rightTeam.points = 200;
  prelims.rounds[0].addMatch(match);
  tournament.carryOverMatches(playoffs, teams);

  return { tournament, prelims, playoffs, championship, carriedOverMatch: match };
}
