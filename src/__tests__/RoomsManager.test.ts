import { afterEach, expect, test, vi } from 'vitest';
import { QbtcpCommandResult } from '../qbtcp/QbtcpCommands';
import { IQbtcpServerStatus } from '../qbtcp/QbtcpState';
import RoomsManager from '../renderer/Modal Managers/RoomsManager';

function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, resolve: settle };
}

function status(address: string): IQbtcpServerStatus {
  return {
    running: true,
    addresses: [address],
    hasActiveWork: false,
    rooms: [],
    scoresheetUrl: 'https://qbsheet.com/',
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a poll that overlaps an existing foreground request cannot overwrite its newer status', async () => {
  const foreground = deferred<QbtcpCommandResult>();
  const poll = deferred<QbtcpCommandResult>();
  const invoke = vi.fn().mockReturnValueOnce(foreground.promise).mockReturnValueOnce(poll.promise);
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } });

  const manager = new RoomsManager();
  const foregroundStatus = status('foreground');
  const stalePollStatus = status('stale-poll');

  const foregroundRequest = manager.refresh();
  const pollRequest = manager.pollStatus();

  foreground.resolve({ ok: true, status: foregroundStatus });
  await foregroundRequest;
  expect(manager.status).toBe(foregroundStatus);

  poll.resolve({ ok: true, status: stalePollStatus });
  await pollRequest;
  expect(manager.status).toBe(foregroundStatus);
});

test('abandonSession sends the explicit command and refreshes the released room state', async () => {
  const refreshedStatus = status('after-abandon');
  const invoke = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, abandoned: true, progressSequence: 4, hadProgress: true, warning: 'progress' })
    .mockResolvedValueOnce({ ok: true, status: refreshedStatus });
  vi.stubGlobal('window', { electron: { ipcRenderer: { invoke } } });

  const manager = new RoomsManager();
  const outcome = await manager.abandonSession('session-1', 'director decision');

  expect(outcome).toEqual({ abandoned: true, warning: 'progress' });
  expect(manager.status).toBe(refreshedStatus);
  expect(invoke.mock.calls[0][1]).toEqual({
    kind: 'abandonSession',
    sessionId: 'session-1',
    reason: 'director decision',
  });
  expect(invoke.mock.calls[1][1]).toEqual({ kind: 'status' });
});
