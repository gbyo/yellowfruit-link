import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect, test } from 'vitest';
import QbtcpServer, { validateResultAgainstAssignment } from '../main/qbtcp/QbtcpServer';
import QbtcpStore from '../main/qbtcp/QbtcpStore';
import {
  compareToRecorded,
  findResultMatchList,
  readResultIdentity,
  readResultSourceMetadata,
} from '../qbtcp/ResultFingerprint';
import { IRoomAssignment } from '../qbtcp/QbtcpState';
import { buildAssignmentDocument } from '../renderer/DataModel/QbjAssignment';
import { makeTestTournament, roundNumbered, teamNamed } from './QbtcpFixtures';

function buildFixture(): { assignment: IRoomAssignment; tournamentId: string } {
  const tournament = makeTestTournament();
  const round = roundNumbered(tournament, 4);
  const phase = tournament.findPhaseByRound(round);
  if (!phase) throw new Error('fixture round has no phase');
  const leftTeam = teamNamed(tournament, 'Ninety Six');
  const rightTeam = teamNamed(tournament, 'Greenwood');
  const matchId = 'Match_abc123';
  const document = buildAssignmentDocument({
    tournament,
    phase,
    round,
    leftTeam,
    rightTeam,
    matchId,
    roomName: 'Room 204',
    roomId: 'room-204',
    roundRevision: 1,
  });
  return {
    tournamentId: tournament.tournamentId,
    assignment: {
      id: 'assignment-1',
      roomId: 'room-204',
      roundNumber: 4,
      leftTeamId: leftTeam.id,
      rightTeamId: rightTeam.id,
      matchId,
      revision: 1,
      document,
      leftTeamName: leftTeam.name,
      rightTeamName: rightTeam.name,
    },
  };
}

function bareQbsheetResult(tournamentId: string, matchId: string, roundRevision = 1): object {
  return {
    type: 'Match',
    tossupsRead: 20,
    matchTeams: [{ team: { name: 'Ninety Six' } }, { team: { name: 'Greenwood' } }],
    _qbsheet_source: {
      scheduledMatchId: matchId,
      tournamentId,
      roundRevision,
    },
  };
}

