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
 */
import { Phase } from './Phase';
import { Pool } from './Pool';
import { Round } from './Round';
import { generateRoundRobin, roundsNeededForRoundRobins } from './RoundRobinGenerator';
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
 * Prefers the recorded pool name, and falls back to team membership for pairings created before a
 * pool was named or by hand in the editor. The fallback is one-sided on purpose: a game with one team
 * in this pool is this pool's business even when the other team should not be there, because that is
 * exactly the mistake a regeneration needs to be able to clear.
 */
export function scheduledGameBelongsToPool(game: ScheduledGame, pool: Pool): boolean {
  if (game.poolName !== undefined && game.poolName !== '') return game.poolName === pool.name;
  return pool.includesTeam(game.leftTeam) || pool.includesTeam(game.rightTeam);
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
      if (scheduledGameBelongsToPool(game, pool)) found.push({ game, round });
    }
  }
  return found;
}

/**
 * Write the round-robin pairings for one pool.
 *
 * Rounds are taken in order from the phase, starting at its first. Rounds are never created: a phase
 * that is too short for the round robin its pool declares is a schedule the director has to correct,
 * and inventing rounds here would quietly change how long the tournament is.
 */
export function generatePairingsForPool(
  phase: Phase,
  pool: Pool,
  options: IPairingGenerationOptions,
): IPairingGenerationOutcome {
  const outcome = emptyOutcome();
  const { mode, isBusy } = options;

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

  const roundsNeeded = roundsNeededForRoundRobins(teams.length, pool.roundRobins);
  if (phase.rounds.length < roundsNeeded) {
    outcome.skipped.push(
      `${pool.name}: a ${pool.roundRobins}x round robin for ${teams.length} teams needs ${roundsNeeded} rounds, but ${phase.name} has ${phase.rounds.length}.`,
    );
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

  for (const pairing of generateRoundRobin(teams, pool.roundRobins)) {
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
