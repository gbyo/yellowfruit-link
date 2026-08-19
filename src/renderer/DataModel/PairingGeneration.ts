/**
 * Turning a pool structure into scheduled games, and knowing when not to.
 *
 * # Why this is an explicit operation
 *
 * YellowFruit reseeds and rebrackets. Pool membership changes as teams are registered, as seeds are
 * dragged around, and as a playoff phase is populated from prelim standings. If pairings were derived
 * on the fly - recomputed each render, or each time the Rooms page opened - then every one of those
 * changes would silently rewrite the schedule underneath a director who had already read it out, and
 * the identity a room is scoring against would change while the room was scoring.
 *
 * So generation happens at named moments and produces stored objects. This module is the only place
 * that decides whether a given pool's pairings may be written, replaced, or must be left alone.
 *
 * # What is never overwritten
 *
 * Three things, in increasing order of how bad it would be:
 *
 *   1. A pairing a director created or edited by hand. Automatic regeneration replaces only what the
 *      generator itself produced (`ScheduledGame.generated`), so a hand-built schedule survives a
 *      team being added.
 *   2. A pairing that is live: assigned to a room, being scored, or holding a result the director has
 *      not reviewed. That state lives in the Rooms adapter rather than in the tournament, so callers
 *      supply it through `isBusy`. Replacing one of these would orphan a game in progress.
 *   3. A pairing that has already been completed - an entered Match references it. Its identity is
 *      part of the tournament's record at that point.
 *
 * When any of those blocks a pool, the whole pool is skipped and the reason is reported. A partial
 * regeneration would be worse than none: it would leave a pool holding half of one schedule and half
 * of another, with teams playing twice in a round.
 *
 * # Carryover pools
 *
 * "One round robin" does not always mean "a round robin's worth of games in this phase". A playoff
 * pool with `hasCarryover` is one whose teams bring games with them: the meetings they had in prelims
 * count towards the pool's round robin, and only the rest are played here. That is why YellowFruit's
 * 12-team, 8-round schedule gives its six-team playoff pools three rounds rather than the five a
 * fresh six-team round robin takes.
 *
 * So the games a pool owes are computed, not assumed - from the carryover the tournament has actually
 * recorded on its Match objects - and the leftovers are packed into the rounds the phase has. The
 * carried-over matches themselves are never touched: they are history, and their only effect here is
 * that a game already played is not scheduled a second time.
 */
import { Match } from './Match';
import { Phase } from './Phase';
import { Pool } from './Pool';
import { Round } from './Round';
import {
  IRoundRobinPairing,
  IUnscheduledMeeting,
  generateRoundRobin,
  minimumRoundsForMeetings,
  packMeetingsIntoRounds,
  roundsNeededForRoundRobins,
} from './RoundRobinGenerator';
import { ScheduledGame } from './ScheduledGame';
import { Team } from './Team';

/**
 * Says whether a scheduled game is operationally live, and why.
 *
 * Supplied by the caller because the answer comes from the Rooms adapter, which is deliberately not
 * part of the tournament data model. Returning undefined means "nothing is using this game".
 */
export type ScheduledGameBusyLookup = (game: ScheduledGame) => string | undefined;

export enum PairingGenerationMode {
  /** Write pairings only for pools that have none. The automatic path, and never destructive. */
  FillOnly,
  /** Also replace pairings this generator produced. For when pool membership has changed. */
  ReplaceGenerated,
  /** Replace a pool's pairings including hand-made ones. Only from an explicit director action. */
  ReplaceAll,
}

export interface IPairingGenerationOptions {
  mode: PairingGenerationMode;
  isBusy?: ScheduledGameBusyLookup;
  /**
   * Games from earlier phases that count towards this phase's pools, if any.
   *
   * The tournament's own carryover record - `Tournament.getCarryoverMatches(phase)`, which reads the
   * `carryoverPhases` the rebracketing path stamped onto each Match. Passed in rather than looked up
   * because this module deliberately does not know about Tournament; an empty or absent list simply
   * means nothing has been carried in yet, which is the state a phase is in before it is rebracketed.
   */
  carryoverMatches?: Match[];
}

export interface IPairingGenerationOutcome {
  gamesCreated: number;
  gamesRemoved: number;
  /** One line per pool that was left alone, saying why. Safe to show a director. */
  skipped: string[];
}

