/**
 * The URL carried by a printable room pairing QR code.
 *
 * This is deliberately a small, dependency-free module shared by the renderer and the main
 * process. The fragment belongs to the scoresheet application; the server never receives it in an
 * HTTP request until the scoresheet has parsed it.
 */

export const pairingLaunchVersion = '1';
export const defaultScoresheetUrl = 'https://qbsheet.com/';

/**
 * Return a canonical scoresheet URL, or undefined when the input is not an HTTP(S) URL.
 *
 * A saved fragment is discarded because the pairing launch fragment is the one source of truth for
 * this flow. The path and query are intentionally left intact for self-hosted deployments.
 */
export function normalizeScoresheetUrl(raw: string): string | undefined {
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;

  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function validateServerBaseUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error('The server address must be an HTTP or HTTPS URL.');
  }

  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('The server address must be an HTTP or HTTPS URL.');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'The server address must be an HTTP or HTTPS URL.') {
      throw error;
    }
    throw new Error('The server address must be an HTTP or HTTPS URL.');
  }
  // Keep the spelling the director chose. URL above is used for validation; adding a trailing slash
  // here would change the launch string for the ordinary `http://host:port` address.
  return trimmed;
}

/** Build the one canonical URL shared by QR codes and a future copy-link action. */
export function buildPairingLaunchUrl(opts: {
  scoresheetUrl: string;
  serverBaseUrl: string;
  pairingCode: string;
  roomId?: string;
}): string {
  const scoresheetUrl = normalizeScoresheetUrl(opts.scoresheetUrl);
  if (!scoresheetUrl) throw new Error('The scoresheet address must be an HTTP or HTTPS URL.');

  const serverBaseUrl = validateServerBaseUrl(opts.serverBaseUrl);
  const launchUrl = new URL(scoresheetUrl);
  const params = new URLSearchParams();
  params.set('v', pairingLaunchVersion);
  params.set('server', serverBaseUrl);
  params.set('code', opts.pairingCode);
  if (opts.roomId !== undefined) params.set('room', opts.roomId);

  // Setting hash replaces an existing fragment while preserving the scoresheet's path and query.
  launchUrl.hash = `qbtcp-pair?${params.toString()}`;
  return launchUrl.toString();
}
