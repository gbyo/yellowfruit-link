/**
 * The session lifecycle rules a room's device actually runs into: who may write, what a re-pairing
 * revokes, and what a finished game will still accept.
 *
 * Driven over real HTTP against a real listener, because every one of these behaviours is a property
 * of the request path rather than of a method call. A test that reached past the routing would keep
 * passing while the route it is about stopped working.
 */
import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import QbtcpServer from '../main/qbtcp/QbtcpServer';
import QbtcpStore from '../main/qbtcp/QbtcpStore';
import { deviceIdHeader, roomTokenHeader, sessionTokenHeader } from '../qbtcp/QbtcpProtocol';

const temporaryDirectories: string[] = [];
let server: QbtcpServer;
let baseUrl: string;

async function startServer(): Promise<void> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-session-'));
  temporaryDirectories.push(directory);
  server = new QbtcpServer(new QbtcpStore(directory), { onResultReceived: () => {}, onStateChanged: () => {} });
  await server.bindTournament('tournament-under-test');
  // Port zero so the OS picks a free one; nothing here may depend on a port being available.
  await server.start(0);
  baseUrl = `http://127.0.0.1:${server.port}/qbtcp/v1`;
}

beforeEach(startServer);

afterEach(async () => {
  await server.stop();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => fs.promises.rm(directory, { recursive: true, force: true })),
  );
});

async function call(
  method: string,
  route: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

/** A paired room holding an assignment, which is the state every session test starts from. */
async function pairedRoomWithAssignment(): Promise<{ roomToken: string; matchId: string }> {
  const room = await server.addRoom('Room 1');
  const matchId = 'Match_test01';
  const assigned = await server.setAssignment({
    roomId: room.id,
    roundNumber: 3,
    leftTeamId: 'Team_left',
    rightTeamId: 'Team_right',
    leftTeamName: 'Ninety Six',
    rightTeamName: 'Greenwood',
    matchId,
    document: { version: '2.1.1', objects: [] },
  });
  expect('assigned' in assigned).toBe(false);
  const paired = await call('POST', '/pair', { body: { code: room.pairingCode } });
  expect(paired.status).toBe(200);
  return { roomToken: paired.body.token as string, matchId };
}

async function openSession(roomToken: string, matchId: string, deviceId?: string) {
  return call('POST', '/sessions', {
    headers: { [roomTokenHeader]: roomToken },
    body: { match_id: matchId, ...(deviceId ? { device_id: deviceId } : {}) },
  });
}

test('a second device is told it is not the writer and cannot write with what it was given', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();

  const first = await openSession(roomToken, matchId, 'chromebook-1');
  expect(first.body.writer).toBe(true);

  const second = await openSession(roomToken, matchId, 'phone-2');
  expect(second.body.writer).toBe(false);
  expect(second.body.session_id).toBe(first.body.session_id);
  // The capability it was handed is its own, so the write cannot be passed off as the writer's by
  // leaving the (informational, optional) device header off the request.
  expect(second.body.token).not.toBe(first.body.token);

  const refused = await call('PUT', `/sessions/${second.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: second.body.token },
    body: { sequence: 1, match: { tossups_read: 4 } },
  });
  expect(refused.status).toBe(409);
  expect(refused.body.can_take_over).toBe(true);

  const accepted = await call('PUT', `/sessions/${first.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: first.body.token },
    body: { sequence: 1, match: { tossups_read: 4 } },
  });
  expect(accepted.status).toBe(200);
});

test("claiming the writer's device id does not return its writable capability", async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const writer = await openSession(roomToken, matchId, 'chromebook-1');
  expect(writer.body.writer).toBe(true);

  const claimant = await openSession(roomToken, matchId, 'chromebook-1');
  expect(claimant.body.writer).toBe(false);
  expect(claimant.body.token).not.toBe(writer.body.token);

  const refused = await call('PUT', `/sessions/${claimant.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: claimant.body.token },
    body: { sequence: 1, match: {} },
  });
  expect(refused.status).toBe(409);

  const accepted = await call('PUT', `/sessions/${writer.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: writer.body.token },
    body: { sequence: 1, match: {} },
  });
  expect(accepted.status).toBe(200);
});

