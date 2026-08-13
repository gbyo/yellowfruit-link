/**
 * The one builder for a one-game QBJ assignment.
 *
 * # Why there is exactly one of these
 *
 * An assignment can leave YellowFruit two ways: over QBTCP as the body of
 * `GET /qbtcp/v1/assignment`, or onto disk as `*.assignment.qbj` for a room that will score offline.
 * Those are the same document. If they were built by two functions they would drift, and the drift
 * would surface as "the file works but the network doesn't" on a tournament morning.
 *
 * So this function is the only producer, and the network path serves exactly the bytes it returned.
 * `Rooms -> Export assignment.qbj` writes the same object for the same assignment.
 *
 * # What goes in, and what must not
 *
 * Only what this game needs: one Tournament, the ScoringRules, the relevant Phase and Round, the two
 * teams with their rosters, and one unplayed Match. No standings, no other rooms' games, no future
 * pairings - each of those is either information the end of the round makes wrong or information the
 * room has no reason to hold.
 *
 * No credential of any kind appears here. Not the pairing code, not the room or session token, not a
 * device id, not the server's address. A .qbj travels by memory stick and by email, and a capability
 * that travels with it reaches somewhere nobody intended. The builder is given no access to any of
 * them, which is the structural version of that rule rather than a promise to remember it.
 *
 * # Unplayed means unplayed
 *
 * The Match carries no scores, no `tossups_read`, and no team totals. An importer separates an
 * assignment from a result by the absence of scoring content, so a fabricated zero would destroy the
 * only signal it has. This is why `match_teams` entries name a team and stop there.
 */
import { camelCaseToSnakeCase } from './CaseConversion';
import { Phase } from './Phase';
import { Round } from './Round';
import { Team } from './Team';
import Tournament from './Tournament';
import { qbjVersion } from '../../qbtcp/QbtcpProtocol';

/** The `_qbtcp` extension key, and the version of the block's shape. */
const qbtcpExtensionKey = '_qbtcp';
const qbtcpExtensionVersion = 1;

export interface IAssignmentBuildRequest {
  tournament: Tournament;
  phase: Phase;
  round: Round;
  leftTeam: Team;
  rightTeam: Team;
  /** Stable identity for this scheduled game; becomes `Match.id` and returns on the result. */
  matchId: string;
  /** Display name of the room. Becomes `Match.location`. */
  roomName: string;
  /** Stable room identifier, which survives a rename of the room. */
  roomId: string;
  /** Which issue of this round's pairings this is. */
  roundRevision: number;
}

/** A QBJ object under construction. Deliberately loose: this file assembles a document by hand. */
type QbjNode = Record<string, unknown>;

function teamObject(team: Team): QbjNode {
  return {
    type: 'Team',
    id: team.id,
    name: team.name,
    players: team.players.map((player) => ({ type: 'Player', id: player.id, name: player.name })),
  };
}

/**
 * The Registration that owns a team, as a QBJ object naming only that team.
 *
 * A registration can own several teams (a school's A and B squads), but an assignment names only the
 * teams that play, so the others are filtered out rather than sent to a room that has no use for
 * them.
 */
function registrationObjectFor(tournament: Tournament, team: Team): QbjNode {
  const registration = tournament.registrations.find((reg) => reg.teams.includes(team));
  const name = registration?.name ?? team.name;
  const id = registration?.id ?? `Registration_${team.id}`;
  return { type: 'Registration', id, name, teams: [{ $ref: team.id }] };
}

/**
 * Say, for each answer type, whether it earns the team a bonus.
 *
 * QBJ puts `awards_bonus` on each `AnswerType`, and a scoresheet that is given bonus structure without
 * it cannot know whether a power or a neg leads to a bonus - so it refuses to score rather than guess,
 * which is the correct behaviour and a game that never starts. YellowFruit's own serializer omits the
 * field because its data model expresses the same thing as "negs don't get bonuses", so the value is
 * filled in here from that rule: a positive tossup value earns a bonus and a neg does not.
 *
 * Stated for every answer type rather than only the ambiguous ones, because "absent" is exactly what a
 * consumer is not allowed to interpret.
 */
