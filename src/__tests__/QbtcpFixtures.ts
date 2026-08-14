/**
 * Fixtures for the Rooms/QBTCP adapter tests.
 *
 * Builds an ordinary YellowFruit tournament through the ordinary data model - no adapter-specific
 * construction. If these tests needed a special kind of tournament to work, that would itself be a
 * sign that the adapter had grown into the data model.
 */
import Tournament from '../renderer/DataModel/Tournament';
import { Phase, PhaseTypes } from '../renderer/DataModel/Phase';
import Registration from '../renderer/DataModel/Registration';
import { Team } from '../renderer/DataModel/Team';
import { Player } from '../renderer/DataModel/Player';
import { CommonRuleSets } from '../renderer/DataModel/ScoringRules';

export function makeTeam(name: string, playerNames: string[]): Team {
  const team = new Team(name);
  team.players = playerNames.map((playerName) => new Player(playerName));
  return team;
}

/** A tournament with one prelim phase covering rounds 1-6 and four teams of four. */
export function makeTestTournament(): Tournament {
  const tournament = new Tournament('Spring Invitational');
  tournament.scoringRules.applyRuleSet(CommonRuleSets.AcfPowers);
  tournament.phases = [new Phase(PhaseTypes.Prelim, 1, 6, '1')];

  const teams = [
    makeTeam('Ninety Six', ['Sarah', 'James', 'Alex', 'Taylor']),
    makeTeam('Greenwood', ['Emma', 'Jordan', 'Morgan', 'Casey']),
    makeTeam('Clinton', ['Riley', 'Quinn', 'Avery', 'Rowan']),
    makeTeam('Emerald', ['Sam', 'Drew', 'Noor', 'Wren']),
  ];
  for (const team of teams) {
    tournament.addRegistration(new Registration(team.name, team));
  }
  return tournament;
}

export function teamNamed(tournament: Tournament, name: string): Team {
  const team = tournament.getListOfAllTeams().find((entry) => entry.name === name);
  if (!team) throw new Error(`test fixture has no team called ${name}`);
  return team;
}

export function roundNumbered(tournament: Tournament, number: number) {
  const round = tournament.getRoundObjByNumber(number);
  if (!round) throw new Error(`test fixture has no round ${number}`);
  return round;
}

/** Every object of a given QBJ type in a serialized document. */
export function objectsOfType(document: unknown, type: string): Record<string, unknown>[] {
  const objects = (document as { objects?: unknown[] }).objects ?? [];
  return objects.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as { type?: string }).type === type,
  );
}

export interface IResultShape {
  /** 15-point answers by the left team's first player. */
  leftPowers?: number;
  /** 10-point answers by the left team's first player. */
  leftTens?: number;
  leftBonusPoints?: number;
  rightTens?: number;
  rightNegs?: number;
  rightBonusPoints?: number;
  tossupsRead?: number;
}

/**
 * A completed result document, as QBSheet would return it for an assignment.
 *
 * Built by filling in the assignment the way the profile describes: the same `Tournament.id`, `Round`,
 * `Match.id` and team identifiers, with scoring content added. That preservation of identity is what
 * makes reconciliation on this side a lookup rather than a guess.
 *
 * The numbers are a real, internally consistent game rather than arbitrary totals. `bonus_points` is
 * supplied and `points` is deliberately omitted, so YellowFruit derives each team's total from the
 * tossups and bonuses itself - which means the fixture cannot drift into a state its own validation
 * would reject, and a test failure means a real defect rather than an implausible fixture.
 *
 * The defaults: Ninety Six 4 powers and 4 tens (100 on tossups, 8 bonuses, 150 bonus points = 250);
 * Greenwood 3 tens and a neg (25 on tossups, 3 bonuses, 50 bonus points = 75).
 */
export function makeResultFrom(assignment: object, shape: IResultShape = {}): object {
  const document = JSON.parse(JSON.stringify(assignment)) as { objects: Record<string, unknown>[] };
  const match = document.objects.find((entry) => entry.type === 'Match');
  if (!match) throw new Error('assignment fixture has no Match');

  const teams = (match.match_teams as { team: { $ref: string } }[]) ?? [];
  const tossupsRead = shape.tossupsRead ?? 20;
  match.tossups_read = tossupsRead;
  match.match_teams = [
    {
      team: teams[0].team,
      bonus_points: shape.leftBonusPoints ?? 150,
      match_players: [
        {
          player: { $ref: playerRefFor(document, teams[0].team.$ref) },
          tossups_heard: tossupsRead,
          answer_counts: [
            { number: shape.leftPowers ?? 4, answer_type: { value: 15 } },
            { number: shape.leftTens ?? 4, answer_type: { value: 10 } },
            { number: 0, answer_type: { value: -5 } },
          ],
        },
      ],
    },
    {
      team: teams[1].team,
      bonus_points: shape.rightBonusPoints ?? 50,
      match_players: [
        {
          player: { $ref: playerRefFor(document, teams[1].team.$ref) },
          tossups_heard: tossupsRead,
          answer_counts: [
            { number: 0, answer_type: { value: 15 } },
            { number: shape.rightTens ?? 3, answer_type: { value: 10 } },
            { number: shape.rightNegs ?? 1, answer_type: { value: -5 } },
          ],
        },
      ],
    },
  ];
  return document;
}

function playerRefFor(document: { objects: Record<string, unknown>[] }, teamRef: string): string {
  const team = document.objects.find((entry) => entry.type === 'Team' && entry.id === teamRef);
  const players = (team?.players as { id: string }[]) ?? [];
  return players[0]?.id ?? 'Player_unknown';
}