function emptyOutcome(): IPairingGenerationOutcome {
  return { gamesCreated: 0, gamesRemoved: 0, skipped: [] };
}

function mergeOutcome(into: IPairingGenerationOutcome, from: IPairingGenerationOutcome) {
  into.gamesCreated += from.gamesCreated;
  into.gamesRemoved += from.gamesRemoved;
  into.skipped.push(...from.skipped);
}

/**
 * Whether this pairing came from this pool.
 *
 * The recorded pool name is the first answer, because it is the only thing that distinguishes two
 * parallel pools once a director has moved a team between them. Renaming a pool rewrites that name on
 * the pool's pairings (`Phase.renamePool`), so an accurate name is the normal case.
 *
 * The two fallbacks exist for the cases where a name cannot be trusted:
 *
 *   - No name at all: a pairing built by hand in the editor, or written by a version that did not
 *     record one. The fallback is one-sided on purpose - a game with one team in this pool is this
 *     pool's business even when the other team should not be there, because that is exactly the
 *     mistake a regeneration needs to be able to clear.
 *   - A name no pool in the phase answers to: a rename that got away, from an older file or an
 *     interrupted edit. Here the fallback is deliberately two-sided. A stale pairing is claimed only
 *     when both of its teams are in this pool, so no single malformed pairing can belong to two pools
 *     at once - which would have each pool generate over the other's schedule.
 *
 * A name that belongs to a *different* pool of the phase is never overridden. That pool owns the
 * pairing, however odd its teams look.
 */
export function scheduledGameBelongsToPool(game: ScheduledGame, pool: Pool, phase?: Phase): boolean {
  const recorded = game.poolName;
  if (recorded === undefined || recorded === '') {
    return pool.includesTeam(game.leftTeam) || pool.includesTeam(game.rightTeam);
  }
  if (recorded === pool.name) return true;
  // Without the phase there is nothing to tell a stale name from another pool's, so the name stands.
  if (!phase) return false;
  if (phase.findPoolByName(recorded)) return false;
  return pool.includesTeam(game.leftTeam) && pool.includesTeam(game.rightTeam);
}

/**
 * Why this scheduled game must not be edited or deleted right now, or undefined if it may be.
 *
 * The single answer used by generation, by the pairing editor, and by the Rooms page, so that all
 * three agree on what "in use" means.
 */
export function scheduledGameLockReason(
  game: ScheduledGame,
  round: Round,
  isBusy?: ScheduledGameBusyLookup,
): string | undefined {
  if (round.scheduledGameIsComplete(game)) return 'this game has already been played';
  return isBusy?.(game);
}

/** The pool's teams, in the pool's own order - seeded order when a template put them there. */
function poolTeams(pool: Pool): Team[] {
  return pool.poolTeams.map((pt) => pt.team);
}

/** Every scheduled game in the phase that belongs to this pool, with the round holding it. */
function existingGamesForPool(phase: Phase, pool: Pool): { game: ScheduledGame; round: Round }[] {
  const found: { game: ScheduledGame; round: Round }[] = [];
  for (const round of phase.rounds) {
    for (const game of round.scheduledGames) {
      if (scheduledGameBelongsToPool(game, pool, phase)) found.push({ game, round });
    }
  }
  return found;
}

/** A key for an unordered pair of teams, by their positions in the pool. */
function meetingKey(indexA: number, indexB: number): string {
  return indexA < indexB ? `${indexA}|${indexB}` : `${indexB}|${indexA}`;
}

/**
 * How many times each pair of this pool's teams has already met in a game carried into this phase.
 *
 * Read off the Match objects themselves - `carryoverPhases` is what the rebracketing path stamps and
 * what the standings already believe - rather than inferred from who is in which pool, or from team
 * names. Matches involving a team that is not in this pool are not this pool's carryover, and matches
 * carried into some other phase are not this phase's.
 */