function stateAwardsBonusExplicitly(scoringRules: QbjNode): void {
  const { answerTypes } = scoringRules;
  if (!Array.isArray(answerTypes)) return;
  for (const entry of answerTypes) {
    if (typeof entry !== 'object' || entry === null) continue;
    const answerType = entry as QbjNode;
    if (typeof answerType.awardsBonus !== 'boolean') {
      answerType.awardsBonus = typeof answerType.value === 'number' && answerType.value > 0;
    }
  }
}

/**
 * Build the assignment document.
 *
 * Returns a plain object in QBJ's snake_case spelling, ready to be serialized. The ScoringRules come
 * from YellowFruit's own serializer in its qbj-only mode, so the rules a room scores under are the
 * tournament's actual rules rather than a second description of them that could disagree.
 */
export function buildAssignmentDocument(request: IAssignmentBuildRequest): object {
  const { tournament, phase, round, leftTeam, rightTeam, matchId, roomName, roomId, roundRevision } = request;

  // qbjOnly, top-level (so it carries `type`), and referenced (so it carries `id` for the $ref).
  const scoringRules = tournament.scoringRules.toFileObject(true, true, true) as unknown as QbjNode;
  stateAwardsBonusExplicitly(scoringRules);

  const match: QbjNode = {
    type: 'Match',
    id: matchId,
    ...(roomName ? { location: roomName } : {}),
    // Written in camelCase, like every other YellowFruit serializer, because the conversion below
    // assigns each snake_case key *from* its camelCase twin. A key written in snake_case here would be
    // overwritten with undefined by that same pass.
    // No points, no totals: this game has not been played.
    matchTeams: [{ team: { $ref: leftTeam.id } }, { team: { $ref: rightTeam.id } }],
    [qbtcpExtensionKey]: {
      version: qbtcpExtensionVersion,
      round_revision: roundRevision,
      room_id: roomId,
      // The one scoring semantic QBJ cannot express. QBSheet refuses to start scoring without it
      // rather than assuming either value, so it is always sent.
      scorekeeper: { timed: tournament.scoringRules.timed },
    },
  };

  const packetName = round.packet?.name;
  const roundObject: QbjNode = {
    type: 'Round',
    id: round.id,
    // Numeric, which is what YellowFruit's own parser resolves rounds by. "Round 4" is a display
    // string and putting it here would make the round unresolvable when the result comes back.
    name: round.name,
    ...(packetName ? { packets: [{ type: 'Packet', id: `Packet_${packetName}`, name: packetName }] } : {}),
    matches: [{ $ref: matchId }],
  };

  const teams = [leftTeam, rightTeam];
  const registrations = teams.map((team) => registrationObjectFor(tournament, team));

  const tournamentObject: QbjNode = {
    type: 'Tournament',
    // The tournament half of a result's identity. This is the one place YellowFruit's private
    // tournament id is deliberately published, because deduplication needs it on the way back.
    id: tournament.ensureTournamentId(),
    name: tournament.name || Tournament.placeholderName,
    scoringRules: { $ref: scoringRules.id as string },
    registrations: registrations.map((reg) => ({ $ref: reg.id as string })),
    phases: [{ type: 'Phase', id: phase.id, name: phase.name, rounds: [roundObject] }],
  };

  const document = {
    version: qbjVersion,
    objects: [tournamentObject, scoringRules, ...registrations, ...teams.map(teamObject), match],
  };

  // YellowFruit's data model is camelCase and QBJ is snake_case, so the same conversion the .yft
  // writer uses runs here. It recurses into every nested object, including `_qbtcp` - which is safe
  // only because no key inside that block collides with a name in the conversion table.
  camelCaseToSnakeCase(document);
  return document;
}

/** Strip anything a filesystem would object to, without collapsing a name to nothing. */
function fileNameSafe(text: string): string {
  return text.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'game';
}

/**
 * The suggested file name for an exported assignment.
 *
 * Guidance for a person, never an identity: nothing decides how to parse a document from its name,
 * and a room may rename the file at any time.
 */
export function assignmentFileName(request: {
  roundNumber: number;
  roomName: string;
  leftTeamName: string;
  rightTeamName: string;
}): string {
  const round = `R${String(request.roundNumber).padStart(2, '0')}`;
  const room = fileNameSafe(request.roomName);
  return `${round}_${room}_${fileNameSafe(request.leftTeamName)}_vs_${fileNameSafe(
    request.rightTeamName,
  )}.assignment.qbj`;
}
