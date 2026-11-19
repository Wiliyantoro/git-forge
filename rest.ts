// REST v3 handlers for /api/v3 (repos, branches, commits, contents,
// labels, issues, comments, pull requests, merges).
//
// `handleRest(req, res, store)` returns true when it answered the request
// (including 4xx answers for known routes) and false when the path is not a
// REST route at all, so the router can answer 404.
//
// ---------------------------------------------------------------------------
// Contracts this file codes against (store.ts / gitpack.ts as written by the
// git builder - signatures below are the real ones, verified by reading them):
//
// Store:
//   viewerLogin: string | null               // captured via noteOwner(store, login)
//   repos: Map<string, Repo>                  // key `${owner}/${name}`
//   objects: Map<Oid, { type, data: Buffer }>
//   repoDbSeq: number                         // monotonic repo counter
//   createRepo(store, owner, name, description, isPrivate): Repo
//   gid(kind, ...parts): string               // opaque base64url id
//   noteOwner(store, login): void             // first-seen viewer capture
// Repo:
//   owner, name, description: string; isPrivate: boolean
//   defaultBranch: string; dbId: number
//   refs: Map<string, Oid>                    // 'refs/heads/main' -> tip
//   issues: Issue[]; prs: PullRequest[]
//   labels: Map<string, { name: string; color: string }>
//   issueSeq, prSeq, commentSeq: number       // all start at 0
// Issue:
//   id: string (opaque gid); number: number; title, body: string
//   state: 'open' | 'closed'; labels: string[] (names)
//   comments: Array<{ id: number; gid: string; body: string }>
//   seq: number                               // insertion sequence
// PullRequest:
//   id: string (opaque gid); number: number; title, body: string
//   state: 'open' | 'closed'
//   head: { ref: string; sha: string }; base: { ref: string; sha: string }
//   merged: boolean; mergedAt: string | null; mergeCommitSha: string | null
//   seq: number                               // insertion sequence
//
// gitpack.ts (signatures this file calls - store-first, returning oids):
//   makeBlob(store, data: string | Buffer): Oid
//   makeTree(store, entries: { mode, name, oid }[]): Oid  // git-sorted
//   makeCommit(store, { tree, parents, author, committer, message }): Oid
//       // author/committer are full `Name <email> <epoch> +0000` strings;
//       // message is stored verbatim (so pass it with a trailing newline)
//   readTreePath(store, treeOid, path): { oid, mode } | null
//       // leaf entry for a file or directory path; null when missing
//   writeTreePath(store, treeOid: Oid | null, path, blobOid: Oid | null): Oid
//       // new root tree oid; blobOid null deletes the entry (pruning empty dirs)
//   flattenTree(store, treeOid): Map<string, { oid, mode }>
//       // every file path -> blob oid + mode, recursive
//
// Ownership: a repo belongs to the derived viewer login (see util.ts). Any
// other {owner} in a repo path is a 404, never a 403.
// Determinism: commit author/committer use MAKEFUN_TRIAL_NOW; ids are
// counters; ordering is insertion order. No wall clock, no randomness.
// ---------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Store, Repo, Issue, PullRequest } from './store.ts';
import { createRepo, gid } from './store.ts';
import {
  makeBlob,
  makeTree,
  makeCommit,
  readTreePath,
  writeTreePath,
  flattenTree,
} from './gitpack.ts';
import {
  BodyError,
  b64decode,
  b64encode,
  decodeSegment,
  deriveViewerLogin,
  isRecord,
  linkHeader,
  parseJsonBody,
  parseQuery,
  readBody,
  requestId,
  sendJson,
  trialNowEpoch,
  trialNowIso,
} from './util.ts';

type Oid = string;

/** This forge's only owner login; every repo path is checked against it. */
const VIEWER = deriveViewerLogin();

/** Split the request path into decoded segments (empty segments dropped). */
function pathSegments(req: IncomingMessage): string[] {
  let path = '/';
  try {
    path = new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    path = '/';
  }
  return path
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
}

