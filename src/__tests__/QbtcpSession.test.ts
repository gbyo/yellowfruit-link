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
import {
  deviceIdHeader,
  operatorNameHeader,
  qbtcpHelpCategories,
  roomTokenHeader,
  sessionTokenHeader,
} from '../qbtcp/QbtcpProtocol';
import { IQbtcpRosterPlayerRequest } from '../qbtcp/QbtcpState';

const temporaryDirectories: string[] = [];
let server: QbtcpServer;
let baseUrl: string;
let rosterRequests: IQbtcpRosterPlayerRequest[];

async function startServer(): Promise<void> {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-session-'));
  temporaryDirectories.push(directory);
  rosterRequests = [];
  server = new QbtcpServer(new QbtcpStore(directory), {
    onResultReceived: () => {},
    onStateChanged: () => {},
    onRosterPlayerRequested: async (request) => {
      rosterRequests.push(request);
      return { ok: true };
    },
  });
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

  const received = server.unresolvedResults()[0];
  expect(received).toBeDefined();
  expect(server.classifyResults(received.document, received.id)).toEqual([{ kind: 'new' }]);

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

test('discovery advertises the current protocol without exposing tournament operations', async () => {
  const room = await server.addRoom('Secret Room 204');
  server.displayName = 'Greenwood Fall Invitational';

  const response = await fetch(baseUrl);
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    protocol: 'QBTCP',
    version: 1,
    capabilities: ['pairing', 'assignment', 'progress', 'result', 'recovery', 'help', 'presence', 'roster'],
    help_categories: qbtcpHelpCategories,
    qbj_version: '2.1.1',
    name: 'Greenwood Fall Invitational',
  });
  expect(JSON.stringify(body)).not.toContain(room.name);
  expect(JSON.stringify(body)).not.toContain(room.pairingCode);
});

test('a room device can open, read, and cancel one help request while the director can resolve it', async () => {
  const { roomToken } = await pairedRoomWithAssignment();
  const headers = {
    [roomTokenHeader]: roomToken,
    [deviceIdHeader]: 'chromebook-1',
    [operatorNameHeader]: 'Alex Scorekeeper',
  };

  expect((await call('GET', '/help', { headers })).body).toEqual({ request: null });

  const opened = await call('POST', '/help', {
    headers,
    body: { category: 'question-packet', message: 'We were given the wrong packet.' },
  });
  expect(opened.status).toBe(200);
  expect(opened.body.request).toMatchObject({
    roomName: 'Room 1',
    category: 'question-packet',
    message: 'We were given the wrong packet.',
    status: 'open',
    deviceId: 'chromebook-1',
    operatorName: 'Alex Scorekeeper',
    currentMatchup: {
      roundNumber: 3,
      roundName: 'Round 3',
      leftTeam: 'Ninety Six',
      rightTeam: 'Greenwood',
    },
  });

  const repeated = await call('POST', '/help', {
    headers,
    body: { category: 'other', message: 'A duplicate click must not create another request.' },
  });
  expect(repeated.body.request.id).toBe(opened.body.request.id);
  expect(server.getState().helpRequests).toHaveLength(1);

  const otherDevice = { ...headers, [deviceIdHeader]: 'phone-2' };
  expect((await call('GET', '/help', { headers: otherDevice })).body).toEqual({ request: null });
  expect((await call('DELETE', `/help/${opened.body.request.id}`, { headers: otherDevice })).body).toEqual({
    request: null,
  });
  expect((await call('GET', '/help', { headers })).body.request.id).toBe(opened.body.request.id);

  const cancelled = await call('DELETE', `/help/${opened.body.request.id}`, { headers });
  expect(cancelled.body.request.status).toBe('cancelled');
  expect((await call('GET', '/help', { headers })).body).toEqual({ request: null });

  const reopened = await call('POST', '/help', { headers, body: { category: 'rules-question' } });
  await server.resolveHelpRequest(reopened.body.request.id);
  expect((await call('GET', '/help', { headers })).body).toEqual({ request: null });
  expect(server.getState().helpRequests.at(-1)?.status).toBe('resolved');
});

