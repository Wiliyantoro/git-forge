// git.ts — smart-HTTP git routes.
//
// handleGit(req, res, store) serves:
//   GET  /:owner/:repo.git/info/refs?service=git-upload-pack|git-receive-pack
//   POST /:owner/:repo.git/git-upload-pack    (v2 when Git-Protocol: version=2, else v0)
//   POST /:owner/:repo.git/git-receive-pack   (v0 only)
// Returns false when the path is not a git path (router should try the
// next handler). Auth is enforced by app.ts before dispatch; this module
// never crashes on a missing token or malformed input.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Oid, Repo, Store } from './store.ts';
import { ZERO_OID, getRepo, noteOwner } from './store.ts';
import { isAncestor, parsePack, putObject } from './gitpack.ts';
import {
  advertiseV0,
  advertiseV2,
  buildFetchV0Response,
  buildFetchV2Response,
  buildLsRefsResponse,
  buildReceivePackReport,
  decodePkts,
  flushPkt,
  parseFetchV0Request,
  parseFetchV2Request,
  parseLsRefsRequest,
  parseReceivePackRequest,
} from './gitproto.ts';
import type { RefResult } from './gitproto.ts';

const CT_AD_UPLOAD = 'application/x-git-upload-pack-advertisement';
const CT_AD_RECEIVE = 'application/x-git-receive-pack-advertisement';
const CT_RES_UPLOAD = 'application/x-git-upload-pack-result';
const CT_RES_RECEIVE = 'application/x-git-receive-pack-result';

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  send(res, status, 'application/json', Buffer.from(JSON.stringify({ message }), 'utf8'));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer | string) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

// Match /:owner/:repo.git/<action>. Returns null when not a git path.
function matchGitPath(pathname: string): { owner: string; repo: string; action: string } | null {
  const parts = pathname.split('/').filter((p) => p.length > 0);
  // [owner, repo.git, info, refs] | [owner, repo.git, git-upload-pack] | [owner, repo.git, git-receive-pack]
  if (parts.length < 3) return null;
  if (!parts[1].endsWith('.git')) return null;
  const owner = parts[0];
  const repo = parts[1].slice(0, -'.git'.length);
  if (owner.length === 0 || repo.length === 0) return null;
  if (parts[2] === 'info' && parts.length === 4 && parts[3] === 'refs') {
    return { owner, repo, action: 'info/refs' };
  }
  if (parts[2] === 'git-upload-pack' && parts.length === 3) {
    return { owner, repo, action: 'git-upload-pack' };
  }
  if (parts[2] === 'git-receive-pack' && parts.length === 3) {
    return { owner, repo, action: 'git-receive-pack' };
  }
  return null;
}

// Resolve the repo for a git path. The owner is captured as the viewer only
// when the repo actually exists under that owner (a stranger probing a
// missing repo must not poison the capture). Unknown or foreign repo -> null.
function resolveRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = getRepo(store, owner, name);
  if (repo === undefined) return null;
  noteOwner(store, owner);
  return repo;
}

async function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
  url: URL,
): Promise<void> {
  const service = url.searchParams.get('service');
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      send(res, 200, CT_AD_UPLOAD, advertiseV2(store, repo));
    } else {
      send(res, 200, CT_AD_UPLOAD, advertiseV0(store, repo, 'git-upload-pack'));
    }
  } else if (service === 'git-receive-pack') {
    send(res, 200, CT_AD_RECEIVE, advertiseV0(store, repo, 'git-receive-pack'));
  } else {
    sendJson(res, 404, 'Not Found');
  }
}

async function handleUploadPack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  try {
    if (wantsV2) {
      const { items } = decodePkts(body);
      const first = items.find((i) => i.kind === 'data');
      const cmd = first !== undefined && first.kind === 'data' ? first.data.toString('utf8').trim() : '';
      if (cmd === 'command=ls-refs') {
        send(res, 200, CT_RES_UPLOAD, buildLsRefsResponse(store, repo, parseLsRefsRequest(body)));
      } else if (cmd === 'command=fetch') {
        send(res, 200, CT_RES_UPLOAD, buildFetchV2Response(store, repo, parseFetchV2Request(body)));
      } else {
        // Malformed v2 request: survive, answer an empty result.
        send(res, 200, CT_RES_UPLOAD, flushPkt());
      }
    } else {
      send(res, 200, CT_RES_UPLOAD, buildFetchV0Response(store, repo, parseFetchV0Request(body)));
    }
  } catch {
    // Malformed input must never kill the server (repo-survives-errors).
    if (!res.headersSent) {
      send(res, 200, CT_RES_UPLOAD, flushPkt());
    } else {
      res.end();
    }
  }
}