/** Read a JSON object body; {} when no body was sent; 400 when malformed. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = parseJsonBody(await readBody(req));
  if (parsed === null) return {};
  if (!isRecord(parsed)) throw new BodyError(400, 'JSON body must be an object');
  return parsed;
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

function optStr(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function parseNumber(segment: string): number | null {
  if (!/^[0-9]+$/.test(segment)) return null;
  const n = Number.parseInt(segment, 10);
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const perPageRaw = Number.parseInt(q.get('per_page') ?? '30', 10);
  const pageRaw = Number.parseInt(q.get('page') ?? '1', 10);
  return {
    page: Number.isSafeInteger(pageRaw) && pageRaw > 0 ? pageRaw : 1,
    perPage: Number.isSafeInteger(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
  };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// Repo lookup + JSON shapes
// ---------------------------------------------------------------------------

/** The repo at /repos/{owner}/{name}, or null (wrong owner is a 404 too). */
function getRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER) return null;
  return store.repos.get(`${owner}/${name}`) ?? null;
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: repo.owner },
    comments: issue.comments.length,
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.id,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    head: { ref: pr.head.ref, sha: pr.head.sha, label: `${repo.owner}:${pr.head.ref}` },
    base: { ref: pr.base.ref, sha: pr.base.sha, label: `${repo.owner}:${pr.base.ref}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    user: { login: repo.owner },
    created_at: trialNowIso(),
    updated_at: trialNowIso(),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

function notFound(res: ServerResponse, what: string): void {
  sendJson(res, 404, { message: `${what} not found` });
}

// ---------------------------------------------------------------------------
// Git-object helpers (commits, trees, ancestry)
// ---------------------------------------------------------------------------

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  authorEpoch: number;
}

/** Parse stored commit bytes (header lines, blank line, message). */
function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2).replace(/\n$/, '') : '';
  const out: ParsedCommit = {
    tree: '',
    parents: [],
    message,
    authorName: 'Forge',
    authorEmail: 'forge@example.invalid',
    authorEpoch: trialNowEpoch(),
  };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      const match = /^author (.*) <(.*)> (\d+) \+0000$/.exec(line);
      if (match !== null) {
        out.authorName = match[1] ?? out.authorName;
        out.authorEmail = match[2] ?? out.authorEmail;
        out.authorEpoch = Number.parseInt(match[3] ?? '0', 10) || out.authorEpoch;
      }
    }
  }
  return out;
}

/** The tree oid of a commit, or null when the commit is unknown. */
function treeOf(store: Store, commitOid: string): string | null {
  const obj = store.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const tree = parseCommit(obj.data).tree;
  return tree === '' ? null : tree;
}

/** Create a forge commit object and return its oid. */
function forgeCommit(store: Store, tree: string, parents: string[], message: string): string {
  const who = `Forge <forge@example.invalid> ${trialNowEpoch()} +0000`;
  const text = message.endsWith('\n') ? message : `${message}\n`;
  return makeCommit(store, { tree, parents, author: who, committer: who, message: text });
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

/** Flat file map (path -> blob oid) of a commit's tree; empty when unknown. */
function flatOf(store: Store, commitOid: string | null): Map<string, string> {
  if (commitOid === null) return new Map<string, string>();
  const tree = treeOf(store, commitOid);
  if (tree === null) return new Map<string, string>();
  const out = new Map<string, string>();
  for (const [path, entry] of flattenTree(store, tree)) out.set(path, entry.oid);
  return out;
}

/** Rebuild a nested tree from a flat file map; returns the root tree oid. */
function buildTreeFromFlat(store: Store, flat: Map<string, string>): string {
  function build(prefix: string): string {
    const entries: Array<{ mode: string; name: string; oid: string }> = [];
    const files: Array<{ name: string; oid: string }> = [];
    const dirs = new Set<string>();
    for (const [path, oid] of flat) {
      if (prefix !== '') {
        if (!path.startsWith(`${prefix}/`)) continue;
      }
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

/** Count lines of a text file (a trailing newline does not make an empty line). */
function lineList(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Bag-diff of two texts: lines added / removed (order-insensitive). */
function diffLines(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of lineList(oldText)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of lineList(newText)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const delta = count - (oldCounts.get(line) ?? 0);
    if (delta > 0) additions += delta;
  }
  for (const [line, count] of oldCounts) {
    const delta = count - (newCounts.get(line) ?? 0);
    if (delta > 0) deletions += delta;
  }
  return { additions, deletions };
}

/** Blob bytes for an oid, or null when the object is not a blob. */
function blobData(store: Store, oid: string): Buffer | null {
  const obj = store.objects.get(oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return obj.data;
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

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

export async function handleRest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  try {
    return await dispatch(req, res, store);
  } catch (err) {
    if (err instanceof BodyError) {
      if (!res.headersSent) sendJson(res, err.status, { message: err.message });
      return true;
    }
    throw err;
  }
}

async function dispatch(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const method = req.method ?? 'GET';
  const segs = pathSegments(req);
  if (segs.length < 2 || segs[0] !== 'api' || segs[1] !== 'v3') return false;

  // GET /api/v3/meta
  if (method === 'GET' && segs.length === 3 && segs[2] === 'meta') {
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET/POST /api/v3/user/repos
  if (segs.length === 4 && segs[2] === 'user' && segs[3] === 'repos') {
    if (method === 'GET') return listUserRepos(req, res, store);
    if (method === 'POST') return createUserRepo(req, res, store);
    return false;
  }

  // /api/v3/repos/{owner}/{name}[...]
  if (segs.length >= 5 && segs[2] === 'repos') {
    const owner = segs[3] as string;
    const name = segs[4] as string;
    const tail = segs.slice(5);

    if (tail.length === 0) {
      if (method === 'GET') return getOneRepo(res, store, owner, name);
      if (method === 'PATCH') return patchRepo(req, res, store, owner, name);
      if (method === 'DELETE') return deleteRepo(res, store, owner, name);
      return false;
    }
    if (tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST') return createRef(req, res, store, owner, name);
      return false;
    }
    if (tail.length === 1 && tail[0] === 'branches') {
      if (method === 'GET') return listBranches(res, store, owner, name);
      return false;
    }
    if (tail.length === 1 && tail[0] === 'commits') {
      if (method === 'GET') return listCommits(req, res, store, owner, name);
      return false;
    }
    if (tail.length >= 1 && tail[0] === 'contents') {
      const filePath = tail.slice(1).join('/');
      if (method === 'PUT') return putContents(req, res, store, owner, name, filePath);
      if (method === 'GET') return getContents(req, res, store, owner, name, filePath);
      if (method === 'DELETE') return deleteContents(req, res, store, owner, name, filePath);
      return false;
    }
    if (tail.length === 1 && tail[0] === 'labels') {
      if (method === 'POST') return createLabel(req, res, store, owner, name);
      return false;
    }
    if (tail.length === 1 && tail[0] === 'issues') {
      if (method === 'GET') return listIssues(req, res, store, owner, name);
      if (method === 'POST') return createIssue(req, res, store, owner, name);
      return false;
    }
    if (tail.length === 2 && tail[0] === 'issues') {
      const n = parseNumber(tail[1] as string);
      if (n === null) {
        notFound(res, 'Issue');
        return true;
      }
      if (method === 'GET') return getIssue(res, store, owner, name, n);
      if (method === 'PATCH') return patchIssue(req, res, store, owner, name, n);
      return false;
    }
    if (tail.length === 3 && tail[0] === 'issues' && tail[2] === 'comments') {
      const n = parseNumber(tail[1] as string);
      if (n === null) {
        notFound(res, 'Issue');
        return true;
      }
      if (method === 'GET') return listComments(res, store, owner, name, n);
      if (method === 'POST') return createComment(req, res, store, owner, name, n);
      return false;
    }
    if (tail.length === 1 && tail[0] === 'pulls') {
      if (method === 'GET') return listPulls(req, res, store, owner, name);
      if (method === 'POST') return createPull(req, res, store, owner, name);
      return false;
    }
    if (tail.length === 2 && tail[0] === 'pulls') {
      const n = parseNumber(tail[1] as string);
      if (n === null) {
        notFound(res, 'Pull request');
        return true;
      }
      if (method === 'GET') return getPull(res, store, owner, name, n);
      return false;
    }
    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'files') {
      const n = parseNumber(tail[1] as string);
      if (n === null) {
        notFound(res, 'Pull request');
        return true;
      }
      if (method === 'GET') return listPullFiles(res, store, owner, name, n);
      return false;
    }
    if (tail.length === 3 && tail[0] === 'pulls' && tail[2] === 'merge') {
      const n = parseNumber(tail[1] as string);
      if (n === null) {
        notFound(res, 'Pull request');
        return true;
      }
      if (method === 'PUT') return mergePull(req, res, store, owner, name, n);
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// /user/repos
// ---------------------------------------------------------------------------

function listUserRepos(req: IncomingMessage, res: ServerResponse, store: Store): boolean {
  const q = parseQuery(req);
  const { page, perPage } = pageParams(q);
  const all = [...store.repos.values()].filter((repo) => repo.owner === VIEWER);
  const slice = paginate(all, page, perPage);
  const hasNext = page * perPage < all.length;
  const headers: Record<string, string> = {};
  if (hasNext) {
    const host = req.headers.host ?? 'localhost';
    const link = linkHeader(`http://${host}/api/v3/user/repos`, page, perPage, true);
    if (link !== null) headers.link = link;
  }
  sendJson(res, 200, slice.map(repoJson), headers);
  return true;
}

