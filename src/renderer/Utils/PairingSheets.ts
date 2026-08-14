import qrcode from 'qrcode-generator';
import { buildPairingLaunchUrl } from '../../qbtcp/PairingLaunch';

export type SheetsPerPage = 1 | 2 | 4;

interface PairingSheetRoom {
  name: string;
  pairingCode: string;
  roomId: string;
}

interface PairingSheetsOptions {
  tournamentName: string;
  serverAddress: string;
  scoresheetUrl: string;
  rooms: PairingSheetRoom[];
  perPage: SheetsPerPage;
}

const htmlEscape = (value: string): string => {
  const entities: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  };
  return value.replace(/[&<>'"]/g, (character) => entities[character] ?? character);
};

/** Render qrcode-generator's matrix as resolution-independent inline SVG. */
export function buildPairingQrSvg(payload: string): string {
  const qr = qrcode(0, 'Q');
  qr.addData(payload, 'Byte');
  qr.make();

  const moduleCount = qr.getModuleCount();
  const quietZone = 4;
  const size = moduleCount + quietZone * 2;
  const modules: string[] = [];
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (qr.isDark(row, column)) {
        modules.push(`<rect class="qr-module" x="${column + quietZone}" y="${row + quietZone}" width="1" height="1"/>`);
      }
    }
  }

  return [
    `<svg class="pairing-qr" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" role="img" aria-label="Room pairing QR code" shape-rendering="crispEdges">`,
    `<rect class="qr-background" width="${size}" height="${size}" fill="#fff"/>`,
    `<g fill="#000">${modules.join('')}</g>`,
    '</svg>',
  ].join('');
}

function pageCss(perPage: SheetsPerPage): string {
  const columns = perPage === 4 ? 2 : 1;
  const rows = perPage === 1 ? 1 : 2;
  return `
    @page { margin: 0.4in; }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body { color: #111; font-family: Arial, Helvetica, sans-serif; }
    .sheets-page {
      width: 100%;
      height: 10.2in;
      display: grid;
      grid-template-columns: repeat(${columns}, 1fr);
      grid-template-rows: repeat(${rows}, 1fr);
      gap: 0.18in;
      page-break-after: always;
      break-after: page;
    }
    .sheets-page:last-child { page-break-after: auto; break-after: auto; }
    .pairing-card {
      min-width: 0;
      min-height: 0;
      overflow: hidden;
      border: 2px solid #111;
      border-radius: 0.12in;
      padding: 0.22in;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 0.12in;
    }
    .tournament-name {
      font-size: 12pt;
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .room-name {
      margin: 0.04in 0 0;
      font-size: 22pt;
      line-height: 1.05;
      overflow-wrap: anywhere;
    }
    .qr-container {
      min-height: 0;
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0.06in 0;
    }
    .pairing-qr { display: block; width: min(2.2in, 72%); height: auto; max-height: 2.5in; }
    .manual-details {
      display: flex;
      flex-direction: column;
      gap: 0.05in;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
    .manual-label { font-family: Arial, Helvetica, sans-serif; font-size: 8pt; font-weight: 700; }
    .server-address { font-size: 10pt; overflow-wrap: anywhere; }
    .pairing-code { font-size: 21pt; line-height: 1; letter-spacing: 0.12em; font-weight: 700; }
    @media screen {
      body { background: #eee; padding: 0.25in; }
      .sheets-page { max-width: 10.2in; margin: 0 auto 0.25in; background: #fff; }
    }
  `;
}

function buildCardHtml(
  tournamentName: string,
  serverAddress: string,
  scoresheetUrl: string,
  room: PairingSheetRoom,
): string {
  const payload = buildPairingLaunchUrl({
    scoresheetUrl,
    serverBaseUrl: serverAddress,
    pairingCode: room.pairingCode,
    roomId: room.roomId,
  });

  return `
    <article class="pairing-card">
      <header>
        <div class="tournament-name">${htmlEscape(tournamentName)}</div>
        <h1 class="room-name">${htmlEscape(room.name)}</h1>
      </header>
      <div class="qr-container">${buildPairingQrSvg(payload)}</div>
      <div class="manual-details">
        <div class="manual-label">QBSheet server address</div>
        <div class="server-address">${htmlEscape(serverAddress)}</div>
        <div class="manual-label">Pairing code</div>
        <div class="pairing-code">${htmlEscape(room.pairingCode)}</div>
      </div>
    </article>`;
}

/** Build one self-contained printable document, with no filesystem or browser dependencies. */
export function buildPairingSheetsHtml(opts: PairingSheetsOptions): string {
  const pages: string[] = [];
  for (let index = 0; index < opts.rooms.length; index += opts.perPage) {
    const pageRooms = opts.rooms.slice(index, index + opts.perPage);
    pages.push(
      `<section class="sheets-page" data-per-page="${opts.perPage}">${pageRooms
        .map((room) => buildCardHtml(opts.tournamentName, opts.serverAddress, opts.scoresheetUrl, room))
        .join('')}</section>`,
    );
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${htmlEscape(opts.tournamentName)} pairing sheets</title>
    <style>${pageCss(opts.perPage)}</style>
  </head>
  <body>
    <main class="pairing-sheets">${pages.join('')}</main>
  </body>
</html>`;
}
