// GraphQL v4 (POST /api/graphql) for the git forge.
//
// Original implementation written from the wire shapes the checks send
// (the 18 documents: viewer/repository reads, __type introspection,
// issues/PRs reads, cursor pagination, node(id:), batching, and the five
// mutations). No GraphQL library: a small lexer + recursive-descent parser
// for the document subset the clients send, a typed resolver table, and
// execution against the same in-memory store the REST and git layers use.
//
// Auth: a missing or wrong Bearer token is HTTP 401 (same rule as app.ts:
// MAKEFUN_SHOP_TOKEN when set, otherwise any non-empty Bearer token).
// A GraphQL-level failure is HTTP 200 carrying {data, errors}; an unknown
// repository reads data.repository = null with no errors; a foreign owner
// never leaks (null, never 403). Global ids are the store's opaque gids.
//
// Determinism: ids are counters/gids, ordering is insertion order or the
// requested orderBy, cursors encode an index. No wall clock, no randomness;
// the only "now" is the trial-now helper.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Issue, IssueComment, PullRequest, Repo, Store } from './store.ts';
import { getRepo, gid } from './store.ts';
import { makeCommit, makeTree, parseCommit, flattenTree } from './gitpack.ts';
import {
  BodyError,
  deriveViewerLogin,
  isRecord,
  parseJsonBody,
  readBody,
  sendJson,
  trialNowEpoch,
  trialNowIso,
} from './util.ts';

// ---------------------------------------------------------------------------
// Auth (same rule as app.ts; this handler owns its auth)
// ---------------------------------------------------------------------------

function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (expected === '') return true;
  return token === expected;
}

// ---------------------------------------------------------------------------
// Global ids + shared store mutations (also used by mcp.ts)
// ---------------------------------------------------------------------------

export interface DecodedId {
  kind: string;
  owner: string;
  name: string;
  number: number | null;
  commentId: number | null;
}

/** Decode an opaque gid back to its parts, or null when it is not one. */
export function decodeGlobalId(id: unknown): DecodedId | null {
  if (typeof id !== 'string' || id === '') return null;
  let raw = '';
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const parts = raw.split(':');
  const kind = parts[0] ?? '';
  if (kind !== 'repo' && kind !== 'issue' && kind !== 'pr' && kind !== 'comment') return null;
  const fullName = parts[1] ?? '';
  const slash = fullName.indexOf('/');
  if (slash <= 0 || slash === fullName.length - 1) return null;
  const owner = fullName.slice(0, slash);
  const name = fullName.slice(slash + 1);
  const num = (idx: number): number | null => {
    const v = parts[idx];
    if (v === undefined || !/^[0-9]+$/.test(v)) return null;
    return Number.parseInt(v, 10);
  };
  return { kind, owner, name, number: num(2), commentId: num(3) };
}

/** The opaque global id of a repository. */
export function repoGlobalId(repo: Repo): string {
  return gid('repo', `${repo.owner}/${repo.name}`);
}

export function findRepoByGlobalId(store: Store, id: unknown): Repo | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'repo') return null;
  return getRepo(store, decoded.owner, decoded.name) ?? null;
}

export function findIssueByGlobalId(store: Store, id: unknown): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'issue' || decoded.number === null) return null;
  const repo = getRepo(store, decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const issue = repo.issues.find((entry) => entry.number === decoded.number);
  return issue === undefined ? null : { repo, issue };
}

export function findPrByGlobalId(store: Store, id: unknown): { repo: Repo; pr: PullRequest } | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null || decoded.kind !== 'pr' || decoded.number === null) return null;
  const repo = getRepo(store, decoded.owner, decoded.name);
  if (repo === undefined) return null;
  const pr = repo.prs.find((entry) => entry.number === decoded.number);
  return pr === undefined ? null : { repo, pr };
}

/** Create an issue in the store (same numbering/ids as REST POST /issues). */
export function createIssueInStore(store: Store, repo: Repo, title: string, body: string): Issue {
  void store;
  const number = repo.issueSeq + 1;
  repo.issueSeq = number;
  const issue: Issue = {
    id: gid('issue', `${repo.owner}/${repo.name}`, number),
    number,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    seq: repo.issues.length,
  };
  repo.issues.push(issue);
  return issue;
}

/** Append a comment to an issue (same ids as REST POST /issues/{n}/comments). */
export function addCommentInStore(repo: Repo, issue: Issue, body: string): IssueComment {
  const id = repo.commentSeq + 1;
  repo.commentSeq = id;
  const comment: IssueComment = {
    id,
    gid: gid('comment', `${repo.owner}/${repo.name}`, issue.number, id),
    body,
  };
  issue.comments.push(comment);
  return comment;
}

