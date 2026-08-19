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
import {
  IQbtcpRosterPlayerRequest,
  IQbtcpServerStatus,
  IRoomView,
  QbtcpRosterPlayerOutcome,
} from '../../qbtcp/QbtcpState';
import { defaultQbtcpPort, isValidQbtcpPort, presenceFreshMs } from '../../qbtcp/QbtcpProtocol';
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

const pendingRosterRequests = new Map<
  string,
  { resolve: (outcome: QbtcpRosterPlayerOutcome) => void; timeout: ReturnType<typeof setTimeout> }
>();

function notify(channel: IpcMainToRend, payload?: unknown): void {
  // A destroyed window is the ordinary case during shutdown, not an error.
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send(channel, payload);
}

function requestRosterPlayer(request: IQbtcpRosterPlayerRequest): Promise<QbtcpRosterPlayerOutcome> {
  if (!targetWindow || targetWindow.isDestroyed()) {
    return Promise.resolve({ ok: false, status: 503, error: 'YellowFruit is not ready to update the roster.' });
  }
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingRosterRequests.delete(request.requestId);
      resolve({ ok: false, status: 503, error: 'YellowFruit did not finish the roster update in time.' });
    }, 6500);
    pendingRosterRequests.set(request.requestId, { resolve, timeout });
    notify(IpcMainToRend.QbtcpRosterPlayerRequested, request);
  });
}

function completeRosterPlayerRequest(requestId: string, outcome: QbtcpRosterPlayerOutcome): boolean {
  const pending = pendingRosterRequests.get(requestId);
  if (!pending) return false;
  pendingRosterRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.resolve(outcome);
  return true;
}

function ensureServer(): QbtcpServer {
  if (!server) {
    server = new QbtcpServer(new QbtcpStore(app.getPath('userData')), {
      onResultReceived: (result) => notify(IpcMainToRend.QbtcpResultReceived, result),
      onStateChanged: () => notify(IpcMainToRend.QbtcpStateChanged),
      onRosterPlayerRequested: requestRosterPlayer,
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
    const roomSessions = state.sessions.filter((s) => s.roomId === room.id);
    // With an assignment, the session for the game the room is playing now. Without one, the newest
    // session it ever had: `find` would return the oldest, so a room whose assignment was just
    // cleared would report "Final received" for a game from hours ago.
    const session = assignment
      ? roomSessions.find((s) => s.matchId === assignment.matchId)
      : roomSessions[roomSessions.length - 1];
    const presence = state.presence.find((p) => p.roomId === room.id);
    const tossupsRead = readTossupsRead(session?.progressMatch);
    // The result for the game this room is playing now, and only that game. The newest result for
    // the room would keep the last game's verdict in the Result column after the next game was
    // assigned, which reads as a verdict on the new game.
    const result = [...state.results]
      .reverse()
      .find((r) => r.roomId === room.id && (assignment ? r.matchId === assignment.matchId : true));

    const lastSeen = presence?.lastSeenAt ? Date.parse(presence.lastSeenAt) : NaN;
    return {
      id: room.id,
      name: room.name,
      pairingCode: room.pairingCode,
      enabled: room.enabled,
      paired: room.roomToken !== undefined,
      // A stopped server hears no heartbeats, so nothing can be connected to it however recently it
      // was last heard from.
      connected: instance.running && Number.isFinite(lastSeen) && Date.now() - lastSeen < presenceFreshMs,
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
      helpRequests: state.helpRequests.filter((request) => request.roomId === room.id && request.status === 'open'),
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
      const outcome = await instance.setAssignment(
        {
          roomId: command.roomId,
          roundNumber: command.roundNumber,
          leftTeamId: command.leftTeamId,
          rightTeamId: command.rightTeamId,
          leftTeamName: command.leftTeamName,
          rightTeamName: command.rightTeamName,
          matchId: command.matchId,
          document: command.document,
        },
        command.roundRevision,
      );
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
    case 'resolveHelpRequest':
      await instance.resolveHelpRequest(command.requestId);
      return { ok: true, status: buildStatus(instance) };
    case 'completeRosterPlayerRequest':
      return completeRosterPlayerRequest(command.requestId, command.outcome)
        ? { ok: true }
        : { ok: false, error: 'That roster update is no longer waiting for a response.' };
    case 'unresolvedResults':
      return { ok: true, results: instance.unresolvedResults() };
    case 'classifyResults':
      return {
        ok: true,
        comparisons: instance.classifyResults(command.document, command.reviewingResultId),
      };
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
      printWindow.show();
      printWindow.focus();
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
  if (window) return;
  for (const [requestId, pending] of pendingRosterRequests) {
    clearTimeout(pending.timeout);
    pending.resolve({ ok: false, status: 503, error: 'YellowFruit closed before applying the roster update.' });
    pendingRosterRequests.delete(requestId);
  }
}

/** Stop the server on shutdown so the port is released. */
export async function shutdownQbtcp(): Promise<void> {
  await server?.stop();
}
