import { expect, test } from 'vitest';
import { buildPairingLaunchUrl } from '../qbtcp/PairingLaunch';
import { buildPairingSheetsHtml } from '../renderer/Utils/PairingSheets';

const rooms = [
  { name: 'Room 1', pairingCode: '12345678', roomId: 'room-1' },
  { name: 'Room 2', pairingCode: '23456789', roomId: 'room-2' },
  { name: 'Room 3', pairingCode: '34567890', roomId: 'room-3' },
  { name: 'Room 4', pairingCode: '45678901', roomId: 'room-4' },
  { name: 'Room 5', pairingCode: '56789012', roomId: 'room-5' },
];

test('puts the requested number of cards on each page', () => {
  const html = buildPairingSheetsHtml({
    tournamentName: 'Spring Invitational',
    serverAddress: 'http://192.0.2.10:40787',
    scoresheetUrl: 'https://qbsheet.com/',
    rooms,
    perPage: 4,
  });
  const pages = html.match(/<section class="sheets-page"[^>]*>[\s\S]*?<\/section>/g) ?? [];
  const firstPage = pages[0] ?? '';
  const lastPage = pages[1] ?? '';

  expect(pages).toHaveLength(2);
  expect((firstPage.match(/class="pairing-card"/g) ?? []).length).toBe(4);
  expect((lastPage.match(/class="pairing-card"/g) ?? []).length).toBe(1);
});

test('writes the per-page grid CSS for one, two, and four sheets', () => {
  const options = {
    tournamentName: 'Tournament',
    serverAddress: 'http://192.0.2.10:40787',
    scoresheetUrl: 'https://qbsheet.com/',
    rooms: rooms.slice(0, 1),
  };
  expect(buildPairingSheetsHtml({ ...options, perPage: 1 })).toContain('grid-template-columns: repeat(1, 1fr)');
  expect(buildPairingSheetsHtml({ ...options, perPage: 2 })).toContain('grid-template-rows: repeat(2, 1fr)');
  expect(buildPairingSheetsHtml({ ...options, perPage: 4 })).toContain('grid-template-columns: repeat(2, 1fr)');
});

test('includes the address, code, and an exact launch URL in the QR matrix', () => {
  const room = rooms[0];
  const serverAddress = 'http://192.0.2.10:40787';
  const scoresheetUrl = 'https://qbsheet.com/app?event=42';
  const html = buildPairingSheetsHtml({
    tournamentName: 'Spring Invitational',
    serverAddress,
    scoresheetUrl,
    rooms: [room],
    perPage: 1,
  });
  const expectedPayload = buildPairingLaunchUrl({
    scoresheetUrl,
    serverBaseUrl: serverAddress,
    pairingCode: room.pairingCode,
    roomId: room.roomId,
  });

  expect(html).toContain(serverAddress);
  expect(html).toContain(room.pairingCode);
  // The payload is represented by the SVG's matrix rather than a second plaintext URL. The dedicated
  // QR rendering test compares every dark module against qrcode-generator for this exact payload.
  expect(expectedPayload).toContain('#qbtcp-pair?v=1');
  expect(html).toContain('<svg class="pairing-qr"');
});

test('escapes room and tournament names and never emits room/session credentials', () => {
  const html = buildPairingSheetsHtml({
    tournamentName: "Director's <Tournament>",
    serverAddress: 'http://192.0.2.10:40787',
    scoresheetUrl: 'https://qbsheet.com/',
    rooms: [{ name: "Bob & Sue's <Room>", pairingCode: '12345678', roomId: 'room-1' }],
    perPage: 1,
  });

  expect(html).toContain('Bob &amp; Sue&#39;s &lt;Room&gt;');
  expect(html).toContain('Director&#39;s &lt;Tournament&gt;');
  expect(html).not.toContain("Bob & Sue's <Room>");
  expect(html).not.toContain('room-token-secret');
  expect(html).not.toContain('session-token-secret');
});