/** Create a pull request in the store (null when a branch does not exist). */
export function createPullRequestInStore(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): PullRequest | null {
  void store;
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const number = repo.prSeq + 1;
  repo.prSeq = number;
  const pr: PullRequest = {
    id: gid('pr', `${repo.owner}/${repo.name}`, number),
    number,
    title,
    body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    seq: repo.prs.length,
  };
  repo.prs.push(pr);
  return pr;
}

// ---------------------------------------------------------------------------
// Git helpers for mergeable / changed files / squash merge
// (small, self-contained re-implementation over gitpack's object store)
// ---------------------------------------------------------------------------

function treeOf(store: Store, commitOid: string): string | null {
  const obj = store.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const tree = parseCommit(obj.data).tree;
  return tree === '' || tree === '0000000000000000000000000000000000000000' ? null : tree;
}

/** Flat file map (path -> blob oid) of a commit's tree; empty when unknown. */
function flatOf(store: Store, commitOid: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (commitOid === null) return out;
  const tree = treeOf(store, commitOid);
  if (tree === null) return out;
  for (const [path, entry] of flattenTree(store, tree)) out.set(path, entry.oid);
  return out;
}

/** Ancestor oids of a tip, newest first (BFS over parents, deduped). */
function commitAncestors(store: Store, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return out;
}

/** The merge base of two tips: the first common ancestor walking from `b`. */
function mergeBase(store: Store, a: string, b: string): string | null {
  const aSet = new Set(commitAncestors(store, a));
  for (const oid of commitAncestors(store, b)) {
    if (aSet.has(oid)) return oid;
  }
  return null;
}

/** Three-way conflict: both sides changed the same path vs the merge base. */
function isConflicted(store: Store, baseTip: string, headTip: string): boolean {
  const base = mergeBase(store, baseTip, headTip);
  const baseFlat = flatOf(store, baseTip);
  const headFlat = flatOf(store, headTip);
  const mbFlat = flatOf(store, base);
  const paths = new Set<string>([...mbFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const m = mbFlat.get(path);
    const b = baseFlat.get(path);
    const h = headFlat.get(path);
    if (b !== m && h !== m && b !== h) return true;
  }
  return false;
}

/** Rebuild a nested tree from a flat file map; returns the root tree oid. */
function buildTreeFromFlat(store: Store, flat: Map<string, string>): string {
  function build(prefix: string): string {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const files: Array<{ name: string; oid: string }> = [];
    const dirs = new Set<string>();
    for (const [path, oid] of flat) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash === -1) files.push({ name: rest, oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const file of files) entries.push({ mode: '100644', name: file.name, oid: file.oid });
    for (const dir of dirs) {
      const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      entries.push({ mode: '40000', name: dir, oid: build(subPrefix) });
    }
    return makeTree(store, entries);
  }
  return build('');
}

/** One forge commit object; returns its oid. */
function forgeCommit(store: Store, tree: string, parents: string[], message: string): string {
  const who = `Forge <forge@example.invalid> ${trialNowEpoch()} +0000`;
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return makeCommit(store, { tree, parents, author: who, committer: who, message: text });
}

/**
 * Squash-merge an open pull request: one commit on the base branch whose
 * tree is the base tree plus the head's changes against the merge base.
 * Returns ok:false with a reason when it cannot merge.
 */
export function mergePullRequestInStore(
  store: Store,
  repo: Repo,
  pr: PullRequest,
): { ok: boolean; reason?: string } {
  if (pr.state !== 'open') return { ok: false, reason: 'Pull request is already closed' };
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseTip === undefined || headTip === undefined) {
    return { ok: false, reason: 'Head or base branch is missing' };
  }
  if (isConflicted(store, baseTip, headTip)) {
    return { ok: false, reason: 'Merge conflict: both branches changed the same file differently' };
  }
  const base = mergeBase(store, baseTip, headTip);
  const next = new Map<string, string>(flatOf(store, baseTip));
  const mbFlat = flatOf(store, base);
  const headFlat = flatOf(store, headTip);
  for (const [path, oid] of headFlat) {
    if (mbFlat.get(path) !== oid) next.set(path, oid);
  }
  for (const path of mbFlat.keys()) {
    if (!headFlat.has(path)) next.delete(path);
  }
  const treeOid = buildTreeFromFlat(store, next);
  const commitOid = forgeCommit(store, treeOid, [baseTip], `${pr.title} (#${pr.number})`);
  repo.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = trialNowIso();
  pr.mergeCommitSha = commitOid;
  return { ok: true };
}