async function handleReceivePack(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  repo: Repo,
): Promise<void> {
  const body = await readBody(req);
  let sideband = false;
  try {
    const parsed = parseReceivePackRequest(body);
    sideband = parsed.caps.includes('side-band-64k');
    if (parsed.commands.length === 0) {
      send(res, 200, CT_RES_RECEIVE, buildReceivePackReport([], sideband));
      return;
    }
    // Unpack first: no ref moves when the pack is corrupt. Delete-only
    // pushes carry no pack at all.
    let unpackOk = true;
    if (parsed.pack !== null && parsed.pack.length > 0) {
      try {
        const objects = parsePack(parsed.pack, store);
        for (const o of objects) {
          putObject(store, o.type, o.data);
        }
      } catch {
        unpackOk = false;
      }
    }
    const results: RefResult[] = [];
    if (!unpackOk) {
      for (const cmd of parsed.commands) {
        results.push({ ref: cmd.ref, ok: false, reason: 'unpack failed' });
      }
      send(res, 200, CT_RES_RECEIVE, buildReceivePackReport(results, sideband, false));
      return;
    }
    for (const cmd of parsed.commands) {
      results.push(applyCommand(store, repo, cmd));
    }
    send(res, 200, CT_RES_RECEIVE, buildReceivePackReport(results, sideband, true));
  } catch {
    // Unparseable command list: survive with an empty unpack-ok report.
    if (!res.headersSent) {
      send(res, 200, CT_RES_RECEIVE, buildReceivePackReport([], sideband));
    } else {
      res.end();
    }
  }
}

// Fast-forward-only ref update for one receive-pack command.
function applyCommand(
  store: Store,
  repo: Repo,
  cmd: { oldOid: Oid; newOid: Oid; ref: string },
): RefResult {
  const current = repo.refs.get(cmd.ref);
  if (cmd.newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref: cmd.ref, ok: true };
    if (current !== cmd.oldOid) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    repo.refs.delete(cmd.ref);
    return { ref: cmd.ref, ok: true };
  }
  if (cmd.oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
    if (!store.objects.has(cmd.newOid)) {
      return { ref: cmd.ref, ok: false, reason: 'object not found' };
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    return { ref: cmd.ref, ok: true };
  }
  // Update: old must match the current tip and the new tip must descend
  // from it (fast-forward only).
  if (current === undefined || current !== cmd.oldOid) {
    return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  }
  if (!store.objects.has(cmd.newOid)) {
    return { ref: cmd.ref, ok: false, reason: 'object not found' };
  }
  if (!isAncestor(store, cmd.oldOid, cmd.newOid)) {
    return { ref: cmd.ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(cmd.ref, cmd.newOid);
  return { ref: cmd.ref, ok: true };
}

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
): Promise<boolean> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = matchGitPath(url.pathname);
    if (match === null) return false;
    const repo = resolveRepo(store, match.owner, match.repo);
    if (repo === null) {
      sendJson(res, 404, 'Not Found');
      return true;
    }
    if (req.method === 'GET' && match.action === 'info/refs') {
      await handleInfoRefs(req, res, store, repo, url);
      return true;
    }
    if (req.method === 'POST' && match.action === 'git-upload-pack') {
      await handleUploadPack(req, res, store, repo);
      return true;
    }
    if (req.method === 'POST' && match.action === 'git-receive-pack') {
      await handleReceivePack(req, res, store, repo);
      return true;
    }
    sendJson(res, 404, 'Not Found');
    return true;
  } catch {
    if (!res.headersSent) {
      sendJson(res, 500, 'Internal Server Error');
    } else {
      res.end();
    }
    return true;
  }
}
