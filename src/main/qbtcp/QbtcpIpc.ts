/**
 * The main-process side of the Rooms adapter: one IPC handler, and the server it owns.
 *
 * Everything here is additive. Nothing in this file is reachable unless the renderer sends a QBTCP
 * command, so a build with the Rooms page never opened behaves exactly as upstream YellowFruit does.
 *
 * Every command is wrapped so that a failure becomes a readable reply rather than a rejected promise.
 * A rejected `invoke` in the renderer would surface as an unhandled rejection inside a React event
 * handler, which is one of the ways an adapter takes down the application it is attached to.
 */
import { app, dialog, ipcMain, BrowserWindow } from 'electron';
import fs from 'fs';
import { IpcBidirectional, IpcMainToRend } from '../../IPCChannels';
import { QbtcpCommand, QbtcpCommandResult } from '../../qbtcp/QbtcpCommands';
import { IQbtcpServerStatus, IRoomView } from '../../qbtcp/QbtcpState';
import { defaultQbtcpPort, isValidQbtcpPort } from '../../qbtcp/QbtcpProtocol';
import { defaultScoresheetUrl } from '../../qbtcp/PairingLaunch';
import QbtcpServer, { lanAddresses } from './QbtcpServer';
import QbtcpStore from './QbtcpStore';

let server: QbtcpServer | undefined;

/** The privileged scheme used only while a pairing-sheet print window is alive. */
export const pairingSheetProtocol = 'yf-pairing-sheet';

let pairingSheetHtml: string | undefined;
let pairingSheetWindow: BrowserWindow | undefined;

/** Read by the main-process protocol handler; the HTML is never written to a file. */
export function getPairingSheetHtml(): string | undefined {
  return pairingSheetHtml;
}

/** The window to notify. Held rather than looked up so a notification cannot pick the wrong window. */
let targetWindow: BrowserWindow | null = null;

function notify(channel: IpcMainToRend, payload?: unknown): void {
  // A destroyed window is the ordinary case during shutdown, not an error.
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send(channel, payload);
}

function ensureServer(): QbtcpServer {
  if (!server) {
    server = new QbtcpServer(new QbtcpStore(app.getPath('userData')), {
      onResultReceived: (result) => notify(IpcMainToRend.QbtcpResultReceived, result),
      onStateChanged: () => notify(IpcMainToRend.QbtcpStateChanged),
    });
  }
  return server;
}

/**
 * Everything the Rooms page draws, assembled from the server's state.
 *
 * Deliberately built here rather than exposing the raw state: the raw state holds pairing tokens and
 * session tokens, and the renderer has no use for either. See `IRoomView`.
 */
function buildStatus(instance: QbtcpServer): IQbtcpServerStatus {
  const state = instance.getState();
  const { port } = instance;

  const rooms: IRoomView[] = state.rooms.map((room) => {
    const assignment = state.assignments.find((a) => a.roomId === room.id);
    const session = assignment
      ? state.sessions.find((s) => s.roomId === room.id && s.matchId === assignment.matchId)
      : state.sessions.find((s) => s.roomId === room.id);
    const presence = state.presence.find((p) => p.roomId === room.id);
    const tossupsRead = readTossupsRead(session?.progressMatch);
    // The newest result for this room is the one a director acts on.
    const result = [...state.results].reverse().find((r) => r.roomId === room.id);

    const lastSeen = presence?.lastSeenAt ? Date.parse(presence.lastSeenAt) : NaN;
    return {
      id: room.id,
      name: room.name,
      pairingCode: room.pairingCode,
      enabled: room.enabled,
      paired: room.roomToken !== undefined,
      connected: Number.isFinite(lastSeen) && Date.now() - lastSeen < 45_000,
      ...(presence?.lastSeenAt ? { lastSeenAt: presence.lastSeenAt } : {}),
      ...(presence?.operatorName ? { operatorName: presence.operatorName } : {}),
      ...(assignment
        ? {
            assignment: {
              id: assignment.id,
              roundNumber: assignment.roundNumber,
              leftTeamName: assignment.leftTeamName,
              rightTeamName: assignment.rightTeamName,
              matchId: assignment.matchId,
              revision: assignment.revision,
            },
          }
        : {}),
      ...(session
        ? {
            session: {
              id: session.id,
              scoring: session.progressSequence > 0,
              ...(tossupsRead !== undefined ? { tossupsRead } : {}),
              finalReceived: session.finalReceived,
            },
          }
        : {}),
      ...(result
        ? {
            result: {
              id: result.id,
              status: result.status,
              fingerprint: result.fingerprint,
              receivedAt: result.receivedAt,
            },
          }
        : {}),
    };
  });

  return {
    running: instance.running,
    ...(port !== undefined ? { port } : {}),
    scoresheetUrl: state.scoresheetUrl ?? defaultScoresheetUrl,
    addresses: port !== undefined ? lanAddresses(port) : [],
    ...(instance.problem ? { error: instance.problem } : {}),
    hasActiveWork: instance.hasActiveWork(),
    rooms,
  };
}