/** MERGEABLE / CONFLICTING / UNKNOWN for a pull request. */
export function prMergeable(store: Store, repo: Repo, pr: PullRequest): string {
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return isConflicted(store, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

/** Changed file paths of a pull request (merge base vs head), sorted. */
export function prChangedPaths(store: Store, pr: PullRequest): string[] {
  const base = mergeBase(store, pr.base.sha, pr.head.sha);
  const baseFlat = flatOf(store, base);
  const headFlat = flatOf(store, pr.head.sha);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: string[] = [];
  for (const path of [...paths].sort()) {
    if (baseFlat.get(path) !== headFlat.get(path)) out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function lex(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const push = (kind: TokenKind, value: string, startLine: number, startCol: number): void => {
    tokens.push({ kind, value, line: startLine, column: startCol });
  };
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === '\n') {
      i += 1;
      line += 1;
      column = 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === ',') {
      i += 1;
      column += 1;
      continue;
    }
    if (ch === '#') {
      while (i < src.length && src[i] !== '\n') {
        i += 1;
        column += 1;
      }
      continue;
    }
    const startLine = line;
    const startCol = column;
    if (ch === '.' && src.slice(i, i + 3) === '...') {
      push('spread', '...', startLine, startCol);
      i += 3;
      column += 3;
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or plain "..." with escapes.
      if (src.slice(i, i + 3) === '"""') {
        const end = src.indexOf('"""', i + 3);
        const raw = end === -1 ? src.slice(i + 3) : src.slice(i + 3, end);
        const consumed = end === -1 ? src.length - i : end + 3 - i;
        for (const c of raw) {
          if (c === '\n') {
            line += 1;
            column = 1;
          } else column += 1;
        }
        i += consumed;
        column += 3;
        push('string', raw.replace(/^\n/, '').replace(/\n$/, ''), startLine, startCol);
        continue;
      }
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < src.length) {
        const c = src[j] as string;
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < src.length) {
          const esc = src[j + 1] as string;
          const map: Record<string, string> = {
            '"': '"',
            '\\': '\\',
            '/': '/',
            b: '\b',
            f: '\f',
            n: '\n',
            r: '\r',
            t: '\t',
          };
          if (esc === 'u') {
            const hex = src.slice(j + 2, j + 6);
            value += String.fromCharCode(Number.parseInt(hex, 16));
            j += 6;
          } else {
            value += map[esc] ?? esc;
            j += 2;
          }
          continue;
        }
        if (c === '\n') {
          line += 1;
          column = 1;
        } else column += 1;
        value += c;
        j += 1;
      }
      if (!closed) throw new SyntaxError(`Unterminated string at line ${startLine}`);
      i = j + 1;
      column += 1;
      push('string', value, startLine, startCol);
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      let j = i;
      let isFloat = false;
      if (src[j] === '-') j += 1;
      while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      if (src[j] === '.' && /[0-9]/.test(src[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        isFloat = true;
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < src.length && /[0-9]/.test(src[j] as string)) j += 1;
      }
      const value = src.slice(i, j);
      column += j - i;
      i = j;
      push(isFloat ? 'float' : 'int', value, startLine, startCol);
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j] as string)) j += 1;
      const value = src.slice(i, j);
      column += j - i;
      i = j;
      push('name', value, startLine, startCol);
      continue;
    }
    if (PUNCT.has(ch)) {
      push('punct', ch, startLine, startCol);
      i += 1;
      column += 1;
      continue;
    }
    throw new SyntaxError(`Unexpected character ${JSON.stringify(ch)} at line ${line}`);
  }
  tokens.push({ kind: 'eof', value: '', line, column });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser (document subset: operations, fragments, fields, arguments, values)
// ---------------------------------------------------------------------------

type ValueNode =
  | { tag: 'var'; name: string }
  | { tag: 'literal'; value: string | number | boolean | null }
  | { tag: 'list'; items: ValueNode[] }
  | { tag: 'object'; fields: Record<string, ValueNode> };

interface FieldSelection {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Record<string, ValueNode> | null;
  selections: Selection[] | null;
  line: number;
  column: number;
}

interface InlineFragment {
  kind: 'fragment';
  typeCondition: string | null;
  selections: Selection[];
}

interface SpreadSelection {
  kind: 'spread';
  name: string;
}

type Selection = FieldSelection | InlineFragment | SpreadSelection;

interface OperationDef {
  kind: 'operation';
  opType: 'query' | 'mutation' | 'subscription';
  name: string | null;
  selections: Selection[];
}

interface FragmentDef {
  kind: 'fragmentDef';
  name: string;
  typeCondition: string;
  selections: Selection[];
}

