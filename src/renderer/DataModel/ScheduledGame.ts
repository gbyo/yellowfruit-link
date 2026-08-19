/**
 * A pairing: two teams that are supposed to meet in a round, before anybody has played anything.
 *
 * # Why this is not a Match
 *
 * Throughout YellowFruit, the existence of a `Match` in `Round.matches` means "a game has actually
 * been entered." Statistics, game validation, the Games page's counts, the has-match-data rule lock,
 * import duplicate detection and carryover all read that array and take its contents as played
 * games. A placeholder Match would be a lie told to every one of those, and each would believe it in
 * a different, quietly wrong way - a tournament with a schedule but no results would lock its own
 * scoring rules and report nil-nil games in the standings.
 *
 * So a scheduled game is its own kind of thing. It lives beside the matches in its round rather than
 * among them, it participates in no Match-based API, and it is written to the .yft as
 * YellowFruit-specific data rather than as a QBJ `Match`.
 *
 * # Identity
 *
 * The id is opaque, generated once, and never rewritten. It is the single identity used everywhere a
 * scheduled game has to be recognised again:
 *
 *   - the QBJ `Match.id` of the assignment served to a room, and of the file exported for a room
 *     that scores offline;
 *   - the `matchId` the QBTCP server stores for the assignment and the returning result;
 *   - `Match.YfData.scheduledGameId` on the real Match created when the director accepts a result.
 *
 * One value, carried through all of them, so a network result and the file copy of the same
 * assignment resolve to the same scheduled game and nothing can drift apart. In particular this is
 * *not* recovered from `Match.id`: `Match.tryToSetId` only preserves ids of the form `Match_<n>`, so
 * an id in this format is deliberately dropped there and read from YfData instead.
 */
import { makeOpaqueId } from '../../SharedUtils';
import { IQbjRefPointer } from './Interfaces';
import { Team } from './Team';

/** A scheduled game as written into `Round.YfData`. Teams are references, never copies. */
export interface IYftFileScheduledGame {
  id: string;
  leftTeam: IQbjRefPointer;
  rightTeam: IQbjRefPointer;
  /** Name of the pool this pairing came from, when it came from one. */
  poolName?: string;
  /** False when a director created or edited this pairing by hand. See `generated`. */
  generated?: boolean;
}

/** One scheduled, unplayed game between two teams. */
export class ScheduledGame {
  /** Opaque permanent identity. See the file comment - this is the identity the whole path uses. */
  readonly id: string;

  leftTeam: Team;

  rightTeam: Team;

  /**
   * The pool whose round robin produced this pairing, if any.
   *
   * A name rather than a Pool reference, because pools are recreated wholesale when a file is opened
   * and when a phase is rebracketed, and a dangling object reference would outlive the pool it names.
   */
  poolName?: string;

  /**
   * Whether the round-robin generator produced this pairing.
   *
   * The distinction is what lets pool assignments change without destroying a director's work:
   * regenerating a pool's pairings replaces games it generated itself and leaves anything a person
   * touched alone.
   */
  generated: boolean;

  constructor(leftTeam: Team, rightTeam: Team, options?: { id?: string; poolName?: string; generated?: boolean }) {
    this.leftTeam = leftTeam;
    this.rightTeam = rightTeam;
    this.id = options?.id ?? ScheduledGame.makeId();
    this.poolName = options?.poolName;
    this.generated = options?.generated ?? false;
  }

  /**
   * A fresh scheduled-game id.
   *
   * The prefix is not `Match_`. That pattern is `Match.tryToSetId`'s, and a value that matched it
   * would be silently absorbed into a Match's internal numbering when a result came back.
   */
  static makeId(): string {
    return makeOpaqueId('SchedGame_', 8);
  }

  toFileObject(): IYftFileScheduledGame {
    return {
      id: this.id,
      leftTeam: this.leftTeam.toRefPointer(),
      rightTeam: this.rightTeam.toRefPointer(),
      poolName: this.poolName,
      generated: this.generated,
    };
  }

  includesTeam(team: Team) {
    return this.leftTeam === team || this.rightTeam === team;
  }

  /** "Lion vs Jaguar" */
  displayName() {
    return `${this.leftTeam.name} vs ${this.rightTeam.name}`;
  }

  /** Both teams, in left-right order. */
  teams(): Team[] {
    return [this.leftTeam, this.rightTeam];
  }

  /** A copy with the same identity, for editing without committing. */
  makeCopy(): ScheduledGame {
    return new ScheduledGame(this.leftTeam, this.rightTeam, {
      id: this.id,
      poolName: this.poolName,
      generated: this.generated,
    });
  }
}

export default ScheduledGame;
