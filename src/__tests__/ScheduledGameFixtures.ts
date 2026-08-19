/**
 * Fixtures for the scheduled-game tests.
 *
 * Built through the ordinary data model - a template applied, teams registered one at a time, seeds
 * distributed the way the Teams page distributes them. If these tests needed a special construction
 * path to produce a schedule, that would itself be the finding.
 *
 * The four teams are the ones from the worked example: Tiger, Lion, Leopard, Jaguar.
 */
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