type Definition = OperationDef | FragmentDef;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private atPunct(value: string): boolean {
    const t = this.peek();
    return t.kind === 'punct' && t.value === value;
  }

  private eatPunct(value: string): boolean {
    if (this.atPunct(value)) {
      this.next();
      return true;
    }
    return false;
  }

  private expectPunct(value: string): Token {
    if (!this.eatPunct(value)) {
      const t = this.peek();
      throw new SyntaxError(`Expected "${value}" but found ${JSON.stringify(t.value)} at line ${t.line}`);
    }
    return this.tokens[this.pos - 1] as Token;
  }

  private expectName(what = 'a name'): Token {
    const t = this.next();
    if (t.kind !== 'name') throw new SyntaxError(`Expected ${what} but found ${JSON.stringify(t.value)} at line ${t.line}`);
    return t;
  }

  parseDocument(): Definition[] {
    const defs: Definition[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): Definition {
    const t = this.peek();
    if (t.kind === 'name' && t.value === 'fragment') {
      this.next();
      const name = this.expectName('a fragment name').value;
      const on = this.expectName('on');
      if (on.value !== 'on') throw new SyntaxError(`Expected "on" at line ${on.line}`);
      const typeCondition = this.expectName('a type name').value;
      this.skipDirectives();
      return { kind: 'fragmentDef', name, typeCondition, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'name' && (t.value === 'query' || t.value === 'mutation' || t.value === 'subscription')) {
      const opType = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | null = null;
      if (this.peek().kind === 'name') name = this.next().value;
      if (this.atPunct('(')) this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', opType, name, selections: this.parseSelectionSet() };
    }
    if (t.kind === 'punct' && t.value === '{') {
      return { kind: 'operation', opType: 'query', name: null, selections: this.parseSelectionSet() };
    }
    throw new SyntaxError(`Unexpected ${JSON.stringify(t.value)} at line ${t.line}`);
  }

  private parseVariableDefinitions(): void {
    this.expectPunct('(');
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated variable definitions');
      this.expectPunct('$');
      this.expectName('a variable name');
      this.expectPunct(':');
      this.parseType();
      if (this.eatPunct('=')) this.parseValue();
      this.skipDirectives();
    }
    this.expectPunct(')');
  }

  private parseType(): void {
    if (this.eatPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName('a type name');
    }
    this.eatPunct('!');
  }

  /** Skip @directive[(...)] occurrences. */
  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName('a directive name');
      if (this.atPunct('(')) this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expectPunct('{');
    const selections: Selection[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      const t = this.peek();
      if (t.kind === 'name' && t.value === 'on') {
        this.next();
        const typeCondition = this.expectName('a type name').value;
        this.skipDirectives();
        return { kind: 'fragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (t.kind === 'punct' && t.value === '{') {
        this.skipDirectives();
        return { kind: 'fragment', typeCondition: null, selections: this.parseSelectionSet() };
      }
      const name = this.expectName('a fragment name').value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    const first = this.expectName('a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.eatPunct(':')) {
      alias = name;
      name = this.expectName('a field name').value;
    }
    let args: Record<string, ValueNode> | null = null;
    if (this.atPunct('(')) args = this.parseArguments();
    this.skipDirectives();
    let selections: Selection[] | null = null;
    if (this.atPunct('{')) selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections, line: first.line, column: first.column };
  }

  private parseArguments(): Record<string, ValueNode> {
    this.expectPunct('(');
    const args: Record<string, ValueNode> = {};
    while (!this.atPunct(')')) {
      if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated arguments');
      const name = this.expectName('an argument name').value;
      this.expectPunct(':');
      args[name] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const t = this.next();
    if (t.kind === 'punct' && t.value === '$') {
      return { tag: 'var', name: this.expectName('a variable name').value };
    }
    if (t.kind === 'string') return { tag: 'literal', value: t.value };
    if (t.kind === 'int' || t.kind === 'float') return { tag: 'literal', value: Number(t.value) };
    if (t.kind === 'punct' && t.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated list');
        items.push(this.parseValue());
      }
      this.next();
      return { tag: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      const fields: Record<string, ValueNode> = {};
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        if (this.peek().kind === 'eof') throw new SyntaxError('Unterminated input object');
        const name = this.expectName('a field name').value;
        this.expectPunct(':');
        fields[name] = this.parseValue();
      }
      this.next();
      return { tag: 'object', fields };
    }
    if (t.kind === 'name') {
      if (t.value === 'true') return { tag: 'literal', value: true };
      if (t.value === 'false') return { tag: 'literal', value: false };
      if (t.value === 'null') return { tag: 'literal', value: null };
      return { tag: 'literal', value: t.value };
    }
    throw new SyntaxError(`Unexpected value ${JSON.stringify(t.value)} at line ${t.line}`);
  }
}

/** Resolve a parsed value node against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  if (node.tag === 'var') return variables[node.name] ?? null;
  if (node.tag === 'literal') return node.value;
  if (node.tag === 'list') return node.items.map((item) => resolveValue(item, variables));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node.fields)) out[key] = resolveValue(value, variables);
  return out;
}

function resolveArgs(
  args: Record<string, ValueNode> | null,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (args === null) return out;
  for (const [key, value] of Object.entries(args)) out[key] = resolveValue(value, variables);
  return out;
}

// ---------------------------------------------------------------------------
// Schema surface (fields per type, enum values) — for validation + __type
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate',
    'createdAt', 'updatedAt', 'url',
  ],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'comments',
    'labels', 'repository', 'url',
  ],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'headRef', 'baseRef', 'createdAt', 'updatedAt', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes'],
  User: ['id', 'login', 'name'],
  Ref: ['name', 'target'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  Label: ['name', 'color'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Obj =
  | { __typename: 'Query' }
  | { __typename: 'Mutation' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: Issue }
  | { __typename: 'IssueConnection'; nodes: Obj[]; pageInfo: Obj }
  | { __typename: 'PageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { __typename: 'PullRequest'; repo: Repo; pr: PullRequest }
  | { __typename: 'PullRequestConnection'; nodes: Obj[] }
  | { __typename: 'PullRequestChangedFileConnection'; nodes: Obj[] }
  | { __typename: 'PullRequestChangedFile'; path: string }
  | { __typename: 'User'; login: string }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'CreateIssuePayload'; issue: Obj }
  | { __typename: 'CloseIssuePayload'; issue: Obj }
  | { __typename: 'CreatePullRequestPayload'; pullRequest: Obj }
  | { __typename: 'MergePullRequestPayload'; pullRequest: Obj }
  | { __typename: 'AddCommentPayload'; commentEdge: Obj }
  | { __typename: 'IssueCommentEdge'; node: Obj }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: 'Label'; name: string }
  | { __typename: '__Type'; typeName: string; kind: string; fields: readonly string[] | null; enumValues: readonly string[] | null }
  | { __typename: '__Field'; name: string }
  | { __typename: '__EnumValue'; name: string };

class GqlError extends Error {}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: (string | number)[]; locations?: Array<{ line: number; column: number }> }>;
  fragments: Map<string, FragmentDef>;
}

function viewerLoginOf(store: Store): string {
  return store.viewerLogin ?? deriveViewerLogin();
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function prState(pr: PullRequest): string {
  if (pr.merged) return 'MERGED';
  return pr.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueObj(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function prObj(repo: Repo, pr: PullRequest): Obj {
  return { __typename: 'PullRequest', repo, pr };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function decodeCursor(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const raw = Buffer.from(value, 'base64url').toString('utf8');
    const match = /^cursor:([0-9]+)$/.exec(raw);
    if (match === null) return null;
    return Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

/** The issues connection for a repo: states filter, orderBy, first/after. */
function issuesConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  void store;
  let items = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    items = items.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const ascending = orderBy.direction === 'ASC';
  items.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
  const afterIndex = decodeCursor(args.after);
  const start = afterIndex === null ? 0 : afterIndex + 1;
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : items.length;
  const page = items.slice(start, start + first);
  const endIndex = page.length > 0 ? start + page.length - 1 : null;
  const nodes: Obj[] = page.map((issue) => issueObj(repo, issue));
  const pageInfo: Obj = {
    __typename: 'PageInfo',
    hasNextPage: start + page.length < items.length,
    endCursor: endIndex === null ? null : encodeCursor(endIndex),
  };
  return { __typename: 'IssueConnection', nodes, pageInfo };
}