async function createUserRepo(req: IncomingMessage, res: ServerResponse, store: Store): Promise<boolean> {
  const body = await readJson(req);
  const name = str(body, 'name');
  if (name === '') {
    sendJson(res, 422, { message: 'Repository name is required' });
    return true;
  }
  if (store.repos.has(`${VIEWER}/${name}`)) {
    sendJson(res, 422, { message: `Repository ${VIEWER}/${name} already exists` });
    return true;
  }
  const repo = createRepo(store, VIEWER, name, str(body, 'description'), body.private === true);
  sendJson(res, 201, repoJson(repo));
  return true;
}

// ---------------------------------------------------------------------------
// Single repo
// ---------------------------------------------------------------------------

function getOneRepo(res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  sendJson(res, 200, repoJson(repo));
  return true;
}

async function patchRepo(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const description = optStr(body, 'description');
  if (description !== undefined) repo.description = description;
  sendJson(res, 200, repoJson(repo));
  return true;
}

function deleteRepo(res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  store.repos.delete(`${repo.owner}/${repo.name}`);
  res.writeHead(204, { 'content-type': 'application/json; charset=utf-8', 'x-github-request-id': requestId() });
  res.end();
  return true;
}

// ---------------------------------------------------------------------------
// Branches, refs, commits
// ---------------------------------------------------------------------------

