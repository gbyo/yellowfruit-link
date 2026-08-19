/**
 * The renderer's view of the Rooms adapter.
 *
 * # What it is and is not
 *
 * It is a thin front for one IPC channel. It holds the status the main process last reported, asks for
 * commands, and tells React to re-render. It contains no protocol, no HTTP, and no session state -
 * those live in the main process, because a rejected network request must not be able to unmount the
 * application.
 *
 * # It never throws at a component
 *
 * Every method resolves. A failed command becomes `lastError`, which the Rooms page displays. A
 * component that had to catch would be a component that can crash the page it is part of, and the one
 * thing this adapter must not do is take YellowFruit down with it.
 */
import { createContext } from 'react';
import { IpcBidirectional } from '../../IPCChannels';
import { QbtcpCommand, QbtcpCommandResult } from '../../qbtcp/QbtcpCommands';
import { IQbtcpServerStatus } from '../../qbtcp/QbtcpState';
import { defaultQbtcpPort, isValidQbtcpPort } from '../../qbtcp/QbtcpProtocol';
import { defaultScoresheetUrl } from '../../qbtcp/PairingLaunch';
import { makeOpaqueId } from '../../SharedUtils';
import { assignmentFileName, buildAssignmentDocument } from '../DataModel/QbjAssignment';
import { Round } from '../DataModel/Round';
import { ScheduledGame } from '../DataModel/ScheduledGame';
import { Team } from '../DataModel/Team';
import Tournament from '../DataModel/Tournament';

function emptyStatus(): IQbtcpServerStatus {
  return { running: false, addresses: [], hasActiveWork: false, rooms: [], scoresheetUrl: defaultScoresheetUrl };
}

function noop(): void {}

/** A scheduled game that could be sent to a room, with the round holding it. */
export interface IEligibleScheduledGame {
  round: Round;
  game: ScheduledGame;
}

/** Placeholder so the manager is usable before TournamentManager wires the real accessor. */
function newEmptyTournament(): Tournament {
  return new Tournament();
}

export default class RoomsManager {
  status: IQbtcpServerStatus = emptyStatus();

  /** The port the director has chosen. Only meaningful until the server is running. */
  port: number = defaultQbtcpPort;

  /** The last command failure, safe to display. Cleared by the next successful command. */
  lastError?: string;

  /** True while a command is outstanding, so the page can disable its buttons. */
  busy: boolean = false;

  /** Number of commands still awaiting a reply. */
  private inFlight: number = 0;

  /** Sequence assigned to the newest command, so older replies cannot replace newer state. */
  private nextRequestId: number = 0;

  /** Sequence assigned to background polls, so older poll replies cannot replace newer status. */
  private nextPollId: number = 0;

  /** Replaced by the Rooms page while it is mounted. */
  dataChangedReactCallback: () => void = noop;

  /** Set by TournamentManager so this manager can read teams, rounds and scoring rules. */
  getTournament: () => Tournament = newEmptyTournament;

  /**
   * Run a command and fold its reply into the state the page reads.
   *
   * `background` is for the page's own status tick rather than for anything a director asked for. It
   * neither marks the manager busy nor reports its failures: a poll that flipped `busy` every few
   * seconds would blink every room's buttons out from under a hand on the way to one, and a poll that
   * wrote `lastError` would replace the message explaining what a director's last click did.
   */
  private async send(command: QbtcpCommand, background = false): Promise<QbtcpCommandResult> {
    // A background poll takes no foreground sequence number. It gets its own monotonic id and also
    // remembers the newest foreground id so a reply cannot land over a command that started later.
    const requestId = background ? 0 : ++this.nextRequestId;
    const pollId = background ? ++this.nextPollId : 0;
    const foregroundRequestIdAtDispatch = this.nextRequestId;
    const foregroundWasInFlightAtDispatch = this.inFlight > 0;
    if (!background) {
      this.inFlight += 1;
      this.busy = true;
    }
    let reply: QbtcpCommandResult = { ok: false, error: 'The Rooms adapter did not respond.' };
    try {
      this.dataChangedReactCallback();
      reply =
        ((await window.electron.ipcRenderer.invoke(IpcBidirectional.QbtcpCommand, command)) as QbtcpCommandResult) ??
        reply;
    } catch (error) {
      reply = { ok: false, error: (error as Error).message || 'The Rooms adapter did not respond.' };
    } finally {
      if (!background) {
        this.inFlight -= 1;
        this.busy = this.inFlight > 0;
      }
      if (background) {
        // A poll only fills in the quiet moments. It never lands on top of a command's outcome, an
        // older poll, a foreground request that was already active when this poll was dispatched, or
        // one that began later.
        if (
          reply.ok &&
          'status' in reply &&
          this.inFlight === 0 &&
          !foregroundWasInFlightAtDispatch &&
          pollId === this.nextPollId &&
          foregroundRequestIdAtDispatch === this.nextRequestId
        ) {
          this.status = reply.status;
        }
      } else if (requestId === this.nextRequestId) {
        // Only the newest command's reply may write state, so a slow reply cannot replace a newer one.
        if (reply.ok) {
          this.lastError = undefined;
          if ('status' in reply) this.status = reply.status;
        } else {
          this.lastError = reply.error;
        }
      }
      this.dataChangedReactCallback();
    }
    return reply;
  }

