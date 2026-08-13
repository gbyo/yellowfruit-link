/**
 * The untrusted-input boundary for the QBTCP server.
 *
 * Everything a scoresheet sends arrives here first. A request is bounded before it is buffered,
 * parsed before it is believed, and shape-checked before it is used. The rules come from the
 * specification's security model rather than from what the current QBSheet build happens to send.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  deviceIdHeader,
  maxRequestBodyBytes,
  maxUrlLength,
  operatorNameHeader,
  roomTokenHeader,
  sessionTokenHeader,
} from '../../qbtcp/QbtcpProtocol';

/** Headers a browser is allowed to send us. Includes the private-network preflight header. */
const allowedRequestHeaders = [
  'content-type',
  roomTokenHeader,
  sessionTokenHeader,
  deviceIdHeader,
  operatorNameHeader,
  'access-control-request-private-network',
].join(', ');

const allowedMethods = 'GET, POST, PUT, DELETE, OPTIONS';

export type BodyReadResult =
  | { ok: true; text: string }
  /** `tooLarge` separates a `413` from a connection that simply failed. */
  | { ok: false; tooLarge: boolean };

/**
 * Buffer a request body, refusing one that grows past the limit.
 *
 * The check is on bytes as they arrive rather than on `Content-Length`, because a header is a claim
 * and a chunked body has none.
 *
 * On refusal the buffer is dropped - which is what actually bounds memory - but the stream is left to
 * drain rather than destroyed. Destroying it resets the connection, and a reset reaches the client as a
 * network failure, which it is required to retry. A `413` reaches it as "do not retry unchanged", which
 * is the truth. Bounding memory and answering honestly are not in tension; only the abrupt close was.
 */
export function readBody(request: IncomingMessage, limit: number = maxRequestBodyBytes): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    request.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        chunks = [];
        finish({ ok: false, tooLarge: true });
        // Keep consuming and discarding so the request completes and the refusal is delivered.
        request.resume();
        return;
      }
      if (settled) return;
      chunks.push(chunk);
    });
    request.on('end', () => finish({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    request.on('error', () => finish({ ok: false, tooLarge: false }));
    request.on('aborted', () => finish({ ok: false, tooLarge: false }));
  });
}

const pollutionKeys = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parse JSON from an untrusted source.
 *
 * Rejects, rather than sanitizes, three things: prototype-pollution key names, non-finite numbers,
 * and anything that is not valid JSON. Sanitizing would mean acting on a document whose author and
 * this process disagree about, and for a game result that disagreement is a wrong score.
 */
export function parseUntrustedJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, value: undefined };
  let value: unknown;
  try {
    value = JSON.parse(text, (key, entry) => {
      if (pollutionKeys.has(key)) throw new Error('unsafe key');
      if (typeof entry === 'number' && !Number.isFinite(entry)) throw new Error('non-finite number');
      return entry;
    });
  } catch (error) {
    const { message } = error as Error;
    if (message === 'unsafe key')
      return { ok: false, error: 'That request contained a key this server will not accept.' };
    if (message === 'non-finite number')
      return { ok: false, error: 'That request contained a number this server cannot use.' };
    return { ok: false, error: 'That request was not readable JSON.' };
  }
  return { ok: true, value };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. Used for every string field read off the wire. */
export function stringField(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > maxLength) return undefined;
  return trimmed;
}

/** A single header value. Node gives an array when a header repeats; a repeated credential is not one. */
export function headerValue(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export interface ICorsDecision {
  /** Whether this request may proceed. A disallowed origin is refused with 403. */
  allowed: boolean;
  /** The one origin to echo, when there is one. */
  origin?: string;
}

/**
 * Decide the CORS outcome for a request, and set the response headers for it.
 *
 * Two rules matter most. The allowlist is exact and the echo is of a single origin, never `*`: a
 * wildcard on a capability-token API would let any page a scorekeeper visits drive the tournament.
 * And a request with no `Origin` header is allowed through - that is a non-browser client such as
 * `curl` or a test, which CORS does not govern and cannot be protected by it either way.
 */
export function applyCors(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: readonly string[],
): ICorsDecision {
  response.setHeader('Access-Control-Allow-Headers', allowedRequestHeaders);
  response.setHeader('Access-Control-Allow-Methods', allowedMethods);
  // The response varies by Origin even when there is none, so caches must not share it.
  response.setHeader('Vary', 'Origin');

  const origin = headerValue(request, 'origin');
  if (!origin) return { allowed: true };

  if (!allowedOrigins.includes(origin)) return { allowed: false, origin };

  response.setHeader('Access-Control-Allow-Origin', origin);

  // Chrome's Private Network Access: a server on a private address must answer this explicitly, or a
  // scoresheet on a public origin cannot reach it at all.
  if (headerValue(request, 'access-control-request-private-network') === 'true') {
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  return { allowed: true, origin };
}

/** Bound the URL as well as the body: both are untrusted input. */
export function urlTooLong(request: IncomingMessage): boolean {
  return (request.url ?? '').length > maxUrlLength;
}

/**
 * A fixed-window attempt counter, used to rate-limit pairing.
 *
 * Deliberately per client source. The window resets rather than sliding, which lets a genuine
 * scorekeeper who mistyped a code four times get another try shortly instead of being locked out for
 * as long as they keep trying.
 */
export class AttemptLimiter {
  private windows = new Map<string, { count: number; startedAt: number }>();

  private maxAttempts: number;

  private windowMs: number;

  /** A source that never returns must not be able to grow this map without limit. */
  private maxWindows: number;

  /** Injectable so a test can advance time without waiting out a real window. */
  private now: () => number;

  constructor(maxAttempts: number, windowMs: number, now: () => number = () => Date.now(), maxWindows = 4096) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.now = now;
    this.maxWindows = maxWindows;
  }

  private evictExpired(now: number): void {
    for (const [source, window] of this.windows) {
      if (now - window.startedAt > this.windowMs) this.windows.delete(source);
    }
  }

  private evictOldestIfFull(): void {
    if (this.windows.size < this.maxWindows) return;
    const oldest = this.windows.keys().next().value as string | undefined;
    if (oldest !== undefined) this.windows.delete(oldest);
  }

  /** True when this source has already used its budget. */
  exceeded(source: string): boolean {
    const now = this.now();
    this.evictExpired(now);
    const window = this.windows.get(source);
    if (!window) return false;
    return window.count >= this.maxAttempts;
  }

  record(source: string): void {
    const now = this.now();
    this.evictExpired(now);
    const existing = this.windows.get(source);
    if (!existing) {
      this.evictOldestIfFull();
      this.windows.set(source, { count: 1, startedAt: now });
      return;
    }
    existing.count += 1;
  }

  /** A successful pairing clears the budget: the person proved they belong here. */
  clear(source: string): void {
    this.windows.delete(source);
  }
}