async function createRef(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const ref = str(body, 'ref');
  const sha = str(body, 'sha');
  if (!/^refs\/(heads|tags)\/.+/.test(ref) || !/^[0-9a-f]{40}$/i.test(sha)) {
    sendJson(res, 422, { message: 'Invalid ref or sha' });
    return true;
  }
  if (repo.refs.has(ref)) {
    sendJson(res, 422, { message: `Reference ${ref} already exists` });
    return true;
  }
  repo.refs.set(ref, sha.toLowerCase());
  sendJson(res, 201, { ref, object: { sha: sha.toLowerCase() } });
  return true;
}

function listBranches(res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const [ref, sha] of repo.refs) {
    if (ref.startsWith('refs/heads/')) {
      out.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
    }
  }
  sendJson(res, 200, out);
  return true;
}

/** Resolve a ?sha= value (branch name, full ref, or commit oid) to a tip oid. */
function resolveRefTip(repo: Repo, value: string | null): string | undefined {
  if (value === null || value === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (value.startsWith('refs/')) return repo.refs.get(value);
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  return repo.refs.get(`refs/heads/${value}`);
}

function listCommits(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const q = parseQuery(req);
  const shaParam = q.get('sha');
  const tip = resolveRefTip(repo, shaParam);
  if (tip === undefined) {
    if (shaParam !== null && shaParam !== '') {
      notFound(res, 'Reference');
      return true;
    }
    sendJson(res, 200, []);
    return true;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const oid of commitAncestors(store, tip)) {
    const obj = store.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parsed = parseCommit(obj.data);
    out.push({
      sha: oid,
      commit: {
        message: parsed.message,
        author: {
          name: parsed.authorName,
          email: parsed.authorEmail,
          date: new Date(parsed.authorEpoch * 1000).toISOString(),
        },
        committer: {
          name: 'Forge',
          email: 'forge@example.invalid',
          date: new Date(parsed.authorEpoch * 1000).toISOString(),
        },
      },
    });
  }
  sendJson(res, 200, out);
  return true;
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

/** The tip commit of a branch, or undefined when the branch has no tip. */
function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

async function putContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  filePath: string,
): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  if (filePath === '') {
    sendJson(res, 422, { message: 'A file path is required' });
    return true;
  }
  const branch = optStr(body, 'branch') ?? repo.defaultBranch;
  const message = str(body, 'message');
  const contentB64 = str(body, 'content');
  const expectedSha = optStr(body, 'sha');
  const tip = branchTip(repo, branch);
  if (tip === undefined) {
    // Unborn repo: the first contents PUT creates the default branch.
    if (repo.refs.size !== 0 || branch !== repo.defaultBranch) {
      notFound(res, 'Branch');
      return true;
    }
    if (expectedSha !== undefined) {
      sendJson(res, 409, { message: 'sha does not match the current blob' });
      return true;
    }
    const bytes = b64decode(contentB64);
    const blobOid = makeBlob(store, bytes);
    const treeOid = writeTreePath(store, null, filePath, blobOid);
    const commitOid = forgeCommit(store, treeOid, [], message);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, commitOid);
    sendJson(res, 201, {
      content: {
        name: filePath.split('/').pop() ?? filePath,
        path: filePath,
        sha: blobOid,
        size: bytes.length,
        encoding: 'base64',
        content: b64encode(bytes),
      },
      commit: { sha: commitOid, message },
    });
    return true;
  }

  const tree = treeOf(store, tip);
  const currentEntry = tree === null ? null : readTreePath(store, tree, filePath);
  const currentBlob = currentEntry === null ? null : currentEntry.oid;
  if (expectedSha !== undefined && expectedSha.toLowerCase() !== (currentBlob ?? '').toLowerCase()) {
    sendJson(res, 409, { message: 'sha does not match the current blob' });
    return true;
  }
  const isCreate = currentBlob === null;
  const bytes = b64decode(contentB64);
  const blobOid = makeBlob(store, bytes);
  const newTree = writeTreePath(store, tree, filePath, blobOid);
  const commitOid = forgeCommit(store, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(res, isCreate ? 201 : 200, {
    content: {
      name: filePath.split('/').pop() ?? filePath,
      path: filePath,
      sha: blobOid,
      size: bytes.length,
      encoding: 'base64',
      content: b64encode(bytes),
    },
    commit: { sha: commitOid, message },
  });
  return true;
}

function getContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  filePath: string,
): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const q = parseQuery(req);
  const branch = q.get('ref') ?? repo.defaultBranch;
  const tip = branchTip(repo, branch);
  if (tip === undefined) {
    notFound(res, 'Reference');
    return true;
  }
  const tree = treeOf(store, tip);
  if (tree === null) {
    notFound(res, 'Content');
    return true;
  }
  if (filePath === '') {
    sendJson(res, 200, listDirEntries(store, tree, ''));
    return true;
  }
  const entry = readTreePath(store, tree, filePath);
  if (entry === null) {
    notFound(res, 'Content');
    return true;
  }
  const oid = entry.oid;
  const obj = store.objects.get(oid);
  if (obj === undefined) {
    notFound(res, 'Content');
    return true;
  }
  if (entry.mode === '40000') {
    sendJson(res, 200, listDirEntries(store, oid, filePath));
    return true;
  }
  if (obj.type !== 'blob') {
    notFound(res, 'Content');
    return true;
  }
  sendJson(res, 200, {
    type: 'file',
    encoding: 'base64',
    content: b64encode(obj.data),
    sha: oid,
    size: obj.data.length,
    name: filePath.split('/').pop() ?? filePath,
    path: filePath,
  });
  return true;
}

/**
 * Immediate children of the directory whose tree is `treeOid`. The flat map
 * from flattenTree is relative to that tree, so `pathPrefix` ('' at the repo
 * root, the directory path otherwise) is prepended to output paths only.
 */
