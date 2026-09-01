import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, test } from 'vitest';
import { defaultScoresheetUrl } from '../qbtcp/PairingLaunch';
import { emptyQbtcpState, qbtcpStateVersion } from '../qbtcp/QbtcpState';
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

test('a current state without scoresheetUrl still loads with the current schema', async () => {
  const store = await newStore();
  const state = emptyQbtcpState('legacy-tournament');

  await store.save(state);
  const loaded = await store.load('legacy-tournament');

  expect(loaded.problem).toBeUndefined();
  expect(loaded.state.scoresheetUrl).toBeUndefined();
  expect(loaded.state.stateVersion).toBe(qbtcpStateVersion);
  expect(defaultScoresheetUrl).toBe('https://qbsheet.com/');
});

test('a version-one session migrates finalReceived into an explicit lifecycle and persists it', async () => {
  const store = await newStore();
  await writeRawState(store, 'legacy-lifecycle', {
    ...emptyQbtcpState('legacy-lifecycle'),
    stateVersion: 1,
    sessions: [
      {
        id: 'sess-open',
        roomId: 'room-1',
        matchId: 'Match_open',
        sessionToken: 'st-open',
        writerDeviceId: 'chromebook-1',
        progressSequence: 2,
        finalReceived: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'sess-final',
        roomId: 'room-1',
        matchId: 'Match_final',
        sessionToken: 'st-final',
        writerDeviceId: 'chromebook-1',
        progressSequence: 4,
        finalReceived: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
  });

  const loaded = await store.load('legacy-lifecycle');

  expect(loaded.problem).toBeUndefined();
  expect(loaded.state.stateVersion).toBe(qbtcpStateVersion);
  expect(loaded.state.sessions).toMatchObject([
    { id: 'sess-open', status: 'open', finalReceived: false },
    { id: 'sess-final', status: 'final-received', finalReceived: true },
  ]);

  const { directory } = store as unknown as { directory: string };
  const [file] = (await fs.promises.readdir(directory)).filter((name) => name.endsWith('.json'));
  const persisted = JSON.parse(await fs.promises.readFile(path.join(directory, file), 'utf8')) as {
    stateVersion: number;
  };
  expect(persisted.stateVersion).toBe(qbtcpStateVersion);
});

test('warning context is bounded and credential-shaped values are not restored from state', async () => {
  const store = await newStore();
  await writeRawState(store, 'warning-safety', {
    ...emptyQbtcpState('warning-safety'),
    results: [
      {
        id: 'result-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'Match_1',
        fingerprint: 'fingerprint-1',
        status: 'needs-review',
        document: { type: 'Match', id: 'Match_1' },
        receivedAt: '2026-01-01T00:00:00.000Z',
        warnings: [
          {
            code: 'match-id-mismatch',
            message: 'ignore this message',
            expected: { sessionToken: 'secret', nested: { token: 'also-secret' } },
            received: 'x'.repeat(1000),
          },
        ],
      },
    ],
  });

  const loaded = await store.load('warning-safety');
  const warning = loaded.state.results[0].warnings?.[0];
  expect(warning).toMatchObject({
    code: 'match-id-mismatch',
    message: 'That result names a different game than this session expected.',
  });
  expect(warning?.expected).toBeUndefined();
  expect(warning?.received).toHaveLength(512);
  expect(JSON.stringify(loaded.state)).not.toContain('secret');
});

test('reports discarded roster amendments and warnings, including truncation and invalid entries', async () => {
  const store = await newStore();
  const amendments = Array.from({ length: 202 }, (_, index) => ({
    teamId: 'team-1',
    teamName: 'Team One',
    playerName: `Player ${index}`,
  }));
  amendments.push(null as unknown as (typeof amendments)[number]);
  amendments.push({ teamId: 'team-1', teamName: '', playerName: 'Missing team name' });
  await writeRawState(store, 'discarded-nested', {
    ...emptyQbtcpState('discarded-nested'),
    sessions: [
      {
        id: 'session-1',
        roomId: 'room-1',
        matchId: 'Match_1',
        sessionToken: 'session-token',
        rosterAmendments: amendments,
      },
    ],
    results: [
      {
        id: 'result-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'Match_1',
        fingerprint: 'fingerprint-1',
        status: 'needs-review',
        document: { type: 'Match', id: 'Match_1' },
        receivedAt: '2026-01-01T00:00:00.000Z',
        warnings: [
          { code: 'match-id-mismatch', message: 'valid' },
          null,
          { code: 'not-a-warning', message: 'invalid code' },
        ],
      },
    ],
  });

  const loaded = await store.load('discarded-nested');

  expect(loaded.state.sessions[0].rosterAmendments).toHaveLength(200);
  expect(loaded.state.results[0].warnings).toHaveLength(1);
  expect(loaded.problem).toContain('6 saved Rooms records were damaged');
});

test('rebuilds and bounds persisted result context while retaining importer identity', async () => {
  const store = await newStore();
  await writeRawState(store, 'context-boundary', {
    ...emptyQbtcpState('context-boundary'),
    results: [
      {
        id: 'result-1',
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'Match_1',
        importedMatchId: 'Match_1',
        fingerprint: 'fingerprint-1',
        status: 'accepted',
        document: { type: 'Match', id: 'Match_1' },
        receivedAt: '2026-01-01T00:00:00.000Z',
        context: {
          tournamentId: 'context-boundary',
          roomId: 'room-1',
          roomName: 'R'.repeat(1000),
          sessionId: 'session-1',
          expectedMatchId: 'Match_1',
          expectedRoundNumber: 4,
          credentials: { token: 'must not survive' },
        },
      },
    ],
  });

  const loaded = await store.load('context-boundary');
  const result = loaded.state.results[0];

  expect(result.importedMatchId).toBe('Match_1');
  expect(result.context).toMatchObject({ tournamentId: 'context-boundary', expectedRoundNumber: 4 });
  expect(result.context?.roomName).toHaveLength(512);
  expect(result.context).not.toHaveProperty('credentials');
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