test('reads identity from the actual bare QBSheet result shape', () => {
  const { assignment, tournamentId } = buildFixture();
  const result = bareQbsheetResult(tournamentId, assignment.matchId);

  expect(readResultIdentity(result)).toMatchObject({
    matchId: assignment.matchId,
    tournamentId,
    roundRevision: 1,
  });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('uses the older scoresheet source when QBSheet source metadata is absent', () => {
  const { assignment, tournamentId } = buildFixture();
  const result = {
    ...bareQbsheetResult(tournamentId, assignment.matchId),
    _qbsheet_source: undefined,
    _scoresheet_source: {
      scheduledMatchId: assignment.matchId,
      tournamentId,
      roundRevision: assignment.revision,
    },
  };

  expect(readResultSourceMetadata(result as Record<string, unknown>)).toEqual({
    scheduledMatchId: assignment.matchId,
    tournamentId,
    roundRevision: assignment.revision,
  });
  expect(readResultIdentity(result)).toMatchObject({ matchId: assignment.matchId, tournamentId });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('prefers standard QBJ identity and team IDs when they are present', () => {
  const { assignment } = buildFixture();
  const result = JSON.parse(JSON.stringify(assignment.document)) as {
    objects: Record<string, unknown>[];
  };
  const match = result.objects.find((entry) => entry.type === 'Match');
  if (!match) throw new Error('fixture has no Match');

  expect(readResultIdentity(result)).toMatchObject({ matchId: assignment.matchId });
  expect(validateResultAgainstAssignment(result, assignment)).toBeUndefined();
});

test('finds inline matches under top-level Round objects', () => {
  const inline = {
    type: 'Match',
    id: 'Match_inline',
    match_teams: [{ team: { $ref: 'Team_left' } }, { team: { $ref: 'Team_right' } }],
  };
  const document = {
    version: '2.1.1',
    objects: [{ type: 'Round', name: '4', matches: [inline, { $ref: 'Match_elsewhere' }] }],
  };

  expect(findResultMatchList(document)).toEqual([inline]);
});

test('deduplicates distinct Match objects that carry the same stable identity', () => {
  const first = {
    type: 'Match',
    id: 'Match_same',
    match_teams: [{ team: { $ref: 'Team_left' } }, { team: { $ref: 'Team_right' } }],
  };
  const duplicateTopLevel = { ...first };
  const duplicateInline = { ...first };
  const document = {
    version: '2.1.1',
    objects: [
      first,
      duplicateTopLevel,
      { type: 'Round', name: '4', matches: [duplicateInline, { $ref: 'Match_same' }] },
    ],
  };

  expect(findResultMatchList(document)).toEqual([first]);
});

test('deduplicates by Match ID before fingerprint and recognizes retries of a correction', () => {
  const recorded = [
    { id: 'result-original', matchId: 'Match_one', fingerprint: 'score-a' },
    { id: 'result-correction', matchId: 'Match_one', fingerprint: 'score-b' },
  ];

  expect(compareToRecorded({ matchId: 'Match_one', fingerprint: 'score-a' }, recorded)).toEqual({
    kind: 'duplicate',
    existingId: 'result-original',
  });
  expect(compareToRecorded({ matchId: 'Match_one', fingerprint: 'score-b' }, recorded)).toEqual({
    kind: 'duplicate',
    existingId: 'result-correction',
  });
  expect(compareToRecorded({ matchId: 'Match_one', fingerprint: 'score-c' }, recorded)).toEqual({
    kind: 'conflict',
    existingId: 'result-original',
  });
  expect(compareToRecorded({ matchId: 'Match_two', fingerprint: 'score-a' }, recorded)).toEqual({ kind: 'new' });
});

test('a multi-game file is classified and recorded one game at a time', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-multi-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('multi-game-tournament');

    const game = (id: string, points: number) => ({
      type: 'Match',
      id,
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
    });
    const file = (ids: string[]) => ({
      version: '2.1.1',
      objects: [
        { type: 'Tournament', id: 'multi-game-tournament', name: 'Spring Invitational' },
        ...ids.map((id, index) => game(id, 300 + index * 10)),
      ],
    });

    // The first game arrives on its own and goes on record.
    await server.recordFileResult(file(['Match_1']));
    expect(server.getState().results).toHaveLength(1);

    // Now a file whose first game is that one and whose other two are new.
    const comparisons = server.classifyResults(file(['Match_1', 'Match_2', 'Match_3']));
    expect(comparisons.map((entry) => entry.kind)).toEqual(['duplicate', 'new', 'new']);

    await server.recordFileResult(file(['Match_1', 'Match_2', 'Match_3']));
    // Three games on record, not one - the games after the first are remembered too.
    expect(server.getState().results.map((entry) => entry.matchId)).toEqual(['Match_1', 'Match_2', 'Match_3']);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('an unresolved QBTCP result does not classify itself as a duplicate during review', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-self-review-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('self-review-tournament');

    const document = {
      type: 'Match',
      id: 'Match_round_3',
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points: 300 },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
      _qbsheet_source: { tournamentId: 'self-review-tournament' },
    };
    const identity = readResultIdentity(document);
    if (!identity?.matchId) throw new Error('fixture has no result identity');
    const currentResultId = 'res-current';
    server.getState().results.push({
      id: currentResultId,
      roomId: 'room-3',
      sessionId: 'session-3',
      matchId: identity.matchId,
      fingerprint: identity.fingerprint,
      status: 'needs-review',
      document,
      receivedAt: '2026-08-19T12:00:00.000Z',
      roundNumber: 3,
    });

    expect(server.classifyResults(document)).toEqual([{ kind: 'duplicate', existingId: currentResultId }]);
    expect(server.classifyResults(document, currentResultId)).toEqual([{ kind: 'new' }]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('excluding the result under review still surfaces its conflict with an earlier result', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-self-conflict-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('self-review-tournament');

    const game = (points: number) => ({
      type: 'Match',
      id: 'Match_round_3',
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
      _qbsheet_source: { tournamentId: 'self-review-tournament' },
    });
    const earlier = game(300);
    await server.recordFileResult(earlier);
    const earlierResultId = server.getState().results[0].id;

    const current = game(320);
    const identity = readResultIdentity(current);
    if (!identity?.matchId) throw new Error('fixture has no result identity');
    const currentResultId = 'res-current-conflict';
    server.getState().results.push({
      id: currentResultId,
      roomId: 'room-3',
      sessionId: 'session-3',
      matchId: identity.matchId,
      fingerprint: identity.fingerprint,
      status: 'conflict',
      conflictsWithResultId: earlierResultId,
      document: current,
      receivedAt: '2026-08-19T12:00:00.000Z',
      roundNumber: 3,
    });

    expect(server.classifyResults(current, currentResultId)).toEqual([
      { kind: 'conflict', existingId: earlierResultId },
    ]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test("a game from another tournament is not mistaken for this tournament's", async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-foreign-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('this-tournament');

    const bareGame = (tournamentId: string) => ({
      type: 'Match',
      // The kind of match id two tournaments running the same software both hand out.
      id: 'Match_1000',
      tossups_read: 20,
      match_teams: [
        { team: { $ref: 'Team_left' }, points: 300 },
        { team: { $ref: 'Team_right' }, points: 100 },
      ],
      _qbsheet_source: { tournamentId },
    });

    await server.recordFileResult(bareGame('this-tournament'));
    expect(server.getState().results).toHaveLength(1);

    // Same match id, different tournament, different statistics: a different game entirely.
    const foreign = { ...bareGame('some-other-tournament'), tossups_read: 24 };
    expect(server.classifyResults(foreign)).toEqual([{ kind: 'new' }]);
    await expect(server.recordFileResult(foreign)).rejects.toThrow('different tournament');
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('an explicit result review keeps both sides of a supersession in durable state', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-review-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('review-tournament');

    server.getState().results.push(
      {
        id: 'result-original',
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'Match_one',
        fingerprint: 'score-a',
        status: 'accepted',
        document: { type: 'Match', id: 'Match_one', tossups_read: 20 },
        receivedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        id: 'result-correction',
        roomId: 'room-1',
        sessionId: 'session-2',
        matchId: 'Match_one',
        fingerprint: 'score-b',
        status: 'conflict',
        conflictsWithResultId: 'result-original',
        document: { type: 'Match', id: 'Match_one', tossups_read: 21 },
        receivedAt: '2026-08-19T12:01:00.000Z',
      },
    );

    const reviewed = await server.reviewResult('result-correction', {
      decision: 'supersede',
      existingResultId: 'result-original',
      reason: 'Director confirmed the corrected tossup count.',
    });
    expect(reviewed).toEqual({ reviewed: true });
    expect(server.getState().results).toMatchObject([
      {
        id: 'result-original',
        status: 'superseded',
        supersededByResultId: 'result-correction',
      },
      {
        id: 'result-correction',
        status: 'accepted',
        supersedesResultId: 'result-original',
        review: {
          decision: 'supersede',
          targetResultId: 'result-original',
          reason: 'Director confirmed the corrected tossup count.',
        },
      },
    ]);

    const reloaded = await new QbtcpStore(directory).load('review-tournament');
    expect(reloaded.state.results).toMatchObject([
      { id: 'result-original', status: 'superseded', supersededByResultId: 'result-correction' },
      { id: 'result-correction', status: 'accepted', supersedesResultId: 'result-original' },
    ]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('keep-existing and dismiss are explicit terminal review decisions', async () => {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yellowfruit-qbtcp-review-decisions-'));
  try {
    const server = new QbtcpServer(new QbtcpStore(directory), {
      onResultReceived: () => {},
      onStateChanged: () => {},
    });
    await server.bindTournament('review-decisions-tournament');

    server.getState().results.push(
      {
        id: 'result-kept',
        roomId: 'room-1',
        sessionId: 'session-1',
        matchId: 'Match_one',
        fingerprint: 'score-a',
        status: 'accepted',
        document: { type: 'Match', id: 'Match_one', tossups_read: 20 },
        receivedAt: '2026-08-19T12:00:00.000Z',
      },
      {
        id: 'result-dismissed',
        roomId: 'room-1',
        sessionId: 'session-2',
        matchId: 'Match_one',
        fingerprint: 'score-b',
        status: 'conflict',
        conflictsWithResultId: 'result-kept',
        document: { type: 'Match', id: 'Match_one', tossups_read: 21 },
        receivedAt: '2026-08-19T12:01:00.000Z',
      },
      {
        id: 'result-unreadable',
        roomId: 'room-1',
        sessionId: 'session-3',
        matchId: 'Match_two',
        fingerprint: 'score-c',
        status: 'needs-review',
        document: { type: 'Match', id: 'Match_two' },
        receivedAt: '2026-08-19T12:02:00.000Z',
      },
    );

    expect(
      await server.reviewResult('result-dismissed', {
        decision: 'keep-existing',
        existingResultId: 'result-kept',
        reason: 'The original score sheet is the signed copy.',
      }),
    ).toEqual({ reviewed: true });
    expect(
      await server.reviewResult('result-unreadable', {
        decision: 'dismiss',
        reason: 'The director confirmed this was a duplicate export artifact.',
      }),
    ).toEqual({ reviewed: true });

    expect(server.getState().results).toMatchObject([
      { id: 'result-kept', status: 'accepted' },
      {
        id: 'result-dismissed',
        status: 'dismissed',
        keepsResultId: 'result-kept',
        resolution: 'dismissed',
        review: { decision: 'keep-existing', targetResultId: 'result-kept' },
      },
      {
        id: 'result-unreadable',
        status: 'dismissed',
        resolution: 'dismissed',
        dismissedAt: expect.any(String),
        review: { decision: 'dismiss' },
      },
    ]);
    expect(server.unresolvedResults().map((result) => result.id)).toEqual([]);
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true });
  }
});

test('rejects a bare result whose source revision is stale or whose names are misassigned', () => {
  const { assignment, tournamentId } = buildFixture();
  const stale = bareQbsheetResult(tournamentId, assignment.matchId, assignment.revision);
  expect(validateResultAgainstAssignment(stale, { ...assignment, revision: assignment.revision + 1 })).toBe(
    'A newer assignment has superseded this game.',
  );

  const future = bareQbsheetResult(tournamentId, assignment.matchId, assignment.revision + 1);
  expect(validateResultAgainstAssignment(future, assignment)).toBe(
    'That result does not match this room’s current assignment.',
  );

  const wrongTeams = bareQbsheetResult(tournamentId, assignment.matchId);
  (wrongTeams as { matchTeams: { team: { name: string } }[] }).matchTeams[1].team.name = 'Clinton';
  expect(validateResultAgainstAssignment(wrongTeams, assignment)).toBe(
    'That result does not contain the two teams assigned to this scoring session.',
  );
});
