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