/** The pull-requests connection for a repo (open PRs, creation order). */
function pullRequestsConnection(repo: Repo, args: Record<string, unknown>): Obj {
  const open = repo.prs.filter((pr) => pr.state === 'open');
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : open.length;
  const nodes: Obj[] = open.slice(0, first).map((pr) => prObj(repo, pr));
  return { __typename: 'PullRequestConnection', nodes };
}

function strArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function intArg(args: Record<string, unknown>, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function inputArg(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  return isRecord(value) ? value : {};
}

function resolveField(obj: Obj, field: string, args: Record<string, unknown>, ctx: ExecContext): unknown {
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      if (field === 'viewer') return { __typename: 'User', login: viewerLoginOf(store) } satisfies Obj;
      if (field === 'repository') {
        const repo = getRepo(store, strArg(args, 'owner'), strArg(args, 'name'));
        return repo === undefined ? null : repoObj(repo);
      }
      if (field === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'repo') {
          const repo = getRepo(store, decoded.owner, decoded.name);
          return repo === undefined ? null : repoObj(repo);
        }
        if (decoded.kind === 'issue' && decoded.number !== null) {
          const found = findIssueByGlobalId(store, args.id);
          return found === null ? null : issueObj(found.repo, found.issue);
        }
        if (decoded.kind === 'pr' && decoded.number !== null) {
          const found = findPrByGlobalId(store, args.id);
          return found === null ? null : prObj(found.repo, found.pr);
        }
        return null;
      }
      if (field === '__type') {
        const name = strArg(args, 'name');
        if (name in TYPE_FIELDS) {
          return {
            __typename: '__Type',
            typeName: name,
            kind: 'OBJECT',
            fields: TYPE_FIELDS[name] as readonly string[],
            enumValues: null,
          } satisfies Obj;
        }
        if (name in ENUM_VALUES) {
          return {
            __typename: '__Type',
            typeName: name,
            kind: 'ENUM',
            fields: null,
            enumValues: ENUM_VALUES[name] as readonly string[],
          } satisfies Obj;
        }
        return null;
      }
      if (field === '__schema') return null;
      throw new GqlError(`Unknown field "${field}" on type "Query"`);
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = inputArg(args, 'input');
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (repo === null) throw new GqlError('Repository not found');
        const title = strArg(input, 'title');
        if (title === '') throw new GqlError('createIssue requires a title');
        const issue = createIssueInStore(store, repo, title, strArg(input, 'body'));
        return { __typename: 'CreateIssuePayload', issue: issueObj(repo, issue) } satisfies Obj;
      }
      if (field === 'closeIssue') {
        const input = inputArg(args, 'input');
        const found = findIssueByGlobalId(store, input.issueId);
        if (found === null) throw new GqlError('Issue not found');
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue) } satisfies Obj;
      }
      if (field === 'createPullRequest') {
        const input = inputArg(args, 'input');
        const repo = findRepoByGlobalId(store, input.repositoryId);
        if (repo === null) throw new GqlError('Repository not found');
        const pr = createPullRequestInStore(
          store,
          repo,
          strArg(input, 'title'),
          strArg(input, 'body'),
          strArg(input, 'headRefName'),
          strArg(input, 'baseRefName'),
        );
        if (pr === null) throw new GqlError('Head and base branches must exist');
        return { __typename: 'CreatePullRequestPayload', pullRequest: prObj(repo, pr) } satisfies Obj;
      }
      if (field === 'mergePullRequest') {
        const input = inputArg(args, 'input');
        const found = findPrByGlobalId(store, input.pullRequestId);
        if (found === null) throw new GqlError('Pull request not found');
        const merged = mergePullRequestInStore(store, found.repo, found.pr);
        if (!merged.ok) throw new GqlError(merged.reason ?? 'Pull request could not be merged');
        return { __typename: 'MergePullRequestPayload', pullRequest: prObj(found.repo, found.pr) } satisfies Obj;
      }
      if (field === 'addComment') {
        const input = inputArg(args, 'input');
        const found = findIssueByGlobalId(store, input.subjectId);
        if (found === null) throw new GqlError('Issue not found');
        const comment = addCommentInStore(found.repo, found.issue, strArg(input, 'body'));
        const node: Obj = { __typename: 'IssueComment', id: comment.gid, body: comment.body };
        return {
          __typename: 'AddCommentPayload',
          commentEdge: { __typename: 'IssueCommentEdge', node } satisfies Obj,
        } satisfies Obj;
      }
      throw new GqlError(`Unknown field "${field}" on type "Mutation"`);
    }
    case 'Repository': {
      const repo = obj.repo;
      if (field === 'id') return repoGlobalId(repo);
      if (field === 'databaseId') return repo.dbId;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return { __typename: 'User', login: repo.owner } satisfies Obj;
      if (field === 'defaultBranchRef') return { __typename: 'Ref', name: repo.defaultBranch } satisfies Obj;
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'createdAt' || field === 'updatedAt') return trialNowIso();
      if (field === 'url') return `/api/v3/repos/${repo.owner}/${repo.name}`;
      if (field === 'issue') {
        const number = intArg(args, 'number');
        if (number === null) return null;
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : issueObj(repo, issue);
      }
      if (field === 'issues') return issuesConnection(store, repo, args);
      if (field === 'pullRequests') return pullRequestsConnection(repo, args);
      if (field === 'pullRequest') {
        const number = intArg(args, 'number');
        if (number === null) return null;
        const pr = repo.prs.find((entry) => entry.number === number);
        return pr === undefined ? null : prObj(repo, pr);
      }
      throw new GqlError(`Unknown field "${field}" on type "Repository"`);
    }
    case 'Issue': {
      const issue = obj.issue;
      if (field === 'id') return issue.id;
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issueState(issue);
      if (field === 'body') return issue.body;
      if (field === 'createdAt' || field === 'updatedAt') return trialNowIso();
      if (field === 'author') return { __typename: 'User', login: obj.repo.owner } satisfies Obj;
      if (field === 'comments') return issue.comments.map((c) => ({ __typename: 'IssueComment', id: c.gid, body: c.body }) satisfies Obj);
      if (field === 'labels') return issue.labels.map((name) => ({ __typename: 'Label', name }) satisfies Obj);
      if (field === 'repository') return repoObj(obj.repo);
      if (field === 'url') return `/api/v3/repos/${obj.repo.owner}/${obj.repo.name}/issues/${issue.number}`;
      throw new GqlError(`Unknown field "${field}" on type "Issue"`);
    }
    case 'IssueConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return obj.nodes.length;
      if (field === 'edges') return obj.nodes.map((node) => ({ __typename: 'IssueCommentEdge', node }) satisfies Obj);
      throw new GqlError(`Unknown field "${field}" on type "IssueConnection"`);
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'endCursor') return obj.endCursor;
      if (field === 'hasPreviousPage') return false;
      if (field === 'startCursor') return null;
      throw new GqlError(`Unknown field "${field}" on type "PageInfo"`);
    }
    case 'PullRequest': {
      const pr = obj.pr;
      if (field === 'id') return pr.id;
      if (field === 'number') return pr.number;
      if (field === 'title') return pr.title;
      if (field === 'body') return pr.body;
      if (field === 'state') return prState(pr);
      if (field === 'merged') return pr.merged;
      if (field === 'headRefName') return pr.head.ref;
      if (field === 'baseRefName') return pr.base.ref;
      if (field === 'mergeable') return prMergeable(store, obj.repo, pr);
      if (field === 'headRef') return { __typename: 'Ref', name: pr.head.ref } satisfies Obj;
      if (field === 'baseRef') return { __typename: 'Ref', name: pr.base.ref } satisfies Obj;
      if (field === 'createdAt' || field === 'updatedAt') return trialNowIso();
      if (field === 'author') return { __typename: 'User', login: obj.repo.owner } satisfies Obj;
      if (field === 'files') {
        const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.floor(args.first)) : 100;
        const paths = prChangedPaths(store, pr).slice(0, first);
        const nodes: Obj[] = paths.map((path) => ({ __typename: 'PullRequestChangedFile', path }) satisfies Obj);
        return { __typename: 'PullRequestChangedFileConnection', nodes } satisfies Obj;
      }
      throw new GqlError(`Unknown field "${field}" on type "PullRequest"`);
    }
    case 'PullRequestConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } satisfies Obj;
      }
      if (field === 'totalCount') return obj.nodes.length;
      if (field === 'edges') return obj.nodes.map((node) => ({ __typename: 'IssueCommentEdge', node }) satisfies Obj);
      throw new GqlError(`Unknown field "${field}" on type "PullRequestConnection"`);
    }
    case 'PullRequestChangedFileConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'pageInfo') {
        return { __typename: 'PageInfo', hasNextPage: false, endCursor: null } satisfies Obj;
      }
      if (field === 'totalCount') return obj.nodes.length;
      throw new GqlError(`Unknown field "${field}" on type "PullRequestChangedFileConnection"`);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return 1;
      if (field === 'deletions') return 0;
      if (field === 'changes') return 1;
      throw new GqlError(`Unknown field "${field}" on type "PullRequestChangedFile"`);
    }
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return gid('user', obj.login);
      if (field === 'name') return obj.login;
      throw new GqlError(`Unknown field "${field}" on type "User"`);
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      if (field === 'target') return null;
      throw new GqlError(`Unknown field "${field}" on type "Ref"`);
    }
    case 'CreateIssuePayload': {
      if (field === 'issue') return obj.issue;
      if (field === 'clientMutationId') return null;
      throw new GqlError(`Unknown field "${field}" on type "CreateIssuePayload"`);
    }
    case 'CloseIssuePayload': {
      if (field === 'issue') return obj.issue;
      if (field === 'clientMutationId') return null;
      throw new GqlError(`Unknown field "${field}" on type "CloseIssuePayload"`);
    }
    case 'CreatePullRequestPayload': {
      if (field === 'pullRequest') return obj.pullRequest;
      if (field === 'clientMutationId') return null;
      throw new GqlError(`Unknown field "${field}" on type "CreatePullRequestPayload"`);
    }
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return obj.pullRequest;
      if (field === 'clientMutationId') return null;
      throw new GqlError(`Unknown field "${field}" on type "MergePullRequestPayload"`);
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return obj.commentEdge;
      if (field === 'clientMutationId') return null;
      throw new GqlError(`Unknown field "${field}" on type "AddCommentPayload"`);
    }
    case 'IssueCommentEdge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return null;
      throw new GqlError(`Unknown field "${field}" on type "IssueCommentEdge"`);
    }
    case 'IssueComment': {
      if (field === 'id') return obj.id;
      if (field === 'body') return obj.body;
      if (field === 'author') return null;
      if (field === 'createdAt') return trialNowIso();
      throw new GqlError(`Unknown field "${field}" on type "IssueComment"`);
    }
    case 'Label': {
      if (field === 'name') return obj.name;
      if (field === 'color') return 'ededed';
      throw new GqlError(`Unknown field "${field}" on type "Label"`);
    }
    case '__Type': {
      if (field === 'name') return obj.typeName;
      if (field === 'kind') return obj.kind;
      if (field === 'description') return null;
      if (field === 'fields') {
        if (obj.fields === null) return null;
        return obj.fields.map((name) => ({ __typename: '__Field', name }) satisfies Obj);
      }
      if (field === 'enumValues') {
        if (obj.enumValues === null) return null;
        return obj.enumValues.map((name) => ({ __typename: '__EnumValue', name }) satisfies Obj);
      }
      throw new GqlError(`Unknown field "${field}" on type "__Type"`);
    }
    case '__Field': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      throw new GqlError(`Unknown field "${field}" on type "__Field"`);
    }
    case '__EnumValue': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      throw new GqlError(`Unknown field "${field}" on type "__EnumValue"`);
    }
  }
}