/** How far a game has got, for the Rooms page. Best effort: a snapshot may not carry it. */
function readTossupsRead(match?: object): number | undefined {
  if (!match) return undefined;
  const value = match as { tossups_read?: unknown; tossupsRead?: unknown };
  const raw = value.tossups_read ?? value.tossupsRead;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

async function runCommand(command: QbtcpCommand): Promise<QbtcpCommandResult> {
  const instance = ensureServer();

  switch (command.kind) {
    case 'bind': {
      // Rebinding while a game is live would serve one tournament's rooms from another's state.
      if (instance.tournamentId && instance.tournamentId !== command.tournamentId && instance.hasActiveWork()) {
        return { ok: false, error: 'A room has unresolved scored work. Resolve it before switching tournaments.' };
      }
      if (instance.tournamentId !== command.tournamentId) {
        await instance.stop();
        await instance.bindTournament(command.tournamentId);
      }
      instance.displayName = command.displayName;
      return { ok: true, status: buildStatus(instance) };
    }
    case 'status':
      return { ok: true, status: buildStatus(instance) };
    case 'start':
      await instance.start(isValidQbtcpPort(command.port) ? command.port : defaultQbtcpPort);
      return { ok: true, status: buildStatus(instance) };
    case 'stop':
      await instance.stop();
      return { ok: true, status: buildStatus(instance) };
    case 'addRoom':
      await instance.addRoom(command.name);
      return { ok: true, status: buildStatus(instance) };
    case 'renameRoom':
      await instance.renameRoom(command.roomId, command.name);
      return { ok: true, status: buildStatus(instance) };
    case 'setScoresheetUrl':
      await instance.setScoresheetUrl(command.url);
      return { ok: true, status: buildStatus(instance) };
    case 'removeRoom': {
      const outcome = await instance.removeRoom(command.roomId);
      if (!outcome.removed) return { ok: false, error: outcome.reason ?? 'That room could not be removed.' };
      return { ok: true, status: buildStatus(instance) };
    }
    case 'setAssignment': {
      const outcome = await instance.setAssignment({
        roomId: command.roomId,
        roundNumber: command.roundNumber,
        leftTeamId: command.leftTeamId,
        rightTeamId: command.rightTeamId,
        leftTeamName: command.leftTeamName,
        rightTeamName: command.rightTeamName,
        matchId: command.matchId,
        document: command.document,
      });
      if ('assigned' in outcome && !outcome.assigned) return { ok: false, error: outcome.reason };
      return { ok: true, status: buildStatus(instance) };
    }
    case 'clearAssignment': {
      const outcome = await instance.clearAssignment(command.roomId);
      if (!outcome.cleared) return { ok: false, error: outcome.reason ?? 'That assignment could not be cleared.' };
      return { ok: true, status: buildStatus(instance) };
    }
    case 'resolveResult':
      await instance.resolveResult(command.resultId, command.status);
      return { ok: true, status: buildStatus(instance) };
    case 'unresolvedResults':
      return { ok: true, results: instance.unresolvedResults() };
    case 'classifyResult':
      return { ok: true, comparison: instance.classifyResult(command.document) };
    case 'recordFileResult':
      await instance.recordFileResult(command.document);
      return { ok: true };
    case 'hasActiveWork':
      return { ok: true, hasActiveWork: instance.hasActiveWork() };
    case 'exportAssignment': {
      const assignment = instance.getState().assignments.find((a) => a.roomId === command.roomId);
      if (!assignment) return { ok: false, error: 'That room has no assignment to export.' };
      const chosen = await dialog.showSaveDialog({
        title: 'Export assignment',
        defaultPath: command.suggestedFileName,
        filters: [{ name: 'QBJ file', extensions: ['qbj'] }],
      });
      if (chosen.canceled || !chosen.filePath) return { ok: true, exported: false };
      // The stored document, not a rebuild: this is the same object the network serves.
      await fs.promises.writeFile(chosen.filePath, JSON.stringify(assignment.document), 'utf8');
      return { ok: true, exported: true };
    }
    case 'printPairingSheets':
      await printPairingSheets(command.html);
      return { ok: true };
    default:
      return { ok: false, error: 'That Rooms command is not supported by this version.' };
  }
}

/**
 * Show the generated document in a fresh, locked-down window and invoke the native print dialog.
 *
 * The window deliberately remains open after `print` completes. A canceled print is recoverable with
 * the normal keyboard shortcut, and closing the window is the point at which the in-memory document is
 * discarded.
 */
async function printPairingSheets(html: string): Promise<void> {
  if (typeof html !== 'string' || html.trim() === '') throw new Error('There are no pairing sheets to print.');
  if (pairingSheetWindow && !pairingSheetWindow.isDestroyed()) {
    pairingSheetWindow.focus();
    throw new Error('A pairing-sheet print window is already open.');
  }

  const printWindow = new BrowserWindow({
    show: true,
    width: 900,
    height: 700,
    webPreferences: {
      javascript: false,
      nodeIntegration: false,
      sandbox: true,
      contextIsolation: true,
    },
  });
  pairingSheetHtml = html;
  pairingSheetWindow = printWindow;
  const clearInMemoryDocument = () => {
    if (pairingSheetWindow === printWindow) {
      pairingSheetWindow = undefined;
      pairingSheetHtml = undefined;
    }
  };
  printWindow.on('closed', clearInMemoryDocument);
  printWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  try {
    await printWindow.loadURL(`${pairingSheetProtocol}://pairing-sheets/`);
    if (!printWindow.isDestroyed()) {
      printWindow.webContents.print({ silent: false, printBackground: true });
    }
  } catch (error) {
    if (!printWindow.isDestroyed()) printWindow.close();
    clearInMemoryDocument();
    throw new Error(`The pairing sheets could not be prepared for printing: ${(error as Error).message}`);
  }
}

export function registerQbtcpIpc(window: BrowserWindow | null): void {
  targetWindow = window;
  ipcMain.handle(IpcBidirectional.QbtcpCommand, async (_event, command: QbtcpCommand) => {
    try {
      return await runCommand(command);
    } catch (error) {
      // The message is shown to a director. Nothing in this layer puts a token in an Error.
      return { ok: false, error: (error as Error).message || 'The Rooms adapter failed.' } as QbtcpCommandResult;
    }
  });
}

/** Called when the window changes, so notifications keep reaching a live renderer. */
export function setQbtcpWindow(window: BrowserWindow | null): void {
  targetWindow = window;
}

/** Stop the server on shutdown so the port is released. */
export async function shutdownQbtcp(): Promise<void> {
  await server?.stop();
}
