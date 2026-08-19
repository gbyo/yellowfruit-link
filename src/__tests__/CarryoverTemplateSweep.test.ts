/**
 * Every shipped schedule that carries games into a later phase, played through and rebracketed.
 *
 * The carryover fix is arithmetic about a particular tournament's shape, and the shapes YellowFruit
 * ships are the ones that matter: pools of six that carry three meetings in, pools of ten that carry
 * one, playoff phases whose round count is exactly the leftovers and no more. A test of one of them
 * would leave the rest unproven, and the ones with no slack are precisely the ones a small mistake in
 * the packing would break.
 *
 * So this walks all of them: apply the template, register a full field, play the prelims, rebracket by
 * the standings the template's own advancement rules produce, and then insist that every pool comes
 * out with a schedule that fits, that nobody plays twice in a round, and that each pair of teams meets
 * exactly as often as the pool declares once the carried-over games are counted.
 */
import { expect, test } from 'vitest';
import { PairingGenerationMode } from '../renderer/DataModel/PairingGeneration';
import { Phase, PhaseTypes } from '../renderer/DataModel/Phase';
import { Pool } from '../renderer/DataModel/Pool';
import Registration from '../renderer/DataModel/Registration';
import { CommonRuleSets } from '../renderer/DataModel/ScoringRules';
import StandardSchedule from '../renderer/DataModel/StandardSchedule';
import { getTemplateList, sizesWithTemplates } from '../renderer/DataModel/ScheduleUtils';
import Tournament from '../renderer/DataModel/Tournament';
import { carriedOverMeetingKeys, makeTeam, meetingKeysInPhase, playScheduledGames } from './ScheduledGameFixtures';

/**
 * A tournament on this template with a full field registered.
 *
 * The field is sized from the pools rather than from `StandardSchedule.size`, because one shipped
 * template disagrees with its own pools about how many teams it is for and a half-empty pool would
 * make this sweep test the fixture rather than the generator. See the note in the summary.
 */
function fullFieldTournament(schedule: StandardSchedule): Tournament {
  const tournament = new Tournament('Sweep');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);
  tournament.setStandardSchedule(schedule);

  const seatsInPools = tournament.phases[0].pools.reduce((total, pool) => total + pool.size, 0);
  const fieldSize = Math.max(schedule.size, seatsInPools);
  for (let i = 0; i < fieldSize; i++) {
    const name = `T${String(i + 1).padStart(2, '0')}`;
    tournament.addRegistration(new Registration(name, makeTeam(name, [`${name} One`, `${name} Two`])));
  }
  return tournament;
}

/** Move teams into the next phase's pools by the seeds the standings gave them. */
function rebracket(tournament: Tournament, fromPhase: Phase, toPhase: Phase) {
  tournament.compileStats(false, true);
  const standings = tournament.stats.find((entry) => entry.phase === fromPhase);
  if (!standings) return;
  for (const poolStats of standings.pools) {
    for (const poolTeamStats of poolStats.poolTeams) {
      if (!poolTeamStats.currentSeed) continue;
      if (toPhase.findPoolWithTeam(poolTeamStats.team)) continue;
      toPhase.findPoolWithSeed(poolTeamStats.currentSeed)?.addTeam(poolTeamStats.team);
    }
  }
  for (const pool of toPhase.pools) {
    tournament.carryOverMatches(
      toPhase,
      pool.poolTeams.map((pt) => pt.team),
    );
  }
}

function countByKey(keys: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/** Everything that would be wrong with this phase's generated schedule, as readable lines. */
function faultsInGeneratedPhase(tournament: Tournament, phase: Phase, label: string): string[] {
  const faults: string[] = [];

  for (const round of phase.rounds) {
    const names = round.scheduledGames.flatMap((game) => [game.leftTeam.name, game.rightTeam.name]);
    if (new Set(names).size !== names.length) {
      faults.push(`${label}: a team is paired twice in ${round.displayName()}`);
    }
  }

  const effective = countByKey(meetingKeysInPhase(phase).concat(carriedOverMeetingKeys(tournament, phase)));
  for (const pool of phase.pools) {
    if (pool.roundRobins < 1) continue;
    const names = pool.poolTeams.map((pt) => pt.team.name);
    for (let i = 0; i < names.length - 1; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const key = [names[i], names[j]].sort().join('|');
        const met = effective.get(key) ?? 0;
        if (met !== pool.roundRobins) {
          faults.push(`${label}: ${pool.name} has ${names[i]} v ${names[j]} ${met} times, not ${pool.roundRobins}`);
        }
      }
    }
  }
  return faults;
}

/** Pools that a carryover phase's teams could not have been given a schedule for. */
function poolsWithCarryover(phase: Phase): Pool[] {
  return phase.pools.filter((pool) => pool.hasCarryover);
}

test('every shipped carryover phase can be scheduled once its pools are populated', () => {
  const skipped: string[] = [];
  const faults: string[] = [];
  let phasesChecked = 0;

  for (const size of sizesWithTemplates) {
    for (const schedule of getTemplateList(size)) {
      const tournament = fullFieldTournament(schedule);
      const mainPhases = tournament.phases.filter(
        (phase) => phase.phaseType === PhaseTypes.Prelim || phase.phaseType === PhaseTypes.Playoff,
      );

      for (let i = 0; i < mainPhases.length - 1; i++) {
        const current = mainPhases[i];
        const next = mainPhases[i + 1];
        if (poolsWithCarryover(next).length === 0) continue;

        playScheduledGames(tournament, current);
        rebracket(tournament, current, next);

        const label = `${schedule.size} teams / ${schedule.shortName} / ${next.name}`;
        const outcome = tournament.generatePairingsForOnePhase(next, PairingGenerationMode.ReplaceAll);
        phasesChecked++;
        // A skipped pool here is the bug this pass exists for: before it, a phase with three rounds
        // was asked for a five-round round robin and refused to produce anything at all.
        outcome.skipped.forEach((reason) => skipped.push(`${label}: ${reason}`));
        faults.push(...faultsInGeneratedPhase(tournament, next, label));
      }
    }
  }

  expect(skipped).toEqual([]);
  expect(faults).toEqual([]);
  // A guard on the sweep itself: if the templates stop reaching this code, the empty arrays above
  // would pass while proving nothing.
  expect(phasesChecked).toBeGreaterThan(50);
});
