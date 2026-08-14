import qrcode from 'qrcode-generator';
import { expect, test } from 'vitest';
import { buildPairingLaunchUrl } from '../qbtcp/PairingLaunch';
import { buildPairingSheetsHtml } from '../renderer/Utils/PairingSheets';

function moduleCoordinates(svg: string): Set<string> {
  const coordinates = new Set<string>();
  const pattern = /<rect class="qr-module" x="(\d+)" y="(\d+)" width="1" height="1"\/>/g;
  for (let match = pattern.exec(svg); match; match = pattern.exec(svg)) {
    coordinates.add(`${match[1]},${match[2]}`);
  }
  return coordinates;
}

test("SVG dark modules match qrcode-generator's ECC-Q matrix", () => {
  const payload = buildPairingLaunchUrl({
    scoresheetUrl: 'https://qbsheet.com/',
    serverBaseUrl: 'http://192.0.2.10:40787',
    pairingCode: '12345678',
    roomId: 'room-1',
  });
  const html = buildPairingSheetsHtml({
    tournamentName: 'Spring Invitational',
    serverAddress: 'http://192.0.2.10:40787',
    scoresheetUrl: 'https://qbsheet.com/',
    rooms: [{ name: 'Room 1', pairingCode: '12345678', roomId: 'room-1' }],
    perPage: 1,
  });
  const svg = html.match(/<svg class="pairing-qr"[\s\S]*?<\/svg>/)?.[0];
  expect(svg).toBeDefined();
  const qr = qrcode(0, 'Q');
  qr.addData(payload, 'Byte');
  qr.make();

  const expected = new Set<string>();
  const quietZone = 4;
  for (let row = 0; row < qr.getModuleCount(); row += 1) {
    for (let column = 0; column < qr.getModuleCount(); column += 1) {
      if (qr.isDark(row, column)) expected.add(`${column + quietZone},${row + quietZone}`);
    }
  }

  expect(moduleCoordinates(svg ?? '')).toEqual(expected);
});
