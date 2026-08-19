/**
 * A TournamentManager that can be driven from a test.
 *
 * The manager is where the four scheduled-game policies actually meet: it is what decides when a
 * rebracketing has finished, what refuses a team deletion, and what wires the Rooms adapter's idea of
 * "busy" into the tournament. Testing those through the manager rather than around it is the point -
 * a data-model-only test would pass while the button in the corner of the Teams page still deleted a
 * team out from under a room.
 *
 * Only the parts that talk to Electron are stubbed out.
 */
import { AlertColor } from '@mui/material';
import { TournamentManager } from '../renderer/TournamentManager';
import Tournament from '../renderer/DataModel/Tournament';
import { IQbtcpServerStatus, IRoomView } from '../qbtcp/QbtcpState';

/**
 * The renderer's global, as the manager reaches it.
 *
 * `globalThis` rather than `window`: these tests run under node, where there is no window until one
 * is installed. The lint environment here predates it being a declared global.
 */
// eslint-disable-next-line no-undef
const rendererGlobal = globalThis as { window?: unknown };

let savedWindow: unknown;

/** Give the manager an IPC channel that answers every command with a bare success. */
export function installRendererGlobals() {
  savedWindow = rendererGlobal.window;
  rendererGlobal.window = {
    electron: {
      ipcRenderer: {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        invoke: async (_channel: string, _command: unknown) => ({ ok: true }),
        on: () => {},
        sendMessage: () => {},
      },
    },
  };
}

export function restoreRendererGlobals() {
  rendererGlobal.window = savedWindow;
}

export class TestTournamentManager extends TournamentManager {
  /** Everything the manager tried to tell the director, in order. */
  toasts: { message: string; severity?: AlertColor }[] = [];

  // eslint-disable-next-line class-methods-use-this
  addIpcListeners(): void {}

  // eslint-disable-next-line class-methods-use-this
  protected setWindowTitle(): void {}

  // eslint-disable-next-line class-methods-use-this
  requestAppVersion(): void {}

  // eslint-disable-next-line class-methods-use-this
  requestBackupFile(): void {}

  // eslint-disable-next-line class-methods-use-this
  checkForNewVersion(): void {}

  // eslint-disable-next-line class-methods-use-this
  setFilePath(): void {}

  constructor() {
    super();
    this.makeToast = (message: string, severity?: AlertColor) => {
      this.toasts.push({ message, severity });
    };
  }

  /** Open an already-built tournament, through the same wiring that opening a file uses. */
  loadTournament(tournament: Tournament) {
    this.tournament = tournament;
    this.modalManagersSetTournament();
    this.toasts = [];
  }

  /** Put the Rooms adapter into the state the main process would have reported. */
  setRooms(rooms: IRoomView[]) {
    const status: IQbtcpServerStatus = {
      running: true,
      scoresheetUrl: 'https://example.invalid/qbsheet',
      addresses: ['http://192.168.1.5:8710'],
      hasActiveWork: rooms.some((room) => room.session !== undefined || room.result !== undefined),
      rooms,
    };
    this.roomsManager.status = status;
  }

  /** Answer the confirmation dialog the manager last opened. */
  answerConfirmation(accept: boolean) {
    this.genericModalManager.close(accept);
  }
}

/** A room holding an assignment for a scheduled game, optionally scoring it or holding its result. */
export function roomWithAssignment(
  id: string,
  name: string,
  scheduledGameId: string,
  roundNumber: number,
  extra: Partial<IRoomView> = {},
): IRoomView {
  return {
    id,
    name,
    pairingCode: 'ABCD',
    enabled: true,
    paired: true,
    connected: true,
    assignment: {
      id: `assignment-${scheduledGameId}`,
      roundNumber,
      leftTeamName: 'Left',
      rightTeamName: 'Right',
      matchId: scheduledGameId,
      revision: 1,
    },
    ...extra,
  };
}
