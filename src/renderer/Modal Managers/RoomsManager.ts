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
import { makeOpaqueId } from '../../SharedUtils';
import { assignmentFileName, buildAssignmentDocument } from '../DataModel/QbjAssignment';
import { Round } from '../DataModel/Round';
import { Team } from '../DataModel/Team';
import Tournament from '../DataModel/Tournament';

function emptyStatus(): IQbtcpServerStatus {
  return { running: false, addresses: [], hasActiveWork: false, rooms: [] };
}

function noop(): void {}

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

  /** Replaced by the Rooms page while it is mounted. */
  dataChangedReactCallback: () => void = noop;

  /** Set by TournamentManager so this manager can read teams, rounds and scoring rules. */
  getTournament: () => Tournament = newEmptyTournament;

  private async send(command: QbtcpCommand): Promise<QbtcpCommandResult> {
    const requestId = ++this.nextRequestId;
    this.inFlight += 1;
    this.busy = true;
    let reply: QbtcpCommandResult = { ok: false, error: 'The Rooms adapter did not respond.' };
    try {
      this.dataChangedReactCallback();
      reply =
        ((await window.electron.ipcRenderer.invoke(IpcBidirectional.QbtcpCommand, command)) as QbtcpCommandResult) ??
        reply;
    } catch (error) {
      reply = { ok: false, error: (error as Error).message || 'The Rooms adapter did not respond.' };
    } finally {
      this.inFlight -= 1;
      this.busy = this.inFlight > 0;
      if (requestId === this.nextRequestId) {
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

  async removeRoom(roomId: string): Promise<void> {
    await this.send({ kind: 'removeRoom', roomId });
  }

  async clearAssignment(roomId: string): Promise<void> {
    await this.send({ kind: 'clearAssignment', roomId });
  }

  /**
   * Assign a game to a room.
   *
   * The QBJ document is built here, by the one shared builder, and handed to the main process to serve
   * verbatim. A fresh `matchId` is minted per assignment: a different pairing in the same room is a
   * different game, and reusing the identifier would make two games indistinguishable on the way back.
   */
  async assign(roomId: string, round: Round, leftTeam: Team, rightTeam: Team): Promise<void> {
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

    const matchId = makeOpaqueId('Match_', 8);
    const document = buildAssignmentDocument({
      tournament,
      phase,
      round,
      leftTeam,
      rightTeam,
      matchId,
      roomName: room.name,
      roomId: room.id,
      // The server increments its own revision; this is the value published in the document for the
      // assignment about to replace whatever the room had.
      roundRevision: (room.assignment?.revision ?? 0) + 1,
    });

    await this.send({
      kind: 'setAssignment',
      roomId,
      roundNumber: round.number,
      leftTeamId: leftTeam.id,
      rightTeamId: rightTeam.id,
      leftTeamName: leftTeam.name,
      rightTeamName: rightTeam.name,
      matchId,
      document,
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
