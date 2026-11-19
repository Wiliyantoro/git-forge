// store.ts — in-memory store for the git forge.
//
// Owns: viewer-login capture, repo/issue/PR/label records, the content-
// addressed git object store, deterministic global ids and timestamps.
// Pure in-memory state; no I/O, no wall clock, no randomness.
//
// Viewer login: the forge cannot learn the token owner's login from env
// vars, so the first owner login ever seen on a repo that actually exists
// is captured as the viewer (see AUDIT.md §9). Once captured, any other
// owner is a stranger and repo lookups under that owner return undefined
// (callers turn that into 404, never 403).

export type Oid = string; // 40-hex lowercase SHA-1

export const ZERO_OID: Oid = '0000000000000000000000000000000000000000';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export interface IssueComment {
  id: number; // per-repo sequential comment id (>= 1)
  gid: string; // opaque global id
  body: string;
}

export interface Issue {
  id: string; // opaque gid
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number; // insertion sequence (creation order)
}

export interface PullRequest {
  id: string; // opaque gid
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  seq: number; // insertion sequence (creation order)
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string; // 'main'
  refs: Map<string, Oid>; // 'refs/heads/main' -> tip oid
  issues: Issue[];
  prs: PullRequest[];
  labels: Map<string, Label>;
  issueSeq: number;
  prSeq: number;
  commentSeq: number;
  dbId: number; // per-repo integer, starting at 1, insertion order
}

export interface Store {
  viewerLogin: string | null;
  repos: Map<string, Repo>; // key `${owner}/${name}`
  objects: Map<Oid, GitObject>;
  repoDbSeq: number;
}

// The only "now" allowed: MAKEFUN_TRIAL_NOW, else a fixed fallback.
// Never Date.now() / new Date() in anything stored or sent.
export function trialNow(): string {
  const v = process.env.MAKEFUN_TRIAL_NOW;
  return v !== undefined && v.length > 0 ? v : '2025-01-01T00:00:00Z';
}

export function createStore(): Store {
  return { viewerLogin: null, repos: new Map(), objects: new Map(), repoDbSeq: 0 };
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

// Opaque global id: base64url of `kind:part1:part2...`. Never the raw
// number / databaseId, so ids stay opaque and stable across reads.
export function gid(kind: string, ...parts: (string | number)[]): string {
  const raw = [kind, ...parts.map((p) => String(p))].join(':');
  return Buffer.from(raw, 'utf8').toString('base64url');
}

// First-seen viewer capture: sets viewerLogin on the first call, ignores
// later different logins.
export function noteOwner(store: Store, login: string): void {
  if (store.viewerLogin === null) {
    store.viewerLogin = login;
  }
}

// True when the login is the viewer, or when no viewer has been captured
// yet (capture purposes: an unseen owner is provisionally accepted).
export function isViewerOwner(store: Store, login: string): boolean {
  return store.viewerLogin === null || store.viewerLogin === login;
}

// Repo lookup: once a viewer is captured, a stranger owner never resolves
// (callers return 404). Returns undefined when absent or foreign-owned.
export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  if (!isViewerOwner(store, owner)) {
    return undefined;
  }
  return store.repos.get(repoKey(owner, name));
}

export function createRepo(
  store: Store,
  owner: string,
  name: string,
  description: string,
  isPrivate: boolean,
): Repo {
  const repo: Repo = {
    owner,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    refs: new Map(),
    issues: [],
    prs: [],
    labels: new Map(),
    issueSeq: 0,
    prSeq: 0,
    commentSeq: 0,
    dbId: ++store.repoDbSeq,
  };
  store.repos.set(repoKey(owner, name), repo);
  return repo;
}