function executeSelections(
  selections: Selection[],
  obj: Obj,
  ctx: ExecContext,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const def = ctx.fragments.get(selection.name);
      if (def === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (def.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelections(def.selections, obj, ctx, path));
      continue;
    }
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== obj.__typename) continue;
      Object.assign(out, executeSelections(selection.selections, obj, ctx, path));
      continue;
    }
    const responseName = selection.alias ?? selection.name;
    const fieldPath = [...path, responseName];
    if (selection.name === '__typename') {
      out[responseName] = obj.__typename;
      continue;
    }
    const known = TYPE_FIELDS[obj.__typename] as readonly string[] | undefined;
    if (known === undefined || !known.includes(selection.name)) {
      ctx.errors.push({
        message: `Cannot query field "${selection.name}" on type "${obj.__typename}".`,
        path: fieldPath,
        locations: [{ line: selection.line, column: selection.column }],
      });
      out[responseName] = null;
      continue;
    }
    let value: unknown;
    try {
      value = resolveField(obj, selection.name, resolveArgs(selection.args, ctx.variables), ctx);
    } catch (err) {
      if (err instanceof GqlError) {
        ctx.errors.push({
          message: err.message,
          path: fieldPath,
          locations: [{ line: selection.line, column: selection.column }],
        });
        out[responseName] = null;
        continue;
      }
      throw err;
    }
    if (selection.selections === null || selection.selections === undefined) {
      out[responseName] = value;
      continue;
    }
    if (value === null || value === undefined) {
      out[responseName] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseName] = value.map((entry, index) => {
        if (entry === null || entry === undefined) return null;
        if (typeof entry === 'object' && '__typename' in (entry as Record<string, unknown>)) {
          return executeSelections(selection.selections as Selection[], entry as Obj, ctx, [...fieldPath, index]);
        }
        return entry;
      });
      continue;
    }
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      out[responseName] = executeSelections(selection.selections, value as Obj, ctx, fieldPath);
      continue;
    }
    out[responseName] = value;
  }
  return out;
}