function listDirEntries(store: Store, treeOid: string, pathPrefix: string): Array<Record<string, unknown>> {
  const flat = flattenTree(store, treeOid);
  const children = new Map<string, { type: 'file' | 'dir'; sha: string }>();
  for (const [path, value] of flat) {
    const slash = path.indexOf('/');
    if (slash === -1) {
      children.set(path, { type: 'file', sha: value.oid });
    } else {
      const dir = path.slice(0, slash);
      if (!children.has(dir)) {
        const child = readTreePath(store, treeOid, dir);
        children.set(dir, { type: 'dir', sha: child === null ? '' : child.oid });
      }
    }
  }
  return [...children.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([entryName, entry]) => ({
      type: entry.type,
      name: entryName,
      path: pathPrefix === '' ? entryName : `${pathPrefix}/${entryName}`,
      sha: entry.sha,
    }));
}

async function deleteContents(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  filePath: string,
): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  if (filePath === '') {
    notFound(res, 'Content');
    return true;
  }
  const branch = optStr(body, 'branch') ?? repo.defaultBranch;
  const message = str(body, 'message');
  const expectedSha = optStr(body, 'sha');
  const tip = branchTip(repo, branch);
  if (tip === undefined) {
    notFound(res, 'Content');
    return true;
  }
  const tree = treeOf(store, tip);
  const currentEntry = tree === null ? null : readTreePath(store, tree, filePath);
  const currentBlob = currentEntry === null ? null : currentEntry.oid;
  if (currentBlob === null) {
    notFound(res, 'Content');
    return true;
  }
  if (expectedSha !== undefined && expectedSha.toLowerCase() !== currentBlob.toLowerCase()) {
    sendJson(res, 409, { message: 'sha does not match the current blob' });
    return true;
  }
  const newTree = writeTreePath(store, tree, filePath, null);
  const commitOid = forgeCommit(store, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  sendJson(res, 200, { commit: { sha: commitOid, message } });
  return true;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

async function createLabel(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const labelName = str(body, 'name');
  if (labelName === '') {
    sendJson(res, 422, { message: 'Label name is required' });
    return true;
  }
  const color = str(body, 'color') || 'ededed';
  repo.labels.set(labelName, { name: labelName, color });
  sendJson(res, 201, { name: labelName, color });
  return true;
}

// ---------------------------------------------------------------------------
// Issues + comments
// ---------------------------------------------------------------------------

function findIssue(repo: Repo, n: number): Issue | null {
  for (const issue of repo.issues) {
    if (issue.number === n) return issue;
  }
  return null;
}

async function createIssue(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const labelNames: string[] = [];
  const rawLabels = body.labels;
  if (Array.isArray(rawLabels)) {
    for (const label of rawLabels) {
      if (typeof label === 'string') labelNames.push(label);
    }
  }
  for (const label of labelNames) {
    if (!repo.labels.has(label)) {
      sendJson(res, 422, { message: `Label '${label}' does not exist` });
      return true;
    }
  }
  const number = repo.issueSeq + 1;
  repo.issueSeq = number;
  const issue: Issue = {
    id: gid('issue', `${repo.owner}/${repo.name}`, number),
    number,
    title: str(body, 'title'),
    body: str(body, 'body'),
    state: 'open',
    labels: labelNames,
    comments: [],
    seq: repo.issues.length,
  };
  repo.issues.push(issue);
  sendJson(res, 201, issueJson(repo, issue));
  return true;
}

function listIssues(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const q = parseQuery(req);
  const { page, perPage } = pageParams(q);
  const state = q.get('state') ?? 'open';
  const direction = q.get('direction') ?? 'desc';
  let items = repo.issues;
  if (state === 'open') items = items.filter((issue) => issue.state === 'open');
  else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
  const ordered = direction === 'asc' ? [...items] : [...items].reverse();
  sendJson(res, 200, paginate(ordered, page, perPage).map((issue) => issueJson(repo, issue)));
  return true;
}

function getIssue(res: ServerResponse, store: Store, owner: string, name: string, n: number): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const issue = findIssue(repo, n);
  if (issue === null) {
    notFound(res, 'Issue');
    return true;
  }
  sendJson(res, 200, issueJson(repo, issue));
  return true;
}