test('anonymous non-writer reconnects reuse one capability', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  await openSession(roomToken, matchId, 'chromebook-1');

  const first = await openSession(roomToken, matchId);
  const reopened = await openSession(roomToken, matchId);
  expect(first.body.writer).toBe(false);
  expect(reopened.body.writer).toBe(false);
  expect(reopened.body.token).toBe(first.body.token);
});

test('a takeover that names no device is refused rather than leaving the lock unowned', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const writer = await openSession(roomToken, matchId, 'chromebook-1');
  const other = await openSession(roomToken, matchId, 'phone-2');

  const refused = await call('POST', `/sessions/${other.body.session_id}/writer`, {
    // No device_id in the body, and this grant belongs to a device that never identified itself.
    headers: { [sessionTokenHeader]: (await openSession(roomToken, matchId)).body.token },
    body: { take_over: true },
  });
  expect(refused.status).toBe(400);

  // The lock is still where it was, so the original writer keeps writing and nobody else can.
  const stillRefused = await call('PUT', `/sessions/${other.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: other.body.token },
    body: { sequence: 1, match: {} },
  });
  expect(stillRefused.status).toBe(409);

  const takenOver = await call('POST', `/sessions/${other.body.session_id}/writer`, {
    headers: { [sessionTokenHeader]: other.body.token },
    body: { take_over: true, device_id: 'phone-2' },
  });
  expect(takenOver.status).toBe(200);
  expect(takenOver.body.writer).toBe(true);

  const nowRefused = await call('PUT', `/sessions/${writer.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: writer.body.token },
    body: { sequence: 1, match: {} },
  });
  expect(nowRefused.status).toBe(409);
});

test('takeover removes another live grant for the claimant', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const writer = await openSession(roomToken, matchId, 'chromebook-1');
  const claimant = await openSession(roomToken, matchId, 'chromebook-1');

  const takenOver = await call('POST', `/sessions/${claimant.body.session_id}/writer`, {
    headers: { [sessionTokenHeader]: claimant.body.token },
    body: { take_over: true },
  });
  expect(takenOver.status).toBe(200);

  const oldGrant = await call('GET', `/sessions/${writer.body.session_id}/recovery`, {
    headers: { [sessionTokenHeader]: writer.body.token },
  });
  expect(oldGrant.status).toBe(401);
});

test('re-pairing a room revokes the session its previous device was writing to', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const opened = await openSession(roomToken, matchId, 'chromebook-1');
  expect(
    (
      await call('PUT', `/sessions/${opened.body.session_id}/progress`, {
        headers: { [sessionTokenHeader]: opened.body.token },
        body: { sequence: 1, match: {} },
      })
    ).status,
  ).toBe(200);

  const room = server.getState().rooms[0];
  const repaired = await call('POST', '/pair', { body: { code: room.pairingCode } });
  expect(repaired.status).toBe(200);
  expect(repaired.body.token).not.toBe(roomToken);

  const revoked = await call('PUT', `/sessions/${opened.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: { sequence: 2, match: {} },
  });
  expect(revoked.status).toBe(401);

  // The presence of the device that is no longer this room's scorekeeper goes with it.
  expect(server.getState().presence).toEqual([]);

  // The newly paired device reopens the same session and carries on.
  const reopened = await openSession(repaired.body.token as string, matchId, 'chromebook-1');
  expect(reopened.body.session_id).toBe(opened.body.session_id);
  expect(reopened.body.writer).toBe(true);
});

test('a finished game stops accepting progress and stops being offered as resumable', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const opened = await openSession(roomToken, matchId, 'chromebook-1');

  const final = await call('POST', `/sessions/${opened.body.session_id}/result`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: {
      type: 'Match',
      id: matchId,
      tossups_read: 20,
      match_teams: [{ team: { $ref: 'Team_left' } }, { team: { $ref: 'Team_right' } }],
    },
  });
  expect(final.status).toBe(200);
  expect(final.body.accepted).toBe(true);

  const late = await call('PUT', `/sessions/${opened.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: { sequence: 99, match: { tossups_read: 3 } },
  });
  expect(late.status).toBe(409);

  const status = await call('GET', '/assignment/status', { headers: { [roomTokenHeader]: roomToken } });
  expect(status.body.session.resumable).toBe(false);
  expect((await openSession(roomToken, matchId, 'chromebook-1')).body.final_received).toBe(true);
});

