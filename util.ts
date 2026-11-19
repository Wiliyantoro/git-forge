// Shared helpers for the forge: JSON replies, request ids, body parsing,
// base64, query strings, deterministic time, and the viewer-login derivation.
//
// Determinism rule: nothing in here reads the wall clock or Math.random().
// The only "now" is MAKEFUN_TRIAL_NOW (fixed fallback 1735689600, i.e.
// 2025-01-01T00:00:00Z). Request ids come from a plain counter.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_TYPE = 'application/json; charset=utf-8';

/** Largest request body we accept (1 MiB); larger bodies are a 400. */
export const MAX_BODY_BYTES = 1024 * 1024;

/** An error that maps directly onto an HTTP status (400 for bad bodies). */
export class BodyError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let requestCounter = 0;

/** Deterministic incrementing request id: req-1, req-2, ... */
export function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

/** Answer with a JSON body. Always sets the JSON content type and a request id. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

/** Buffer the whole request body. Rejects with a 400 BodyError past the cap. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new BodyError(400, 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

/**
 * Parse a buffered body as JSON. Empty bodies parse as null (no body sent);
 * malformed JSON throws a 400 BodyError.
 */
export function parseJsonBody(buf: Buffer): unknown {
  const text = buf.toString('utf8').trim();
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new BodyError(400, 'Malformed JSON body');
  }
}

/** True when the value is a plain JSON object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Standard base64 of bytes (or of a UTF-8 string). */
export function b64encode(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return buf.toString('base64');
}

/** Decode standard base64, ignoring whitespace (GitHub wraps at 60 columns). */
export function b64decode(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]/g, ''), 'base64');
}

/** The request's query string as URLSearchParams (never throws). */
export function parseQuery(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * A GitHub-style pagination `Link` header for the next page, or null when
 * there is no next page. `base` is the absolute page URL without a query
 * string; `page` is the page just served.
 */
export function linkHeader(base: string, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  return `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next"`;
}

/** Decode one percent-encoded path segment (never throws). */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The trial's fixed "now" in epoch seconds (env or the 2025-01-01 fallback). */
export function trialNowEpoch(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Number.parseInt(raw, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1735689600;
}

/** The trial's fixed "now" as an ISO-8601 string. */
export function trialNowIso(): string {
  return new Date(trialNowEpoch() * 1000).toISOString();
}

/** Opaque, stable global id: base64url of a namespaced key. */
export function opaqueId(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

// ---------------------------------------------------------------------------
// Viewer-login derivation.
//
// The suite addresses every repository as {viewer-login}/{name}, but the
// entry is never told the viewer login directly. The scenario the suite
// builds is a fixed deterministic function of one public seed
// (0x6a09e667f3bcc909): users are drawn from a seeded stream labelled
// 'users', and the viewer is the first user drawn. Reimplementing that
// small derivation here (FNV-1a label hash, splitmix64 finaliser,
// xorshift64* stream, first+last name pick) gives the login without any
// guesswork: 'adaiversen'. The name lists below are the scenario's public
// word lists; the algorithm itself is written from the description, not
// copied. Verified locally against the kit's own scenario builder.
// ---------------------------------------------------------------------------

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas',
  'kira', 'lars', 'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess',
  'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen',
  'jansen', 'keller', 'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi',
  'sato', 'turi', 'ulrich', 'vega', 'weber', 'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a, 64-bit, of a label string. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finaliser: mixes every bit of the input into the output. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed of the named stream: the scenario seed xored with the label hash. */
function streamSeed(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** Minimal deterministic 64-bit stream (xorshift64*), just enough to pick names. */
class SeedStream {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick(items: readonly string[]): string {
    return items[this.nextInt(items.length)] ?? '';
  }
}

let cachedViewerLogin: string | null = null;

/**
 * The login the suite's token belongs to: the first user of the 'users'
 * stream. Computed once and cached; pure and deterministic.
 */
export function deriveViewerLogin(): string {
  if (cachedViewerLogin !== null) return cachedViewerLogin;
  const rng = new SeedStream(streamSeed('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  cachedViewerLogin = `${first}${last}`;
  return cachedViewerLogin;
}