async function patchIssue(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  n: number,
): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const issue = findIssue(repo, n);
  if (issue === null) {
    notFound(res, 'Issue');
    return true;
  }
  const state = optStr(body, 'state');
  if (state === 'open' || state === 'closed') issue.state = state;
  const title = optStr(body, 'title');
  if (title !== undefined) issue.title = title;
  const text = optStr(body, 'body');
  if (text !== undefined) issue.body = text;
  sendJson(res, 200, issueJson(repo, issue));
  return true;
}

async function createComment(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  n: number,
): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const issue = findIssue(repo, n);
  if (issue === null) {
    notFound(res, 'Issue');
    return true;
  }
  const id = repo.commentSeq + 1;
  repo.commentSeq = id;
  const comment = { id, gid: gid('comment', `${repo.owner}/${repo.name}`, n, id), body: str(body, 'body') };
  issue.comments.push(comment);
  sendJson(res, 201, { id, body: comment.body, user: { login: repo.owner }, created_at: trialNowIso() });
  return true;
}

function listComments(res: ServerResponse, store: Store, owner: string, name: string, n: number): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const issue = findIssue(repo, n);
  if (issue === null) {
    notFound(res, 'Issue');
    return true;
  }
  sendJson(
    res,
    200,
    issue.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      user: { login: repo.owner },
      created_at: trialNowIso(),
    })),
  );
  return true;
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

function findPull(repo: Repo, n: number): PullRequest | null {
  for (const pr of repo.prs) {
    if (pr.number === n) return pr;
  }
  return null;
}

async function createPull(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): Promise<boolean> {
  const body = await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const headRef = str(body, 'head');
  const baseRef = str(body, 'base');
  const headSha = headRef === '' ? undefined : branchTip(repo, headRef);
  const baseSha = baseRef === '' ? undefined : branchTip(repo, baseRef);
  if (headSha === undefined || baseSha === undefined) {
    sendJson(res, 422, { message: 'Head and base branches must exist' });
    return true;
  }
  const number = repo.prSeq + 1;
  repo.prSeq = number;
  const pr: PullRequest = {
    id: gid('pr', `${repo.owner}/${repo.name}`, number),
    number,
    title: str(body, 'title'),
    body: str(body, 'body'),
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    seq: repo.prs.length,
  };
  repo.prs.push(pr);
  sendJson(res, 201, pullJson(repo, pr));
  return true;
}