test('a progress snapshot for a different game is refused', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const opened = await openSession(roomToken, matchId, 'chromebook-1');

  const wrongGame = await call('PUT', `/sessions/${opened.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: {
      sequence: 1,
      match: { id: 'Match_somebody_else', match_teams: [{ team: { $ref: 'a' } }, { team: { $ref: 'b' } }] },
    },
  });
  expect(wrongGame.status).toBe(409);

  // A snapshot that simply does not say which game it is remains perfectly acceptable.
  const anonymous = await call('PUT', `/sessions/${opened.body.session_id}/progress`, {
    headers: { [sessionTokenHeader]: opened.body.token, [deviceIdHeader]: 'chromebook-1' },
    body: { sequence: 1, match: { tossups_read: 6 } },
  });
  expect(anonymous.status).toBe(200);
});

test('an assignment cannot be replaced or cleared while its result is waiting for review', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const roomId = server.getState().rooms[0].id;
  const opened = await openSession(roomToken, matchId, 'chromebook-1');
  await call('POST', `/sessions/${opened.body.session_id}/result`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: {
      type: 'Match',
      id: matchId,
      match_teams: [{ team: { $ref: 'Team_left' } }, { team: { $ref: 'Team_right' } }],
    },
  });

  const replaced = await server.setAssignment({
    roomId,
    roundNumber: 4,
    leftTeamId: 'Team_left',
    rightTeamId: 'Team_right',
    leftTeamName: 'Ninety Six',
    rightTeamName: 'Greenwood',
    matchId: 'Match_test02',
    document: { version: '2.1.1', objects: [] },
  });
  expect(replaced).toMatchObject({ assigned: false });
  expect(await server.clearAssignment(roomId)).toMatchObject({ cleared: false });

  const [received] = server.getState().results;
  await server.resolveResult(received.id, 'accepted');
  expect(await server.clearAssignment(roomId)).toMatchObject({ cleared: true });
});

test('an assignment built against a stale revision is refused rather than stored', async () => {
  const room = await server.addRoom('Room 1');
  const assignment = {
    roomId: room.id,
    roundNumber: 1,
    leftTeamId: 'Team_left',
    rightTeamId: 'Team_right',
    leftTeamName: 'Ninety Six',
    rightTeamName: 'Greenwood',
    document: { version: '2.1.1', objects: [] },
  };

  expect(await server.setAssignment({ ...assignment, matchId: 'Match_a' }, 1)).toMatchObject({ revision: 1 });
  // Both of these were built from one view of the page, so both claim revision 2. The second is the
  // one whose document would disagree with what the server stored.
  expect(await server.setAssignment({ ...assignment, matchId: 'Match_b' }, 2)).toMatchObject({ revision: 2 });
  expect(await server.setAssignment({ ...assignment, matchId: 'Match_c' }, 2)).toMatchObject({ assigned: false });
  expect(server.getState().assignments[0].matchId).toBe('Match_b');
});

test('the chosen self-hosted scoresheet origin is allowed through CORS', async () => {
  const selfHosted = 'https://scores.example/hosted/';
  const before = await fetch(`${baseUrl}`, { headers: { Origin: 'https://scores.example' } });
  expect(before.status).toBe(403);

  await server.setScoresheetUrl(selfHosted);

  const after = await fetch(`${baseUrl}`, { headers: { Origin: 'https://scores.example' } });
  expect(after.status).toBe(200);
  expect(after.headers.get('access-control-allow-origin')).toBe('https://scores.example');

  // Still an exact allowlist, not an opening of the door.
  const other = await fetch(`${baseUrl}`, { headers: { Origin: 'https://not-the-scoresheet.example' } });
  expect(other.status).toBe(403);
});
