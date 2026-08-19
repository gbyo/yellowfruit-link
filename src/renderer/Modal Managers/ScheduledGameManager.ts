/**
 * The edit workflow for one scheduled game.
 *
 * Follows the shape of the other Temp*Manager classes: the dialog edits this object, validation lives
 * here rather than in the component, and nothing touches the tournament until the director saves.
 *
 * The validation is the point of the class. A pairing editor that will accept anything produces the
 * three mistakes that cost a round: a team against itself, a team in two games in the same round, and
 * a game between teams from different pools. All three are caught before the schedule is written,
 * because they are much cheaper to refuse here than to discover from a room at the start of a round.
 */
import { createContext } from 'react';
import { Phase } from '../DataModel/Phase';
import { Round } from '../DataModel/Round';
import { ScheduledGame } from '../DataModel/ScheduledGame';
import { Team } from '../DataModel/Team';

function noop(): void {}

export default class ScheduledGameManager {
  modalIsOpen: boolean = false;

  /** The phase whose rounds this pairing may live in. */
  phase?: Phase;

  /** The existing pairing being edited. Absent when adding a new one. */
  originalGame?: ScheduledGame;

  /** The round the pairing was in when the dialog opened, so a move can be applied on save. */
  originalRound?: Round;

  /** The round the pairing will be in when saved. */
  round?: Round;

  leftTeam?: Team;

  rightTeam?: Team;

  teamsError: string = '';

  roundError: string = '';

  /** A note that does not prevent saving, e.g. a team that is in no pool for this phase. */
  warning: string = '';

  /** Teams that may be chosen, in the order the dialog should list them. */
  eligibleTeams: Team[] = [];

  dataChangedReactCallback: () => void = noop;

  reset() {
    delete this.phase;
    delete this.originalGame;
    delete this.originalRound;
    delete this.round;
    delete this.leftTeam;
    delete this.rightTeam;
    this.teamsError = '';
    this.roundError = '';
    this.warning = '';
    this.eligibleTeams = [];
  }

  /**
   * Open the dialog.
   * @param eligibleTeams Every team that could play in this phase, in display order
   * @param game The pairing being edited, or undefined to add a new one to `round`
   */
  openModal(phase: Phase, round: Round, eligibleTeams: Team[], game?: ScheduledGame) {
    this.reset();
    this.modalIsOpen = true;
    this.phase = phase;
    this.round = round;
    this.originalRound = round;
    this.originalGame = game;
    this.eligibleTeams = eligibleTeams;
    if (game) {
      this.leftTeam = game.leftTeam;
      this.rightTeam = game.rightTeam;
    }
    this.validateAll();
    this.dataChangedReactCallback();
  }

  closeModal(shouldSave: boolean): boolean {
    if (shouldSave) {
      this.validateAll();
      if (this.hasAnyErrors()) {
        this.dataChangedReactCallback();
        return false;
      }
      this.saveData();
    }
    this.modalIsOpen = false;
    this.reset();
    this.dataChangedReactCallback();
    return true;
  }

  /**
   * Write the pairing into the tournament.
   *
   * An edit keeps the existing pairing's identity - that identity may already be published in a room's
   * assignment or recorded against a completed match, so replacing the object with a new one would
   * break the link. Only the teams, the round and the hand-made flag change.
   */
  private saveData() {
    const { phase, round, leftTeam, rightTeam, originalGame, originalRound } = this;
    if (!phase || !round || !leftTeam || !rightTeam) return;

    if (originalGame) {
      originalGame.leftTeam = leftTeam;
      originalGame.rightTeam = rightTeam;
      // Touched by a person, so automatic regeneration must leave it - and its pool's whole schedule -
      // alone from now on.
      originalGame.generated = false;
      originalGame.poolName = ScheduledGameManager.poolNameFor(phase, leftTeam, rightTeam);
      if (originalRound && originalRound !== round) {
        originalRound.deleteScheduledGame(originalGame);
        round.addScheduledGame(originalGame);
      }
      return;
    }

    round.addScheduledGame(
      new ScheduledGame(leftTeam, rightTeam, {
        poolName: ScheduledGameManager.poolNameFor(phase, leftTeam, rightTeam),
        generated: false,
      }),
    );
  }

  /** The pool both teams share, if they share one. Left unset when they do not. */
  private static poolNameFor(phase: Phase, leftTeam: Team, rightTeam: Team): string | undefined {
    const leftPool = phase.findPoolWithTeam(leftTeam);
    const rightPool = phase.findPoolWithTeam(rightTeam);
    if (leftPool && leftPool === rightPool) return leftPool.name;
    return undefined;
  }

  setRound(round: Round) {
    this.round = round;
    this.validateAll();
    this.dataChangedReactCallback();
  }

  setTeam(whichSide: 'left' | 'right', team?: Team) {
    if (whichSide === 'left') this.leftTeam = team;
    else this.rightTeam = team;
    this.validateAll();
    this.dataChangedReactCallback();
  }

  hasAnyErrors() {
    return this.teamsError !== '' || this.roundError !== '';
  }

  validateAll() {
    this.teamsError = '';
    this.roundError = '';
    this.warning = '';

    const { phase, round, leftTeam, rightTeam, originalGame } = this;
    if (!round) {
      this.roundError = 'Choose a round.';
      return;
    }
    if (!leftTeam || !rightTeam) {
      this.teamsError = 'Choose both teams.';
      return;
    }
    if (leftTeam === rightTeam) {
      this.teamsError = 'A team cannot play itself.';
      return;
    }

    const alreadyScheduled = [leftTeam, rightTeam].filter((team) => round.teamIsScheduledIn(team, originalGame));
    if (alreadyScheduled.length > 0) {
      const names = alreadyScheduled.map((team) => team.name).join(' and ');
      const verb = alreadyScheduled.length === 1 ? 'is' : 'are';
      this.teamsError = `${names} ${verb} already scheduled in ${round.displayName()}.`;
      return;
    }

    if (!phase) return;
    const leftPool = phase.findPoolWithTeam(leftTeam);
    const rightPool = phase.findPoolWithTeam(rightTeam);
    if (leftPool && rightPool && leftPool !== rightPool) {
      this.teamsError = `${leftTeam.name} is in ${leftPool.name} and ${rightTeam.name} is in ${rightPool.name}.`;
      return;
    }
    if (!leftPool || !rightPool) {
      const unassigned = [!leftPool ? leftTeam.name : undefined, !rightPool ? rightTeam.name : undefined].filter(
        (name): name is string => name !== undefined,
      );
      this.warning = `${unassigned.join(' and ')} ${unassigned.length === 1 ? 'is' : 'are'} not in any pool in ${
        phase.name
      }.`;
    }
  }
}

export const ScheduledGameModalContext = createContext<ScheduledGameManager>(new ScheduledGameManager());