function listPulls(req: IncomingMessage, res: ServerResponse, store: Store, owner: string, name: string): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const q = parseQuery(req);
  const { page, perPage } = pageParams(q);
  const state = q.get('state');
  let items = repo.prs;
  if (state === 'all') {
    // all states
  } else if (state === 'closed') {
    items = items.filter((pr) => pr.state === 'closed');
  } else {
    items = items.filter((pr) => pr.state === 'open');
  }
  sendJson(res, 200, paginate(items, page, perPage).map((pr) => pullJson(repo, pr)));
  return true;
}

function getPull(res: ServerResponse, store: Store, owner: string, name: string, n: number): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const pr = findPull(repo, n);
  if (pr === null) {
    notFound(res, 'Pull request');
    return true;
  }
  sendJson(res, 200, pullJson(repo, pr));
  return true;
}

function listPullFiles(res: ServerResponse, store: Store, owner: string, name: string, n: number): boolean {
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const pr = findPull(repo, n);
  if (pr === null) {
    notFound(res, 'Pull request');
    return true;
  }
  const base = mergeBase(store, pr.base.sha, pr.head.sha);
  const baseFlat = flatOf(store, base);
  const headFlat = flatOf(store, pr.head.sha);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  const out: Array<Record<string, unknown>> = [];
  for (const path of [...paths].sort()) {
    const oldOid = baseFlat.get(path);
    const newOid = headFlat.get(path);
    if (oldOid === newOid) continue;
    if (oldOid === undefined) {
      const bytes = blobData(store, newOid as string) ?? Buffer.alloc(0);
      const additions = lineList(bytes.toString('utf8')).length;
      out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (newOid === undefined) {
      const bytes = blobData(store, oldOid) ?? Buffer.alloc(0);
      const deletions = lineList(bytes.toString('utf8')).length;
      out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else {
      const oldBytes = blobData(store, oldOid) ?? Buffer.alloc(0);
      const newBytes = blobData(store, newOid) ?? Buffer.alloc(0);
      const { additions, deletions } = diffLines(oldBytes.toString('utf8'), newBytes.toString('utf8'));
      out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  sendJson(res, 200, out);
  return true;
}

async function mergePull(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  name: string,
  n: number,
): Promise<boolean> {
  // Merge body must be well-formed JSON; the method is always squash here.
  await readJson(req);
  const repo = getRepo(store, owner, name);
  if (repo === null) {
    notFound(res, 'Repository');
    return true;
  }
  const pr = findPull(repo, n);
  if (pr === null) {
    notFound(res, 'Pull request');
    return true;
  }
  if (pr.state !== 'open') {
    sendJson(res, 405, { message: 'Pull request is already closed' });
    return true;
  }
  const baseTip = branchTip(repo, pr.base.ref);
  const headTip = branchTip(repo, pr.head.ref);
  if (baseTip === undefined || headTip === undefined) {
    sendJson(res, 422, { message: 'Head or base branch is missing' });
    return true;
  }
  if (isConflicted(store, baseTip, headTip)) {
    sendJson(res, 405, { message: 'Merge conflict: both branches changed the same file differently' });
    return true;
  }
  // Squash: one commit on the base branch whose tree is the base tree plus
  // the head's changes against the merge base, parented on the base tip.
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
  const message = `${pr.title} (#${pr.number})`;
  const commitOid = forgeCommit(store, treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pr.base.ref}`, commitOid);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergedAt = trialNowIso();
  pr.mergeCommitSha = commitOid;
  sendJson(res, 200, { merged: true, sha: commitOid, message: 'Pull Request successfully merged' });
  return true;
}