  /**
   * Attach the adapter to the open tournament.
   *
   * Called whenever the tournament changes identity. The main process refuses to rebind while a room
   * holds unresolved scored work, which is what stops a live game being orphaned by File -> Open.
   */
  async bind(tournament: Tournament): Promise<void> {
    await this.send({
      kind: 'bind',
      tournamentId: tournament.ensureTournamentId(),
      displayName: tournament.name || 'YellowFruit tournament',
    });
  }

  async refresh(): Promise<void> {
    await this.send({ kind: 'status' });
  }

  /**
   * Re-read status without disturbing anything the director is doing.
   *
   * Presence expires on a clock rather than on an event, so the Rooms page has to ask. That question
   * is the page's, not the director's, and it must not look like a command in flight.
   */
  async pollStatus(): Promise<void> {
    await this.send({ kind: 'status' }, true);
  }

  async startServer(): Promise<void> {
    await this.send({ kind: 'start', port: this.port });
  }

  async stopServer(): Promise<void> {
    await this.send({ kind: 'stop' });
  }

  setPort(port: number): void {
    if (!isValidQbtcpPort(port)) return;
    this.port = port;
    this.dataChangedReactCallback();
  }

  async addRoom(name: string): Promise<void> {
    await this.send({ kind: 'addRoom', name });
  }

  async renameRoom(roomId: string, name: string): Promise<void> {
    await this.send({ kind: 'renameRoom', roomId, name });
  }

  async setScoresheetUrl(url: string): Promise<boolean> {
    const reply = await this.send({ kind: 'setScoresheetUrl', url });
    return reply.ok;
  }

  async printPairingSheets(html: string): Promise<boolean> {
    const reply = await this.send({ kind: 'printPairingSheets', html });
    return reply.ok;
  }

  async removeRoom(roomId: string): Promise<void> {
    await this.send({ kind: 'removeRoom', roomId });
  }

  async clearAssignment(roomId: string): Promise<void> {
    await this.send({ kind: 'clearAssignment', roomId });
  }

  async resolveHelpRequest(requestId: string): Promise<void> {
    await this.send({ kind: 'resolveHelpRequest', requestId });
  }

  /**
   * Why this scheduled game cannot be assigned right now, or undefined if it can.
   *
   * Read from the room status the main process reported, which is the only place this state exists -
   * a room, its session and the results it has sent are operational facts about how a tournament is
   * being run, not part of the tournament's record, and they are persisted separately for that reason.
   *
   * A scheduled game already in the room being assigned is not busy from that room's point of view;
   * that is the "Change" case, and the row's own lock decides whether it is allowed.
   */
  scheduledGameBusyReason(scheduledGameId: string, exceptRoomId?: string): string | undefined {
    for (const room of this.status.rooms) {
      if (room.assignment?.matchId !== scheduledGameId) continue;
      if (room.id === exceptRoomId) continue;
      if (room.result?.status === 'needs-review' || room.result?.status === 'conflict') {
        return `${room.name} has a result waiting for review`;
      }
      return `it is assigned to ${room.name}`;
    }
    return undefined;
  }

  /**
   * The scheduled games this room could be given, earliest round first.
   *
   * This filtering is the substance of the scheduled-game workflow, so it lives here rather than in
   * the page: a director choosing from this list must not be able to take a game away from another
   * room, re-send one that has already been played, or displace a result nobody has reviewed. Each
   * exclusion corresponds to a state that exists for a reason:
   *
   *   - played: an entered Match already references the pairing, so its identity is part of the
   *     tournament's record;
   *   - in another room: that room is either serving it or scoring it right now;
   *   - awaiting review: the pairing has to stay where it is until the director decides what the
   *     result was, or the review ends up pointing at a game the room is no longer playing.
   *
   * The pairing currently in *this* room is still listed, so "Change" can show what the room has and
   * a director can put it back after looking at the alternatives.
   */
  eligibleScheduledGames(tournament: Tournament, roomId: string): IEligibleScheduledGame[] {
    const eligible: IEligibleScheduledGame[] = [];
    for (const phase of tournament.phases) {
      for (const round of phase.rounds) {
        for (const game of round.scheduledGames) {
          if (round.scheduledGameIsComplete(game)) continue;
          if (this.scheduledGameBusyReason(game.id, roomId)) continue;
          eligible.push({ round, game });
        }
      }
    }
    // Ascending by round, so the game offered by default is the next one to be played rather than
    // whichever phase happens to come first in the file.
    eligible.sort((a, b) => a.round.number - b.round.number);
    return eligible;
  }

