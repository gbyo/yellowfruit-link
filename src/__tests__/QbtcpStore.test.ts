import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';
import { defaultScoresheetUrl } from '../qbtcp/PairingLaunch';
import { emptyQbtcpState } from '../qbtcp/QbtcpState';
import QbtcpStore from '../main/qbtcp/QbtcpStore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

async function newStore(): Promise<QbtcpStore> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-'));
  temporaryDirectories.push(directory);
  return new QbtcpStore(directory);
}

test('scoresheetUrl survives a state save and load', async () => {
  const store = await newStore();
  const state = emptyQbtcpState('tournament-1');
  state.scoresheetUrl = 'https://scores.example/venue?event=42';

  await store.save(state);
  const loaded = await store.load('tournament-1');

  expect(loaded.state.scoresheetUrl).toBe(state.scoresheetUrl);
});

/** A state file written straight to disk, so a load can be given something this build did not write. */
async function writeRawState(store: QbtcpStore, tournamentId: string, contents: object): Promise<void> {
  const state = emptyQbtcpState(tournamentId);
  await store.save(state); // creates the directory and the path this store will read back
  const { directory } = store as unknown as { directory: string };
  const [file] = (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.json'));
  await fs.promises.writeFile(path.join(directory, file), JSON.stringify(contents), 'utf8');
}

test('a damaged record is dropped, reported, and the file it came from is kept', async () => {
  const store = await newStore();
  await writeRawState(store, 'damaged-tournament', {
    ...emptyQbtcpState('damaged-tournament'),
    rooms: [
      { id: 'room-1', name: 'Room 1', pairingCode: '11112222', enabled: true },
      { id: 'room-2', name: 'Room 2' }, // no pairing code
    ],
    // Neither of these can be placed against a room or a game, but both would count as work
    // blocking the tournament if they were adopted.
    sessions: [{ id: 'sess-1', roomId: 'room-1', sessionToken: 'st-1' }], // no matchId
    results: [{ id: 'res-1', fingerprint: 'abcd', document: {}, status: 'needs-review' }], // no identity
  });

  const loaded = await store.load('damaged-tournament');

  expect(loaded.state.rooms.map((room) => room.id)).toEqual(['room-1']);
  expect(loaded.state.sessions).toEqual([]);
  expect(loaded.state.results).toEqual([]);
  expect(loaded.problem).toContain('damaged');

  const { directory } = store as unknown as { directory: string };
  const kept = (await fs.promises.readdir(directory)).filter((name) => name.includes('.damaged-'));
  expect(kept).toHaveLength(1);
});

test('a session written before credential-bound writers keeps its existing writer token', async () => {
  const store = await newStore();
  await writeRawState(store, 'legacy-session', {
    ...emptyQbtcpState('legacy-session'),
    sessions: [
      {
        id: 'sess-1',
        roomId: 'room-1',
        matchId: 'Match_1',
        sessionToken: 'st-legacy',
        writerDeviceId: 'chromebook-1',
        progressSequence: 3,
        finalReceived: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });

  const loaded = await store.load('legacy-session');

  expect(loaded.problem).toBeUndefined();
  expect(loaded.state.sessions[0].grants).toEqual([{ deviceId: 'chromebook-1', token: 'st-legacy' }]);
  expect(loaded.state.sessions[0].writerGrantToken).toBe('st-legacy');
  expect(loaded.state.sessions[0].writerDeviceId).toBe('chromebook-1');
});

test('a stored progress sequence the live protocol would refuse costs its session, not the file', async () => {
  const store = await newStore();
  await writeRawState(store, 'fractional-sequence', {
    ...emptyQbtcpState('fractional-sequence'),
    rooms: [{ id: 'room-1', name: 'Room 1', pairingCode: '11112222', enabled: true }],
    sessions: [{ id: 'sess-1', roomId: 'room-1', matchId: 'Match_1', sessionToken: 'st-1', progressSequence: 1.5 }],
  });

  const loaded = await store.load('fractional-sequence');

  expect(loaded.state.sessions).toEqual([]);
  expect(loaded.state.rooms).toHaveLength(1);
  expect(loaded.problem).toContain('damaged');
});

test('a room token that is not a string leaves the room unpaired rather than falsely paired', async () => {
  const store = await newStore();
  await writeRawState(store, 'bad-token', {
    ...emptyQbtcpState('bad-token'),
    rooms: [{ id: 'room-1', name: 'Room 1', pairingCode: '11112222', enabled: true, roomToken: 12345 }],
  });

  const loaded = await store.load('bad-token');

  expect(loaded.state.rooms).toHaveLength(1);
  expect(loaded.state.rooms[0].roomToken).toBeUndefined();
});

test('a blank room token leaves the room unpaired rather than falsely paired', async () => {
  const store = await newStore();
  await writeRawState(store, 'blank-token', {
    ...emptyQbtcpState('blank-token'),
    rooms: [{ id: 'room-1', name: 'Room 1', pairingCode: '11112222', enabled: true, roomToken: '   ' }],
  });

  const loaded = await store.load('blank-token');

  expect(loaded.state.rooms).toHaveLength(1);
  expect(loaded.state.rooms[0].roomToken).toBeUndefined();
  expect(loaded.problem).toContain('damaged');
});

test('invalid and future presence records are discarded on recovery', async () => {
  const store = await newStore();
  await writeRawState(store, 'presence-times', {
    ...emptyQbtcpState('presence-times'),
    presence: [
      { roomId: 'room-1', lastSeenAt: 'not-a-date' },
      { roomId: 'room-2', lastSeenAt: '2999-01-01T00:00:00.000Z' },
      { roomId: 'room-3', lastSeenAt: '2026-01-01T00:00:00.000Z' },
    ],
  });

  const loaded = await store.load('presence-times');

  expect(loaded.state.presence).toEqual([{ roomId: 'room-3', lastSeenAt: '2026-01-01T00:00:00.000Z' }]);
  expect(loaded.problem).toContain('damaged');
});

test('a legacy state without scoresheetUrl still loads unchanged', async () => {
  const store = await newStore();
  const state = emptyQbtcpState('legacy-tournament');

  await store.save(state);
  const loaded = await store.load('legacy-tournament');

  expect(loaded.problem).toBeUndefined();
  expect(loaded.state.scoresheetUrl).toBeUndefined();
  expect(loaded.state.stateVersion).toBe(1);
  expect(defaultScoresheetUrl).toBe('https://qbsheet.com/');
});

test('help requests survive restart and a pre-help state loads with an empty request list', async () => {
  const store = await newStore();
  const state = emptyQbtcpState('help-tournament');
  state.helpRequests.push({
    id: 'help-1',
    roomId: 'room-1',
    roomName: 'Room 1',
    category: 'equipment-technical',
    message: 'The buzzer is not responding.',
    status: 'open',
    createdAt: '2026-08-19T12:00:00.000Z',
    updatedAt: '2026-08-19T12:00:00.000Z',
    deviceId: 'chromebook-1',
  });

  await store.save(state);
  const loaded = await store.load('help-tournament');
  expect(loaded.problem).toBeUndefined();
  expect(loaded.state.helpRequests).toEqual(state.helpRequests);

  const legacyState: Partial<ReturnType<typeof emptyQbtcpState>> = emptyQbtcpState('pre-help-tournament');
  delete legacyState.helpRequests;
  await writeRawState(store, 'pre-help-tournament', legacyState);
  const legacyLoaded = await store.load('pre-help-tournament');
  expect(legacyLoaded.problem).toBeUndefined();
  expect(legacyLoaded.state.helpRequests).toEqual([]);
});
