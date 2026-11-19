// gitproto.ts — git smart-HTTP wire protocol (pure TS, no I/O).
//
// pkt-line codec, sideband framing, v0/v2 advertisements, v2 ls-refs and
// fetch, v0 fetch, and receive-pack command/report handling. All builders
// return Buffers ready to send; all parsers throw on corrupt input (callers
// in git.ts catch and survive).

import type { Oid, Repo, Store } from './store.ts';import { ZERO_OID } from './store.ts';
import {
  buildPack,
  collectCommitObjects,
  getObject,
  parseCommit,
  parseTag,
} from './gitpack.ts';

export const AGENT = 'makefun-git-forge/1.0';
export const PKT_MAX = 65520;

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export function flushPkt(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function delimPkt(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function endPkt(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem =
  | { kind: 'data'; data: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

// Decode pkt-lines from the front of `buf`. Stops (without throwing) at the
// first 4 bytes that are not a hex length — the remainder is raw data
// (e.g. the pack appended after the flush in receive-pack). Throws on a
// truncated packet or an out-of-range length.
export function decodePkts(buf: Buffer): { items: PktItem[]; consumed: number } {
  const items: PktItem[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const head = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw data follows
    const len = parseInt(head, 16);
    if (len === 0) {
      items.push({ kind: 'flush' });
      pos += 4;
    } else if (len === 1) {
      items.push({ kind: 'delim' });
      pos += 4;
    } else if (len === 2) {
      items.push({ kind: 'end' });
      pos += 4;
    } else if (len === 3 || len > PKT_MAX) {
      throw new Error('pkt-line: invalid length');
    } else {
      if (pos + len > buf.length) throw new Error('pkt-line: truncated');
      items.push({ kind: 'data', data: buf.subarray(pos + 4, pos + len) });
      pos += len;
    }
  }
  return { items, consumed: pos };
}

// Data pkt-lines for each string, then a flush.
export function pktLines(lines: string[]): Buffer {
  const parts = lines.map((l) => pktLine(l));
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Sideband framing (band 1 = pack data, 2 = progress, 3 = error)
// ---------------------------------------------------------------------------

export function sidebandEncode(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxPayload = PKT_MAX - 4 - 1; // header + band byte
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let off = 0; off < data.length; off += maxPayload) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxPayload));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Advertisements
// ---------------------------------------------------------------------------

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function peeledOid(store: Store, oid: Oid): Oid | null {
  const obj = getObject(store, oid);
  if (!obj || obj.type !== 'tag') return null;
  return parseTag(obj.data).object;
}

// v0 advertisement: service preamble + flush, then ref lines; the first
// line carries capabilities after a NUL. Peeled annotated tags get a
// `<oid> <ref>^{}` line. Empty repo: a single zero-oid capabilities line.
export function advertiseV0(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? 'side-band-64k thin-pack multi_ack_detailed ofs-delta shallow symref=HEAD:refs/heads/main agent=' + AGENT
      : 'report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=' + AGENT;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), flushPkt()];
  const names = sortedRefNames(repo);
  const mainTip = repo.refs.get('refs/heads/main');
  if (names.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = mainTip !== undefined ? mainTip : ZERO_OID;
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const name of names) {
      const oid = repo.refs.get(name) as Oid;
      parts.push(pktLine(`${oid} ${name}\n`));
      const peeled = peeledOid(store, oid);
      if (peeled !== null) {
        parts.push(pktLine(`${peeled} ${name}^{}\n`));
      }
    }
  }
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// v2 advertisement (upload-pack only): service preamble + flush, then
// `version 2`, one capability per pkt-line, flush.
export function advertiseV2(_store: Store, _repo: Repo): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    flushPkt(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    flushPkt(),
  ]);
}

// ---------------------------------------------------------------------------
// v2 ls-refs
// ---------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

