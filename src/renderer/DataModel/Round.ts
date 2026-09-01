import { IQbjObject, IYftDataModelObject, IYftFileObject, ValidationStatuses } from './Interfaces';
// eslint-disable-next-line import/no-cycle
import { IQbjMatch, Match } from './Match';
import { IQbjPacket, Packet } from './Packet';
// eslint-disable-next-line import/no-cycle
import { Phase } from './Phase';
import { Player } from './Player';
import { QbjTypeNames } from './QbjEnums';
import { IRoomProcedure, normalizeHandoffInstruction, normalizeRoomProcedure } from './RoomProcedure';
import { IYftFileScheduledGame, ScheduledGame } from './ScheduledGame';
import { Team } from './Team';

export interface IQbjRound extends IQbjObject {
  /** The name of the round. Possibly numerical; possibly something like "Preliminary Tiebreaker" */
  name: string;
  /** Further information about this round if needed */
  description?: string;
  /** Information on what packet(s) were used in this round. If multiple packets were used for regular play, the order
   * of this array should be the order in which they were used. If this is omitted and the question_set specified in the
   * Tournament object has a packet that logically matches this round's name (e.g. "Round 1" and "Packet 1"), it can be
   * assumed that the matching packet was used (and no other packets were used) */
  packets?: IQbjPacket[];
  /** The matches that took place in this round */
  matches?: IQbjMatch[];
}

/** Round object as written to a .yft file */
export interface IYftFileRound extends IQbjRound, IYftFileObject {
  YfData: IRoundExtraData;
}

/** Additional info not in qbj but needed for a .yft file */
export interface IRoundExtraData {
  number: number;
  /** Which issue of this round's pairings is current. Old files default to the first issue. */
  revision?: number;
  nonNumericName?: string;
  /**
   * Pairings for this round that have not been played.
   *
   * Optional, and absent from every .yft written before this field existed - a file without it opens
   * with an empty list, which is indistinguishable from a tournament whose schedule was never
   * written. Deliberately here rather than in the QBJ body: a scheduled game is not a QBJ Match, and
   * emitting it as one would make a QBJ-only export claim a day of nil-nil games was played.
   */
  scheduledGames?: IYftFileScheduledGame[];
  /** Optional room-procedure replacement for this round. Omit to inherit tournament defaults. */
  roomProcedure?: IRoomProcedure;
  /** Optional handoff instruction replacement for this round. Omit to inherit tournament defaults. */
  handoffInstruction?: string;
}

/** One round of games */
export class Round implements IQbjRound, IYftDataModelObject {
  /** Number for ordering. For normal rounds, an interger. For tiebreakers/finals, might not be */
  number: number;

  /** Round-pairing revision, independent from a room's assignment revision. */
  revision: number = 1;

  private _name?: string;

  /** The name of the round */
  get name(): string {
    return this._name ? this._name : this.number.toString();
  }

  set name(str) {
    this._name = str;
  }

  description?: string;

  /** Packet used for the round. YF only supports one packet per round. */
  packet: Packet;

  /** The matches that took place in this round */
  matches: Match[] = [];

  /**
   * Pairings for this round that are scheduled but not entered.
   *
   * Kept strictly apart from `matches`. Nothing that counts, validates or reports games looks here,
   * because a scheduled game is not a game that happened. See ScheduledGame.
   */
  scheduledGames: ScheduledGame[] = [];

  /** Optional room-procedure replacement for this round. */
  roomProcedure?: IRoomProcedure;

  /** Optional handoff instruction replacement for this round. */
  handoffInstruction?: string;

  get id(): string {
    return `Round_${this.name}`;
  }

  constructor(roundNo: number, name?: string) {
    this.number = roundNo;
    if (name) this.name = name;
    this.packet = new Packet();
  }

  toFileObject(qbjOnly = false, isTopLevel = false, isReferenced = false): IQbjRound {
    const qbjObject: IQbjRound = {
      name: this.name,
      matches: this.matches.map((m) => m.toFileObject(qbjOnly, false, true)), // matches are not actually $ref-ed, but add the ID anyway because it can still be useful
    };
    if (this.packet.name) {
      qbjObject.packets = [this.packet.toFileObject()];
    }

    if (isTopLevel) qbjObject.type = QbjTypeNames.Round;
    if (isReferenced) qbjObject.id = this.id;

    if (qbjOnly) return qbjObject;

    const yfData: IRoundExtraData = {
      number: this.number,
      revision: this.revision,
      nonNumericName: this._name,
      scheduledGames: this.scheduledGames.length > 0 ? this.scheduledGames.map((sg) => sg.toFileObject()) : undefined,
      roomProcedure: this.roomProcedure ? normalizeRoomProcedure(this.roomProcedure) : undefined,
      handoffInstruction: normalizeHandoffInstruction(this.handoffInstruction),
    };
    const yftFileObj = { YfData: yfData, ...qbjObject };

    return yftFileObj;
  }

  displayName(forceNumeric: boolean = false): string {
    return this._name && !forceNumeric ? this.name : `Round ${this.number}`;
  }

  teamHasPlayedIn(team: Team, matchToIgnore?: Match) {
    return !!this.matches.find((m) => m !== matchToIgnore && (m.leftTeam.team === team || m.rightTeam.team === team));
  }

  anyMatchesExist() {
    return this.matches.length > 0;
  }