  /**
   * Assign an already-scheduled game to a room.
   *
   * The normal path. The scheduled game's own identity is published as the assignment's `matchId`,
   * so the result that comes back names the pairing it was scored against rather than a game invented
   * at the moment of assignment. Sending the same scheduled game to a room twice - after a network
   * drop, say - therefore refers to the same game both times, which is what lets the server recognise
   * a retry instead of recording a second one.
   */
  async assignScheduledGame(roomId: string, round: Round, game: ScheduledGame): Promise<void> {
    await this.assign(roomId, round, game.leftTeam, game.rightTeam, game.id);
  }

  /**
   * Assign a game to a room.
   *
   * The QBJ document is built here, by the one shared builder, and handed to the main process to serve
   * verbatim.
   *
   * `matchId` is the scheduled game's identity when there is one. Without it - a tiebreaker, an
   * unusual final, a pool that plays arbitrary matchups, or a tournament with no schedule written -
   * a fresh opaque id is minted, because a manually paired game has no prior identity to reuse and
   * two such games must not be indistinguishable on the way back.
   */
  async assign(roomId: string, round: Round, leftTeam: Team, rightTeam: Team, matchId?: string): Promise<void> {
    const tournament = this.getTournament();
    const phase = tournament.findPhaseByRound(round);
    if (!phase) {
      this.lastError = 'That round is not part of any stage of this tournament.';
      this.dataChangedReactCallback();
      return;
    }
    const room = this.status.rooms.find((entry) => entry.id === roomId);
    if (!room) {
      this.lastError = 'That room could not be found.';
      this.dataChangedReactCallback();
      return;
    }

    const idToPublish = matchId ?? makeOpaqueId('Match_', 8);
    // The server increments its own revision; this is the value published in the document for the
    // assignment about to replace whatever the room had. It is sent along with the command so the
    // server can refuse a command issued from a page that had already gone out of date, rather than
    // storing a revision the document it is storing does not claim.
    const roundRevision = (room.assignment?.revision ?? 0) + 1;
    const document = buildAssignmentDocument({
      tournament,
      phase,
      round,
      leftTeam,
      rightTeam,
      matchId: idToPublish,
      roomName: room.name,
      roomId: room.id,
      roundRevision,
    });

    await this.send({
      kind: 'setAssignment',
      roomId,
      roundNumber: round.number,
      leftTeamId: leftTeam.id,
      rightTeamId: rightTeam.id,
      leftTeamName: leftTeam.name,
      rightTeamName: rightTeam.name,
      matchId: idToPublish,
      document,
      roundRevision,
    });
  }

  /**
   * Write the current assignment to a file.
   *
   * Deliberately does not rebuild the document. The main process writes the bytes it is already
   * serving, so a room that scores from this file and a room that scores over the network have
   * provably the same document. This is the fallback that has to work when the network does not.
   */
  async exportAssignment(roomId: string): Promise<boolean> {
    const room = this.status.rooms.find((entry) => entry.id === roomId);
    if (!room?.assignment) {
      this.lastError = 'That room has no assignment to export.';
      this.dataChangedReactCallback();
      return false;
    }
    const reply = await this.send({
      kind: 'exportAssignment',
      roomId,
      suggestedFileName: assignmentFileName({
        roundNumber: room.assignment.roundNumber,
        roomName: room.name,
        leftTeamName: room.assignment.leftTeamName,
        rightTeamName: room.assignment.rightTeamName,
      }),
    });
    return reply.ok && 'exported' in reply && reply.exported;
  }

  /** Whether switching tournaments would abandon scored work. Asked before a destructive switch. */
  async hasActiveWork(): Promise<boolean> {
    const reply = await this.send({ kind: 'hasActiveWork' });
    return reply.ok && 'hasActiveWork' in reply ? reply.hasActiveWork : false;
  }
}

export const RoomsContext = createContext<RoomsManager>(new RoomsManager());
