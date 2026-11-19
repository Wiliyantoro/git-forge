// gitpack.ts — git object layer (pure TS, node:zlib + node:crypto only).
//
// Content-addressed storage with byte-exact round-trip: objects are stored
// and returned exactly as pushed, never re-encoded. SHA-1 of
// `<type> <size>\0` + bytes. Pack v2 parse (plain + OFS/REF deltas) and
// plain v2 pack generation (deltas optional per the audit, plain passes).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Oid, ObjectType, Store } from './store.ts';
import { ZERO_OID } from './store.ts';

export const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function oidFor(type: ObjectType, data: Buffer): Oid {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`, 'utf8');
  h.update(data);
  return h.digest('hex');
}

export function putObject(store: Store, type: ObjectType, data: Buffer): Oid {
  const oid = oidFor(type, data);
  if (!store.objects.has(oid)) {
    store.objects.set(oid, { type, data });
  }
  return oid;
}

export function getObject(store: Store, oid: Oid): { type: ObjectType; data: Buffer } | undefined {
  return store.objects.get(oid);
}

// ---------------------------------------------------------------------------
// Object byte builders (byte-exact; callers store via putObject)
// ---------------------------------------------------------------------------

export function blobBytes(data: string | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
}

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000'
  name: string;
  oid: Oid;
}

// Git sort: entries ordered by name, directories compared as name + '/'.
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  const key = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);
  return [...entries].sort((a, b) => {
    const ka = Buffer.from(key(a), 'utf8');
    const kb = Buffer.from(key(b), 'utf8');
    return Buffer.compare(ka, kb);
  });
}

export function treeBytes(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of sortTreeEntries(entries)) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitFields {
  tree: Oid;
  parents: Oid[];
  author: string; // `Name <email> <epoch> +0000`
  committer: string;
  message: string; // stored verbatim (scenario messages end with \n)
}

export function commitBytes(f: CommitFields): Buffer {
  let s = `tree ${f.tree}\n`;
  for (const p of f.parents) {
    s += `parent ${p}\n`;
  }
  s += `author ${f.author}\ncommitter ${f.committer}\n\n${f.message}`;
  return Buffer.from(s, 'utf8');
}

export interface TagFields {
  object: Oid;
  type: ObjectType;
  tag: string;
  tagger: string; // `Name <email> <epoch> +0000`
  message: string;
}

export function tagBytes(f: TagFields): Buffer {
  return Buffer.from(
    `object ${f.object}\ntype ${f.type}\ntag ${f.tag}\ntagger ${f.tagger}\n\n${f.message}`,
    'utf8',
  );
}

export function makeBlob(store: Store, data: string | Buffer): Oid {
  return putObject(store, 'blob', blobBytes(data));
}

export function makeTree(store: Store, entries: TreeEntry[]): Oid {
  return putObject(store, 'tree', treeBytes(entries));
}

export function makeCommit(store: Store, f: CommitFields): Oid {
  return putObject(store, 'commit', commitBytes(f));
}

export function makeTag(store: Store, f: TagFields): Oid {
  return putObject(store, 'tag', tagBytes(f));
}

// ---------------------------------------------------------------------------
// Object parsers
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: Oid;
  parents: Oid[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const out: ParsedCommit = { tree: ZERO_OID, parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(0x20, pos);
    if (sp < 0) throw new Error('pack: corrupt tree (no space)');
    const nul = data.indexOf(0x00, sp + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('pack: corrupt tree (no NUL/oid)');
    const mode = data.toString('utf8', pos, sp);
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function parseTag(data: Buffer): { object: Oid; type: string; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const out = { object: ZERO_OID, type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4);
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deltas
// ---------------------------------------------------------------------------

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readVarint = (): number => {
    let v = 0;
    let shift = 0;
    let b = 0;
    do {
      if (p >= delta.length) throw new Error('pack: truncated delta varint');
      b = delta[p++];
      v |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return v;
  };
  const srcSize = readVarint();
  if (srcSize !== base.length) throw new Error('pack: delta base size mismatch');
  const tgtSize = readVarint();
  const chunks: Buffer[] = [];
  let len = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      if (op & 0x01) off = delta[p++];
      if (op & 0x02) off |= delta[p++] << 8;
      if (op & 0x04) off |= delta[p++] << 16;
      if (op & 0x08) off |= delta[p++] << 24;
      if (op & 0x10) size = delta[p++];
      if (op & 0x20) size |= delta[p++] << 8;
      if (op & 0x40) size |= delta[p++] << 16;
      if (size === 0) size = 0x10000;
      if (off + size > base.length) throw new Error('pack: delta copy overruns base');
      chunks.push(base.subarray(off, off + size));
      len += size;
    } else if (op !== 0) {
      if (p + op > delta.length) throw new Error('pack: delta insert overruns');
      chunks.push(delta.subarray(p, p + op));
      len += op;
      p += op;
    } else {
      throw new Error('pack: delta opcode 0');
    }
  }
  if (len !== tgtSize) throw new Error('pack: delta target size mismatch');
  return Buffer.concat(chunks, len);
}

// ---------------------------------------------------------------------------
// Pack parsing (v2/v3, plain + OFS_DELTA + REF_DELTA)
// ---------------------------------------------------------------------------

export interface ParsedObject {
  oid: Oid;
  type: ObjectType;
  data: Buffer;
}

interface RawEntry {
  offset: number;
  code: number;
  size: number;
  data: Buffer; // inflated payload (delta bytes for delta entries)
  baseOffset: number | null; // OFS_DELTA
  baseOid: Oid | null; // REF_DELTA
}

// inflateSync ignores trailing bytes but throws on truncation, so the exact
// end of a zlib stream is found by binary search for the smallest slice
// that inflates to the full stream.
function inflateAt(buf: Buffer, pos: number, endLimit: number): { data: Buffer; consumed: number } {
  let full: Buffer;
  try {
    full = inflateSync(buf.subarray(pos, endLimit));
  } catch {
    throw new Error('pack: corrupt zlib stream');
  }
  let lo = pos + 1;
  let hi = endLimit;
  let ans = endLimit;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const d = inflateSync(buf.subarray(pos, mid));
      if (d.length === full.length) {
        ans = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  return { data: full, consumed: ans - pos };
}

export function parsePack(buf: Buffer, store?: Store): ParsedObject[] {
  if (buf.length < 12 + 20) throw new Error('pack: too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack: bad magic');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('pack: unsupported version');
  const count = buf.readUInt32BE(8);
  // Trailer SHA-1 verification (over all preceding bytes).
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack: trailer checksum mismatch');
  const endLimit = buf.length - 20;

  const entries: RawEntry[] = [];
  let pos = 12;
  for (let i = 0; i < count; i++) {
    const startOffset = pos;
    if (pos >= endLimit) throw new Error('pack: truncated entry header');
    let b = buf[pos++];
    const code = (b >> 4) & 7;
    let size = b & 15;
    let shift = 4;
    while (b & 0x80) {
      if (pos >= endLimit) throw new Error('pack: truncated size varint');
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | null = null;
    let baseOid: Oid | null = null;
    if (code === 6) {
      // OFS_DELTA: negative-offset varint.
      if (pos >= endLimit) throw new Error('pack: truncated ofs-delta offset');
      b = buf[pos++];
      let off = b & 0x7f;
      while (b & 0x80) {
        if (pos >= endLimit) throw new Error('pack: truncated ofs-delta offset');
        b = buf[pos++];
        off = ((off + 1) << 7) | (b & 0x7f);
      }
      if (off <= 0 || off > startOffset) throw new Error('pack: bad ofs-delta base offset');
      baseOffset = startOffset - off;
    } else if (code === 7) {
      if (pos + 20 > endLimit) throw new Error('pack: truncated ref-delta base oid');
      baseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!(code >= 1 && code <= 4)) {
      throw new Error(`pack: unknown object type code ${code}`);
    }
    const { data, consumed } = inflateAt(buf, pos, endLimit);
    if (data.length !== size) throw new Error('pack: inflated size mismatch');
    pos += consumed;
    entries.push({ offset: startOffset, code, size, data, baseOffset, baseOid });
  }
  if (pos !== endLimit) throw new Error('pack: trailing bytes before trailer');

  // Resolve entries (deltas may chain; bases are earlier entries, or — for
  // REF_DELTA thin packs — objects already in the store).
  const byOffset = new Map<number, ParsedObject>();
  const resolving = new Set<number>();
  const resolve = (e: RawEntry): ParsedObject => {
    const cached = byOffset.get(e.offset);
    if (cached) return cached;
    if (resolving.has(e.offset)) throw new Error('pack: delta cycle');
    resolving.add(e.offset);
    let out: ParsedObject;
    if (e.code >= 1 && e.code <= 4) {
      const type = CODE_TYPES[e.code];
      out = { oid: oidFor(type, e.data), type, data: e.data };
    } else {
      let base: ParsedObject | undefined;
      if (e.baseOffset !== null) {
        const baseEntry = entries.find((x) => x.offset === e.baseOffset);
        if (!baseEntry) throw new Error('pack: ofs-delta base not found');
        base = resolve(baseEntry);
      } else if (e.baseOid !== null) {
        const baseEntry = entries.find((x) => {
          const r = byOffset.get(x.offset);
          return r !== undefined && r.oid === e.baseOid;
        });
        if (baseEntry) {
          base = resolve(baseEntry);
        } else if (store) {
          const obj = store.objects.get(e.baseOid);
          if (obj) base = { oid: e.baseOid, type: obj.type, data: obj.data };
        }
        if (!base) {
          // Base may be an entry not yet resolved (plain or delta);
          // try resolving each other entry until one matches.
          for (const cand of entries) {
            if (cand.offset === e.offset) continue;
            try {
              const r = resolve(cand);
              if (r.oid === e.baseOid) {
                base = r;
                break;
              }
            } catch {
              // Not this entry's base; keep looking.
            }
          }
        }
        if (!base) throw new Error('pack: ref-delta base not found');
      } else {
        throw new Error('pack: delta without base');
      }
      const data = applyDelta(base.data, e.data);
      out = { oid: oidFor(base.type, data), type: base.type, data };
    }
    resolving.delete(e.offset);
    byOffset.set(e.offset, out);
    return out;
  };
  const objects = entries.map((e) => resolve(e));
  if (objects.length !== count) throw new Error('pack: entry count mismatch');
  return objects;
}

// ---------------------------------------------------------------------------
// Pack generation (plain v2, deterministic entry order sorted by oid)
// ---------------------------------------------------------------------------

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 15);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export function buildPack(store: Store, oids: Iterable<Oid>): Buffer {
  const sorted = [...new Set(oids)].sort();
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(sorted.length, 0);
  for (const oid of sorted) {
    const obj = store.objects.get(oid);
    if (!obj) continue; // callers pass reachable oids; skip quietly if absent
    parts.push(packObjectHeader(TYPE_CODES[obj.type], obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  // Recompute the count from actually emitted entries (skipped oids above
  // would otherwise break declaredCount == entries).
  const emitted = sorted.filter((oid) => store.objects.has(oid)).length;
  parts[2].writeUInt32BE(emitted, 0);
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// Reachability / ancestry / tree helpers
// ---------------------------------------------------------------------------

function objectChildren(store: Store, oid: Oid): Oid[] {
  const obj = store.objects.get(oid);
  if (!obj) return [];
  if (obj.type === 'commit') {
    const c = parseCommit(obj.data);
    return [c.tree, ...c.parents];
  }
  if (obj.type === 'tag') {
    return [parseTag(obj.data).object];
  }
  if (obj.type === 'tree') {
    return parseTree(obj.data)
      .filter((e) => e.mode !== '160000')
      .map((e) => e.oid);
  }
  return [];
}

// Closure over commit -> tree/parents, tag -> target, tree -> entries
// (gitlinks mode 160000 skipped). `exclude` oids (and everything reachable
// from them) are omitted from the result.
export function collectReachable(store: Store, tips: Oid[], exclude?: Set<Oid> | Oid[]): Set<Oid> {
  const excluded = new Set<Oid>();
  if (exclude) {
    const stack = [...(exclude instanceof Set ? exclude : exclude)];
    while (stack.length > 0) {
      const oid = stack.pop() as Oid;
      if (excluded.has(oid)) continue;
      excluded.add(oid);
      for (const child of objectChildren(store, oid)) {
        if (!excluded.has(child)) stack.push(child);
      }
    }
  }
  const seen = new Set<Oid>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (seen.has(oid) || excluded.has(oid)) continue;
    if (!store.objects.has(oid)) continue;
    seen.add(oid);
    for (const child of objectChildren(store, oid)) {
      if (!seen.has(child) && !excluded.has(child)) stack.push(child);
    }
  }
  return seen;
}

// Objects reachable from a set of commits WITHOUT following commit parents:
// each commit itself plus its full tree closure (trees + blobs).
export function collectCommitObjects(store: Store, commits: Iterable<Oid>): Set<Oid> {
  const out = new Set<Oid>();
  const stack: Oid[] = [];
  for (const c of commits) {
    if (!store.objects.has(c)) continue;
    out.add(c);
    const obj = store.objects.get(c) as { type: ObjectType; data: Buffer };
    if (obj.type === 'commit') {
      stack.push(parseCommit(obj.data).tree);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (out.has(oid)) continue;
    const obj = store.objects.get(oid);
    if (!obj) continue;
    out.add(oid);
    if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode !== '160000' && !out.has(e.oid)) stack.push(e.oid);
      }
    } else if (obj.type === 'commit') {
      stack.push(parseCommit(obj.data).tree);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return out;
}

export function isAncestor(store: Store, ancestor: Oid, descendant: Oid): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<Oid>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (!seen.has(p)) stack.push(p);
    }
  }
  return false;
}

// Resolve `path` (e.g. 'src/a.txt') inside a tree. Returns the leaf entry
// or null when any component is missing.
export function readTreePath(
  store: Store,
  treeOid: Oid,
  path: string,
): { oid: Oid; mode: string } | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) return { oid: treeOid, mode: '40000' };
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = store.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

// Return a new tree oid with `path` set to `blobOid` (mode `100644` by
// default) or deleted when blobOid is null. Creates intermediate trees as
// needed; a directory left empty by a delete loses its entry. treeOid may
// be null (unborn repo -> start from an empty tree).
export function writeTreePath(
  store: Store,
  treeOid: Oid | null,
  path: string,
  blobOid: Oid | null,
  mode = '100644',
): Oid {
  const parts = path.split('/').filter((p) => p.length > 0);
  if (parts.length === 0) throw new Error('writeTreePath: empty path');
  const rec = (tree: Oid | null, idx: number): Oid => {
    const entries: TreeEntry[] =
      tree !== null && store.objects.has(tree)
        ? parseTree((store.objects.get(tree) as { type: ObjectType; data: Buffer }).data)
        : [];
    const name = parts[idx];
    const rest = entries.filter((e) => e.name !== name);
    if (idx === parts.length - 1) {
      if (blobOid !== null) rest.push({ mode, name, oid: blobOid });
    } else {
      const existing = entries.find((e) => e.name === name);
      const childTree = existing !== undefined && existing.mode === '40000' ? existing.oid : null;
      const newChild = rec(childTree, idx + 1);
      const childEntries = parseTree((store.objects.get(newChild) as { type: ObjectType; data: Buffer }).data);
      if (childEntries.length > 0) {
        rest.push({ mode: '40000', name, oid: newChild });
      }
      // Empty child tree after a delete: drop the directory entry.
    }
    return putObject(store, 'tree', treeBytes(rest));
  };
  return rec(treeOid, 0);
}

// Map of every file path in a tree to its blob oid + mode (recursive).
export function flattenTree(store: Store, treeOid: Oid): Map<string, { oid: Oid; mode: string }> {
  const out = new Map<string, { oid: Oid; mode: string }>();
  const walk = (tree: Oid, prefix: string): void => {
    const obj = store.objects.get(tree);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        walk(e.oid, p);
      } else if (e.mode !== '160000') {
        out.set(p, { oid: e.oid, mode: e.mode });
      }
    }
  };
  walk(treeOid, '');
  return out;
}