  // --- scheduled games -------------------------------------------------------------------------
  //
  // None of these touch `matches`, and nothing above them does either. That separation is the whole
  // point: `anyMatchesExist` must keep meaning "somebody entered a game", or the rule lock, the
  // Games page counts and the stat report all start describing a schedule as though it were played.

  anyScheduledGamesExist() {
    return this.scheduledGames.length > 0;
  }

  /** Advance the persisted issue of this round's schedule after a real schedule mutation. */
  touchScheduledGamesRevision() {
    this.revision = Math.max(1, this.revision ?? 1) + 1;
  }

  addScheduledGame(game: ScheduledGame, options: { bumpRevision?: boolean } = {}) {
    this.scheduledGames.push(game);
    if (options.bumpRevision !== false) this.touchScheduledGamesRevision();
  }

  deleteScheduledGame(game: ScheduledGame, options: { bumpRevision?: boolean } = {}) {
    const next = this.scheduledGames.filter((sg) => sg !== game);
    if (next.length === this.scheduledGames.length) return;
    this.scheduledGames = next;
    if (options.bumpRevision !== false) this.touchScheduledGamesRevision();
  }

  findScheduledGameById(id: string) {
    return this.scheduledGames.find((sg) => sg.id === id);
  }

  /** Scheduled games involving this team. Used to stop a team being scheduled twice in one round. */
  findScheduledGamesWithTeam(team: Team) {
    return this.scheduledGames.filter((sg) => sg.includesTeam(team));
  }

  /**
   * Whether this team is already in a scheduled game this round.
   * @param gameToIgnore The game being edited, which should not count as a conflict with itself
   */
  teamIsScheduledIn(team: Team, gameToIgnore?: ScheduledGame) {
    return !!this.scheduledGames.find((sg) => sg !== gameToIgnore && sg.includesTeam(team));
  }

  /**
   * The entered game that completed this scheduled game, if any.
   *
   * Matched on the scheduled game's own identity, never on "these two teams played sometime". A
   * quadruple round robin contains the same pair four times on purpose, and pair-matching would call
   * all four complete the moment the first was entered.
   */
  getMatchForScheduledGame(game: ScheduledGame) {
    return this.matches.find((m) => m.scheduledGameId === game.id);
  }

  scheduledGameIsComplete(game: ScheduledGame) {
    return this.getMatchForScheduledGame(game) !== undefined;
  }

  /** How many of this round's scheduled games have an entered game against them. */
  countCompletedScheduledGames() {
    return this.scheduledGames.filter((sg) => this.scheduledGameIsComplete(sg)).length;
  }

  /** Drop scheduled games that name a team the tournament no longer has. */
  removeScheduledGamesWithTeam(team: Team) {
    const next = this.scheduledGames.filter((sg) => !sg.includesTeam(team));
    if (next.length === this.scheduledGames.length) return;
    this.scheduledGames = next;
    this.touchScheduledGamesRevision();
  }

  /** Clear this round's unplayed schedule and record the new issue when something was removed. */
  clearScheduledGames() {
    if (this.scheduledGames.length === 0) return;
    this.scheduledGames = [];
    this.touchScheduledGamesRevision();
  }

  getPlayersWithData(team: Team) {
    const players: Player[] = [];
    for (const m of this.matches) {
      for (const mt of [m.leftTeam, m.rightTeam]) {
        if (mt.team !== team) continue;
        const inThisMatch = mt.getActivePlayerList();
        inThisMatch.forEach((player) => {
          if (!players.includes(player)) players.push(player);
        });
      }
    }
    return players;
  }

  findMatchesWithTeam(team: Team): Match[] {
    const ary = [];
    for (const match of this.matches) {
      if (match.leftTeam.team === team || match.rightTeam.team === team) {
        ary.push(match);
      }
    }
    return ary;
  }

  findMatchBetweenTeams(team1: Team, team2: Team, nthMatch?: number) {
    let numFound = 0;
    for (const match of this.matches) {
      if (
        (match.leftTeam.team === team1 && match.rightTeam.team === team2) ||
        (match.rightTeam.team === team1 && match.leftTeam.team === team2)
      ) {
        numFound++;
        if (nthMatch === undefined || numFound >= nthMatch) return match;
      }
    }
    return undefined;
  }

  /** Get the matches carried over into the given playoff phase */
  getCarryoverMatches(playoffPhase: Phase) {
    return this.matches.filter((m) => m.carryoverPhases.includes(playoffPhase));
  }

  addMatch(match: Match) {
    this.matches.push(match);
  }

  deleteMatch(match: Match) {
    this.matches = this.matches.filter((m) => m !== match);
  }

  /** Change to a normal numeric round where the name is just the round number. Does nothing if round is already numeric */
  resetToNumeric() {
    delete this._name;
  }

  /**
   * Count the number of matches that are in error and warning states.
   * @returns [# matches with errors, # matches with warnings]
   */
  countErrorsAndWarnings() {
    let errs = 0;
    let warns = 0;
    for (const m of this.matches) {
      const valState = m.getOverallValidationStatus();
      if (valState === ValidationStatuses.Error) errs++;
      else if (valState === ValidationStatuses.Warning) warns++;
    }
    return [errs, warns];
  }
}

/** Sort a list of rounds in ascending order. */
export function sortRounds(ary: Round[]) {
  ary.sort((a, b) => a.number - b.number);
}