export function parseLsRefsRequest(buf: Buffer): LsRefsArgs {
  const { items } = decodePkts(buf);
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenCommand = false;
  let pastDelim = false;
  for (const item of items) {
    if (item.kind !== 'data') {
      if (item.kind === 'delim') pastDelim = true;
      continue;
    }
    const line = item.data.toString('utf8').trim();
    if (!seenCommand) {
      if (line !== 'command=ls-refs') throw new Error('ls-refs: bad command');
      seenCommand = true;
      continue;
    }
    if (!pastDelim) continue; // agent= / object-format= lines
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  if (!seenCommand) throw new Error('ls-refs: missing command');
  return args;
}

export function buildLsRefsResponse(store: Store, repo: Repo, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  const mainTip = repo.refs.get('refs/heads/main');
  // HEAD: included when no prefix filter, or a prefix matches 'HEAD'.
  if (args.prefixes.length === 0 || args.prefixes.some((p) => 'HEAD'.startsWith(p) || p === '')) {
    if (mainTip !== undefined) {
      lines.push(`${mainTip} HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    } else if (args.unborn) {
      lines.push(`unborn HEAD${args.symrefs ? ' symref-target:refs/heads/main' : ''}\n`);
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as Oid;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledOid(store, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return pktLines(lines);
}

// ---------------------------------------------------------------------------
// Fetch (shared computation for v2 and v0)
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: Oid[];
  haves: Oid[];
  shallow: Oid[]; // boundaries the client already holds
  depth: number | null; // deepen <n>
  thinPack: boolean;
  noProgress: boolean;
  done: boolean; // client sent `done`: negotiation finished, omit acks
}

export interface FetchPlan {
  objects: Oid[]; // sorted, to send in the pack
  newShallow: Oid[];
  unshallow: Oid[];
  acks: Oid[]; // haves the server holds
}

// Commits within `depth` of a want (distance 0 = the want itself). With no
// depth limit, the full ancestry. Returns the included commit set.
function depthLimitedCommits(store: Store, wants: Oid[], depth: number | null): Set<Oid> {
  const included = new Set<Oid>();
  const queue: { oid: Oid; dist: number }[] = wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: Oid; dist: number };
    if (included.has(oid)) continue;
    const obj = getObject(store, oid);
    if (!obj || obj.type !== 'commit') continue;
    included.add(oid);
    if (depth !== null && dist + 1 >= depth) continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!included.has(p)) queue.push({ oid: p, dist: dist + 1 });
    }
  }
  return included;
}

// Commits reachable from `haves` without crossing a shallow boundary:
// a shallow commit contributes itself (and its tree) but not its parents.
function haveCommits(store: Store, haves: Oid[], shallow: Oid[]): Set<Oid> {
  const shallowSet = new Set(shallow);
  const out = new Set<Oid>();
  const stack = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (out.has(oid)) continue;
    const obj = getObject(store, oid);
    if (!obj || obj.type !== 'commit') continue;
    out.add(oid);
    if (shallowSet.has(oid)) continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!out.has(p)) stack.push(p);
    }
  }
  return out;
}

// Peel tag wants to their target commits; the tag objects themselves must
// also be sent (a clone wants the tag object for each advertised tag ref).
function peelTagWants(store: Store, wants: Oid[]): { commits: Oid[]; tags: Oid[] } {
  const commits: Oid[] = [];
  const tags: Oid[] = [];
  for (const oid of wants) {
    let current = oid;
    const seen = new Set<Oid>();
    while (!seen.has(current)) {
      seen.add(current);
      const obj = getObject(store, current);
      if (!obj) break;
      if (obj.type === 'tag') {
        tags.push(current);
        current = parseTag(obj.data).object;
        continue;
      }
      break;
    }
    commits.push(current);
  }
  return { commits, tags };
}

export function computeFetch(store: Store, _repo: Repo, args: FetchArgs): FetchPlan {
  const peeled = peelTagWants(store, args.wants);
  const wantedCommits = depthLimitedCommits(store, peeled.commits, args.depth);
  const wantedObjects = collectCommitObjects(store, wantedCommits);
  for (const tag of peeled.tags) {
    if (store.objects.has(tag)) wantedObjects.add(tag);
  }
  const haveSet = haveCommits(store, args.haves, args.shallow);
  const haveObjects = collectCommitObjects(store, haveSet);
  const objects = [...wantedObjects].filter((oid) => !haveObjects.has(oid)).sort();

  // New shallow boundary: included commits with a parent left out (only
  // possible under a depth limit, or when a parent object is absent).
  const newShallow: Oid[] = [];
  for (const oid of wantedCommits) {
    const obj = getObject(store, oid);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((p) => !wantedCommits.has(p))) newShallow.push(oid);
  }
  newShallow.sort();
  const newShallowSet = new Set(newShallow);
  const unshallow = args.shallow
    .filter((oid) => wantedCommits.has(oid) && !newShallowSet.has(oid))
    .sort();
  const acks = args.haves.filter((oid) => store.objects.has(oid));
  return { objects, newShallow, unshallow, acks };
}

// ---------------------------------------------------------------------------
// v2 fetch
// ---------------------------------------------------------------------------

export function parseFetchV2Request(buf: Buffer): FetchArgs {
  const { items } = decodePkts(buf);
  const args: FetchArgs = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    thinPack: false,
    noProgress: false,
    done: false,
  };
  let seenCommand = false;
  let pastDelim = false;
  for (const item of items) {
    if (item.kind !== 'data') {
      if (item.kind === 'delim') pastDelim = true;
      continue;
    }
    const line = item.data.toString('utf8').trim();
    if (!seenCommand) {
      if (line !== 'command=fetch') throw new Error('fetch: bad command');
      seenCommand = true;
      continue;
    }
    if (!pastDelim) continue; // agent= / object-format= lines
    if (line === 'thin-pack') args.thinPack = true;
    else if (line === 'no-progress') args.noProgress = true;
    else if (line === 'done') { args.done = true; break; }
    else if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
    // deepen-since / deepen-not / filter: accepted, not needed by checks.
  }
  if (!seenCommand) throw new Error('fetch: missing command');
  return args;
}

export function buildFetchV2Response(store: Store, repo: Repo, args: FetchArgs): Buffer {
  const plan = computeFetch(store, repo, args);
  const parts: Buffer[] = [];
  // acknowledgments: omitted when the client sent `done` (negotiation is
  // finished — protocol-v2 requires the section to be omitted then).
  // Otherwise (mid-negotiation) send ACKs/NAK plus `ready`, since this
  // server always sends a packfile, then a delim.
  if (!args.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    }
    parts.push(pktLine('ready\n'));
    parts.push(delimPkt());
  }
  // shallow-info
  if (plan.newShallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(delimPkt());
  }
  // wanted-refs: refs whose tip is a want — one line per wanted oid.
  // A tag sharing a branch tip's oid must not produce a second line: git
  // validates wanted-refs against the refs it sought, and a shallow clone
  // seeks only the branch, so the duplicate tag line dies with
  // "unexpected wanted-ref".
  const wantSet = new Set(args.wants);
  const wantedLines: string[] = [];
  const seenOids = new Set<Oid>();
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as Oid;
    if (wantSet.has(oid) && !seenOids.has(oid)) {
      seenOids.add(oid);
      wantedLines.push(`${oid} ${name}\n`);
    }
  }
  if (wantedLines.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const l of wantedLines) parts.push(pktLine(l));
    parts.push(delimPkt());
  }
  // packfile (sideband band 1; always present, even when empty)
  parts.push(pktLine('packfile\n'));
  const pack = buildPack(store, plan.objects);
  for (const p of sidebandEncode(1, pack)) parts.push(p);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// v0 fetch
// ---------------------------------------------------------------------------

export interface FetchV0Args extends FetchArgs {
  caps: string[];
}

export function parseFetchV0Request(buf: Buffer): FetchV0Args {
  const { items } = decodePkts(buf);
  const args: FetchV0Args = {
    wants: [],
    haves: [],
    shallow: [],
    depth: null,
    thinPack: false,
    noProgress: false,
    done: false,
    caps: [],
  };
  let section = 1;
  for (const item of items) {
    if (item.kind === 'flush') {
      section = 2;
      continue;
    }
    if (item.kind !== 'data') continue;
    const raw = item.data.toString('utf8');
    const line = raw.trim();
    if (section === 1) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        const nul = rest.indexOf('\0');
        if (nul >= 0) {
          // NUL-separated capabilities (tolerated variant).
          args.wants.push(rest.slice(0, nul).trim());
          args.caps = rest.slice(nul + 1).trim().split(/\s+/).filter((c) => c.length > 0);
        } else {
          // Space-separated capabilities on the first want line
          // (the standard v0 form): first token is the oid.
          const tokens = rest.trim().split(/\s+/);
          args.wants.push(tokens[0]);
          if (tokens.length > 1) args.caps = tokens.slice(1);
        }
      } else if (line.startsWith('shallow ')) {
        args.shallow.push(line.slice(8).trim());
      } else if (line.startsWith('deepen ')) {
        const n = parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n)) args.depth = n;
      }
    } else {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      // 'done' ends the request; deepen-since/deepen-not ignored.
    }
  }
  if (args.wants.length === 0) throw new Error('fetch v0: no want lines');
  return args;
}

export function buildFetchV0Response(store: Store, repo: Repo, args: FetchV0Args): Buffer {
  const plan = computeFetch(store, repo, args);
  const parts: Buffer[] = [];
  // Bare text lines first (NAK/ACK, shallow/unshallow), then sideband pack.
  if (args.haves.length === 0 || plan.acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  }
  for (const oid of plan.newShallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack(store, plan.objects);
  for (const p of sidebandEncode(1, pack)) parts.push(p);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface ReceiveCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
}

export interface ReceivePackRequest {
  commands: ReceiveCommand[];
  caps: string[];
  pack: Buffer | null; // raw pack bytes after the flush (null when absent)
}

export function parseReceivePackRequest(buf: Buffer): ReceivePackRequest {
  const { items, consumed } = decodePkts(buf);
  const commands: ReceiveCommand[] = [];
  let caps: string[] = [];
  for (const item of items) {
    if (item.kind === 'flush') break;
    if (item.kind !== 'data') continue;
    const raw = item.data.toString('utf8');
    const line = raw.trim();
    const nul = line.indexOf('\0');
    let cmd = line;
    if (nul >= 0) {
      cmd = line.slice(0, nul);
      caps = line.slice(nul + 1).trim().split(/\s+/).filter((c) => c.length > 0);
    }
    const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(cmd.trim());
    if (!m) throw new Error('receive-pack: bad command line');
    commands.push({ oldOid: m[1], newOid: m[2], ref: m[3] });
  }
  const rest = buf.subarray(consumed);
  return { commands, caps, pack: rest.length > 0 ? Buffer.from(rest) : null };
}

export interface RefResult {
  ref: string;
  ok: boolean;
  reason?: string;
}

// Report-status stream: `unpack ok` + one `ok`/`ng` line per ref.
// Sideband band 1 when negotiated (band 2 carries one progress line).
export function buildReceivePackReport(results: RefResult[], sideband: boolean, unpackOk = true): Buffer {
  const lines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack failed\n'];
  for (const r of results) {
    lines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason ?? 'failed'}\n`);
  }
  if (!sideband) {
    return pktLines(lines);
  }
  // Band 1 carries the report-status pkt-line stream itself (lines +
  // flush), so the client parses it as pkt-lines after demuxing.
  const inner = pktLines(lines);
  const parts: Buffer[] = [];
  for (const p of sidebandEncode(1, inner)) parts.push(p);
  for (const p of sidebandEncode(2, Buffer.from('unpacking objects: done.\n', 'utf8'))) parts.push(p);
  parts.push(flushPkt());
  return Buffer.concat(parts);
}