interface GraphQLResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string; path?: (string | number)[]; locations?: Array<{ line: number; column: number }> }>;
}

function executeOne(
  store: Store,
  entry: unknown,
): GraphQLResult {
  if (!isRecord(entry) || typeof entry.query !== 'string') {
    return { data: null, errors: [{ message: 'Request must include a query string.' }] };
  }
  const variables = isRecord(entry.variables) ? (entry.variables as Record<string, unknown>) : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let definitions: Definition[];
  try {
    definitions = new Parser(lex(entry.query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const operations = definitions.filter((d): d is OperationDef => d.kind === 'operation');
  const fragments = new Map<string, FragmentDef>();
  for (const def of definitions) {
    if (def.kind === 'fragmentDef') fragments.set(def.name, def);
  }
  let operation: OperationDef | undefined;
  if (operationName !== null) {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else {
    operation = operations[0];
  }
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation in the document.' }] };
  }
  const ctx: ExecContext = { store, variables, errors: [], fragments };
  const root: Obj = operation.opType === 'mutation' ? { __typename: 'Mutation' } : { __typename: 'Query' };
  let data: Record<string, unknown>;
  try {
    data = executeSelections(operation.selections, root, ctx, []);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authorized(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBody(await readBody(req));
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }
  if (parsed === null || (typeof parsed !== 'object' && !Array.isArray(parsed))) {
    sendJson(res, 400, { message: 'Request body must be a JSON object or array' });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => executeOne(store, entry));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, executeOne(store, parsed));
}
