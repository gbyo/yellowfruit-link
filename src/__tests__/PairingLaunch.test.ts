import { expect, test } from 'vitest';
import {
  buildPairingLaunchUrl,
  isValidServerBaseUrl,
  normalizeScoresheetUrl,
  pairingLaunchVersion,
} from '../qbtcp/PairingLaunch';

test('builds the v1 launch shape and omits an absent room id', () => {
  const launch = buildPairingLaunchUrl({
    scoresheetUrl: 'https://qbsheet.com/app?venue=finals#old-fragment',
    serverBaseUrl: 'http://192.0.2.10:40787',
    pairingCode: '12345678',
  });

  expect(launch).toBe(
    `https://qbsheet.com/app?venue=finals#qbtcp-pair?v=${pairingLaunchVersion}&server=http%3A%2F%2F192.0.2.10%3A40787&code=12345678`,
  );
  expect(launch).not.toContain('room=');
});

test('percent-encodes the server and includes a room id when supplied', () => {
  const launch = buildPairingLaunchUrl({
    scoresheetUrl: 'https://scores.example/hosted?tenant=abc',
    serverBaseUrl: 'https://control.example/base',
    pairingCode: '87654321',
    roomId: 'room A/1',
  });

  expect(launch).toBe(
    'https://scores.example/hosted?tenant=abc#qbtcp-pair?v=1&server=https%3A%2F%2Fcontrol.example%2Fbase&code=87654321&room=room+A%2F1',
  );
});

test('refuses a server address QBSheet would not accept as a base URL', () => {
  // A base address is a host to append protocol paths to. QBSheet rejects a query or a fragment on
  // one, so a QR code carrying either is a code this application printed and its own client refuses.
  expect(isValidServerBaseUrl('http://192.0.2.10:40787')).toBe(true);
  expect(isValidServerBaseUrl('https://control.example/base')).toBe(true);
  expect(isValidServerBaseUrl('https://control.example/base?q=one')).toBe(false);
  expect(isValidServerBaseUrl('https://control.example/base#state')).toBe(false);

  for (const serverBaseUrl of ['https://control.example/base?q=one', 'https://control.example/base#state']) {
    expect(() =>
      buildPairingLaunchUrl({ scoresheetUrl: 'https://qbsheet.com/', serverBaseUrl, pairingCode: '12345678' }),
    ).toThrow();
  }
});

test('preserves the scoresheet base path and query while replacing its fragment', () => {
  const launch = buildPairingLaunchUrl({
    scoresheetUrl: 'https://qbsheet.example/self-hosted/index.html?event=42#some-old-app-state',
    serverBaseUrl: 'http://localhost:40787',
    pairingCode: '12345678',
    roomId: 'room-1',
  });
  const parsed = new URL(launch);

  expect(parsed.pathname).toBe('/self-hosted/index.html');
  expect(parsed.search).toBe('?event=42');
  expect(parsed.hash.startsWith('#qbtcp-pair?')).toBe(true);
  expect(parsed.hash).not.toContain('some-old-app-state');
  expect(parsed.search).not.toContain('qbtcp-pair');
});

test('rejects non-http schemes for the scoresheet and the server', () => {
  expect(normalizeScoresheetUrl('ftp://qbsheet.example/')).toBeUndefined();
  expect(normalizeScoresheetUrl('data:text/plain,not-a-scoresheet')).toBeUndefined();
  expect(() =>
    buildPairingLaunchUrl({
      scoresheetUrl: 'ftp://qbsheet.example/',
      serverBaseUrl: 'http://localhost:40787',
      pairingCode: '12345678',
    }),
  ).toThrow();
  expect(() =>
    buildPairingLaunchUrl({
      scoresheetUrl: 'https://qbsheet.example/',
      serverBaseUrl: 'file:///tmp/server',
      pairingCode: '12345678',
    }),
  ).toThrow();
});