function carriedOverMeetingCounts(phase: Phase, teams: Team[], carryoverMatches: Match[]): Map<string, number> {
  const teamIndex = new Map<Team, number>();
  teams.forEach((team, index) => teamIndex.set(team, index));

  const counts = new Map<string, number>();
  for (const match of carryoverMatches) {
    if (!match.carryoverPhases.includes(phase)) continue;
    const left = match.leftTeam.team;
    const right = match.rightTeam.team;
    if (!left || !right) continue;
    const leftIndex = teamIndex.get(left);
    const rightIndex = teamIndex.get(right);
    if (leftIndex === undefined || rightIndex === undefined) continue;
    const key = meetingKey(leftIndex, rightIndex);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The meetings this pool still owes, after the ones already carried into the phase.
 *
 * A carried-over game satisfies one of a pair's required meetings, not all of them: a pool declaring
 * two round robins with one A-B game carried in still needs a second A-B game. A pair whose meetings
 * are all accounted for produces nothing, which is the single-round-robin case - the two teams have
 * played, and pairing them again would be a game the format does not call for.
 */
function remainingMeetings(teams: Team[], roundRobins: number, satisfied: Map<string, number>): IUnscheduledMeeting[] {
  const meetings: IUnscheduledMeeting[] = [];
  for (let i = 0; i < teams.length - 1; i++) {
    for (let j = i + 1; j < teams.length; j++) {
      const alreadyPlayed = satisfied.get(meetingKey(i, j)) ?? 0;
      for (let copy = alreadyPlayed; copy < roundRobins; copy++) {
        // Repeated meetings alternate sides, counting the carried-over ones, so a pair that has
        // already met does not get the same team on the left of the pairing sheet again.
        const mirrored = copy % 2 === 1;
        meetings.push({
          leftTeam: mirrored ? teams[j] : teams[i],
          rightTeam: mirrored ? teams[i] : teams[j],
        });
      }
    }
  }
  return meetings;
}

/** Either the pairings a pool should have, or the reason it cannot have any. */
interface IPairingPlan {
  pairings: IRoundRobinPairing[];
  failure?: string;
}

/**
 * Work out a pool's pairings without writing anything.
 *
 * Separate from the writing so that a pool whose schedule cannot be laid out is left exactly as it
 * was. Deleting first and discovering the problem afterwards would leave a pool with no schedule at
 * all, which is worse than the schedule it had.
 *
 * # Carryover
 *
 * A pool that carries over needs only the meetings its teams have not already had. YellowFruit's
 * shipped 12-team, 8-round schedule is the case to keep in mind: two playoff pools of six over three
 * rounds, where three of every six teams have already played each other in prelims. A fresh six-team
 * round robin would need five rounds; the nine meetings actually outstanding need three. So the round
 * requirement for a carryover pool is not `roundsPerRoundRobin * roundRobins` - it is whether what is
 * left over fits in the rounds the phase has.
 */
function planPairingsForPool(phase: Phase, pool: Pool, teams: Team[], carryoverMatches?: Match[]): IPairingPlan {
  const satisfied = pool.hasCarryover
    ? carriedOverMeetingCounts(phase, teams, carryoverMatches ?? [])
    : new Map<string, number>();
  let carriedOverCount = 0;
  satisfied.forEach((count) => {
    carriedOverCount += count;
  });

  if (carriedOverCount === 0) {
    // Nothing has been carried in - either the pool does not carry over, or it does but its feeder
    // games have not been stamped for this phase yet. Either way the whole round robin is outstanding,
    // and the circle method lays that out more evenly than general packing ever will.
    const roundsNeeded = roundsNeededForRoundRobins(teams.length, pool.roundRobins);
    if (phase.rounds.length < roundsNeeded) {
      return {
        pairings: [],
        failure: `${pool.name}: a ${pool.roundRobins}x round robin for ${teams.length} teams needs ${roundsNeeded} rounds, but ${phase.name} has ${phase.rounds.length}.`,
      };
    }
    return { pairings: generateRoundRobin(teams, pool.roundRobins) };
  }

  const meetings = remainingMeetings(teams, pool.roundRobins, satisfied);
  if (meetings.length === 0) return { pairings: [] };

  const packed = packMeetingsIntoRounds(meetings, phase.rounds.length);
  if (!packed) {
    return {
      pairings: [],
      failure: `${pool.name}: ${carriedOverCount} game${carriedOverCount === 1 ? '' : 's'} carried over, leaving ${
        meetings.length
      } to play, which needs at least ${minimumRoundsForMeetings(meetings)} rounds. ${phase.name} has ${
        phase.rounds.length
      }.`,
    };
  }
  return { pairings: packed };
}

/**
 * Write the round-robin pairings for one pool.
 *
 * Rounds are taken in order from the phase, starting at its first. Rounds are never created: a phase
 * that is too short for the games its pool still owes is a schedule the director has to correct, and
 * inventing rounds here would quietly change how long the tournament is.
 *
 * What the pool owes is not always a whole round robin. See `planPairingsForPool` for the carryover
 * case, where some of the meetings have already been played in an earlier phase.
 */
export function generatePairingsForPool(
  phase: Phase,
  pool: Pool,
  options: IPairingGenerationOptions,
): IPairingGenerationOutcome {
  const outcome = emptyOutcome();
  const { mode, isBusy, carryoverMatches } = options;

  if (pool.roundRobins < 1) {
    // Not an oversight. A pool with no round robin plays arbitrary matchups, so there is nothing to
    // derive - its games are created in the pairing editor or assigned manually in Rooms.
    return outcome;
  }

  const teams = poolTeams(pool);
  if (teams.length < 2) {
    outcome.skipped.push(`${pool.name}: not enough teams have been assigned yet.`);
    return outcome;
  }
  if (teams.length < pool.size && mode !== PairingGenerationMode.ReplaceAll) {
    // Half a pool produces a round robin among the wrong set of teams. Waiting costs nothing; the
    // automatic path runs again as soon as the last team lands.
    outcome.skipped.push(`${pool.name}: waiting for all ${pool.size} teams to be assigned.`);
    return outcome;
  }

  // Decided before anything is removed, so that a pool whose games will not fit keeps the schedule it
  // already had rather than being left with none.
  const plan = planPairingsForPool(phase, pool, teams, carryoverMatches);
  if (plan.failure !== undefined) {
    outcome.skipped.push(plan.failure);
    return outcome;
  }

  const existing = existingGamesForPool(phase, pool);
  if (existing.length > 0) {
    if (mode === PairingGenerationMode.FillOnly) {
      outcome.skipped.push(`${pool.name}: already has pairings.`);
      return outcome;
    }
    if (mode === PairingGenerationMode.ReplaceGenerated && existing.some((entry) => !entry.game.generated)) {
      outcome.skipped.push(`${pool.name}: has pairings that were entered or edited by hand.`);
      return outcome;
    }
    // Anything live blocks the entire pool. See the file comment on why this is all-or-nothing.
    const blocked = existing
      .map((entry) => {
        const reason = scheduledGameLockReason(entry.game, entry.round, isBusy);
        return reason ? `${entry.game.displayName()} (${reason})` : undefined;
      })
      .filter((reason): reason is string => reason !== undefined);
    if (blocked.length > 0) {
      outcome.skipped.push(`${pool.name}: cannot be regenerated because ${blocked.join('; ')}.`);
      return outcome;
    }
    for (const entry of existing) {
      entry.round.deleteScheduledGame(entry.game);
      outcome.gamesRemoved++;
    }
  }

  if (teams.length < pool.size) {
    outcome.skipped.push(`${pool.name}: generated for the ${teams.length} teams assigned so far, out of ${pool.size}.`);
  }

  for (const pairing of plan.pairings) {
    const round = phase.rounds[pairing.roundOffset];
    if (!round) continue;
    round.addScheduledGame(
      new ScheduledGame(pairing.leftTeam, pairing.rightTeam, { poolName: pool.name, generated: true }),
    );
    outcome.gamesCreated++;
  }
  return outcome;
}

/**
 * Write the round-robin pairings for every pool in a phase.
 *
 * Pools are generated independently and may share round numbers, which is correct: parallel pools
 * play at the same time, and teams are pool-disjoint, so two pools' games in one round never involve
 * the same team.
 */
export function generatePairingsForPhase(phase: Phase, options: IPairingGenerationOptions): IPairingGenerationOutcome {
  const outcome = emptyOutcome();
  if (!phase.isFullPhase()) return outcome;

  for (const pool of phase.pools) {
    mergeOutcome(outcome, generatePairingsForPool(phase, pool, options));
  }
  return outcome;
}

/** Whether any pool in this phase declares a round robin, and so could have pairings generated. */
export function phaseCanGeneratePairings(phase: Phase): boolean {
  return phase.isFullPhase() && phase.pools.some((pool) => pool.roundRobins >= 1);
}