test('the authenticated QBSheet roster extension adds players only to a team in the active session', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const opened = await openSession(roomToken, matchId, 'chromebook-1');
  const headers = { [roomTokenHeader]: roomToken, [sessionTokenHeader]: opened.body.token };

  const added = await call('POST', '/roster/players', {
    headers,
    body: { sessionId: opened.body.session_id, teamName: 'Ninety Six', playerName: 'New Player' },
  });
  expect(added.status).toBe(200);
  expect(added.body).toEqual({ added: true, teamName: 'Ninety Six', playerName: 'New Player' });
  expect(rosterRequests).toHaveLength(1);
  expect(rosterRequests[0]).toMatchObject({
    sessionId: opened.body.session_id,
    teamId: 'Team_left',
    teamName: 'Ninety Six',
    playerName: 'New Player',
  });

  const wrongTeam = await call('POST', '/roster/players', {
    headers,
    body: { sessionId: opened.body.session_id, teamName: 'Clinton', playerName: 'Another Player' },
  });
  expect(wrongTeam.status).toBe(409);
  expect(rosterRequests).toHaveLength(1);

  const missingSessionCapability = await call('POST', '/roster/players', {
    headers: { [roomTokenHeader]: roomToken },
    body: { sessionId: opened.body.session_id, teamName: 'Ninety Six', playerName: 'Another Player' },
  });
  expect(missingSessionCapability.status).toBe(401);
});

test('assignment responses and private-network preflights use the current wire contract', async () => {
  const { roomToken } = await pairedRoomWithAssignment();

  const assignment = await fetch(`${baseUrl}/assignment`, { headers: { [roomTokenHeader]: roomToken } });
  expect(assignment.status).toBe(200);
  expect(assignment.headers.get('content-type')).toBe('application/vnd.quizbowl.qbj+json');

  const status = await call('GET', '/assignment/status', { headers: { [roomTokenHeader]: roomToken } });
  expect(status.body).toMatchObject({
    state: 'assigned',
    blocked_reason: null,
    blocked_message: null,
    session: null,
    released_round: 3,
    hold_new_starts: false,
    previous: null,
    next: null,
  });

  const preflight = await fetch(`${baseUrl}/assignment`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://qbsheet.com',
      'Access-Control-Request-Method': 'GET',
      'Access-Control-Request-Headers': roomTokenHeader,
      'Access-Control-Request-Private-Network': 'true',
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get('access-control-allow-origin')).toBe('https://qbsheet.com');
  expect(preflight.headers.get('access-control-allow-private-network')).toBe('true');
  expect(preflight.headers.get('access-control-allow-headers')).toContain('access-control-request-private-network');
  expect(preflight.headers.get('vary')).toContain('Origin');
});

test('known QBTCP resources return 405 for unsupported methods before authentication', async () => {
  expect((await call('POST', '')).status).toBe(405);
  expect((await call('GET', '/pair')).status).toBe(405);
  expect((await call('POST', '/assignment')).status).toBe(405);
  expect((await call('GET', '/sessions')).status).toBe(405);
  expect((await call('DELETE', '/presence')).status).toBe(405);
  expect((await call('POST', '/sessions/not-open/recovery')).status).toBe(405);
});

test('an exact result retry stays idempotent after the room advances, while changed work receives 410', async () => {
  const { roomToken, matchId } = await pairedRoomWithAssignment();
  const roomId = server.getState().rooms[0].id;
  const opened = await openSession(roomToken, matchId, 'chromebook-1');
  const result = {
    type: 'Match',
    id: matchId,
    tossups_read: 20,
    match_teams: [
      { team: { $ref: 'Team_left' }, points: 300 },
      { team: { $ref: 'Team_right' }, points: 100 },
    ],
    _qbtcp: { version: 1, round_revision: 1 },
  };

  const first = await call('POST', `/sessions/${opened.body.session_id}/result`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: result,
  });
  expect(first.status).toBe(200);
  await server.resolveResult(server.getState().results[0].id, 'accepted');

  expect(
    await server.setAssignment(
      {
        roomId,
        roundNumber: 4,
        leftTeamId: 'Team_left',
        rightTeamId: 'Team_right',
        leftTeamName: 'Ninety Six',
        rightTeamName: 'Greenwood',
        matchId: 'Match_test02',
        document: { version: '2.1.1', objects: [] },
      },
      2,
    ),
  ).toMatchObject({ revision: 2 });

  const retry = await call('POST', `/sessions/${opened.body.session_id}/result`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: result,
  });
  expect(retry.status).toBe(200);
  expect(retry.body.duplicate).toBe(true);

  const changed = await call('POST', `/sessions/${opened.body.session_id}/result`, {
    headers: { [sessionTokenHeader]: opened.body.token },
    body: { ...result, tossups_read: 21 },
  });
  expect(changed.status).toBe(410);
});
