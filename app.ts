// HTTP server + router. One store per server; routing order:
//
//   GET  /healthz                    -> 200 {"ok": true} (no auth)
//   GET  /api/v3  |  /api/v3/         -> 200 API root + x-oauth-scopes (no auth)
//   *    /api/v3/*                   -> Bearer auth, then REST (rest.ts)
//   *    /api/graphql                -> GraphQL (graphql.ts)
//   *    /mcp                        -> MCP (mcp.ts)
//   *    /<owner>/<repo>.git/...     -> git smart HTTP (git.ts)
//   everything else                  -> 404 {"message": "Not Found"}
//
// Every JSON reply carries content-type application/json and a non-empty
// X-GitHub-Request-Id (sendJson in util.ts). Git routes answer with their
// own git content types and bypass sendJson. A handler that throws is
// answered 500 JSON as a last resort; a request never kills the server.
//
// Auth: Bearer token must equal MAKEFUN_SHOP_TOKEN. When that variable is
// unset (local testing) any non-empty Bearer token is accepted, but a
// missing token is never accepted on a non-healthz route.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createStore, noteOwner, type Store } from './store.ts';
import { deriveViewerLogin, sendJson } from './util.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMCP } from './mcp.ts';
import { handleGit } from './git.ts';

/** The request's pathname, or '/' when it does not parse (never throws). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/** Bearer auth for /api/v3: missing or wrong token is unauthorised. */
function authorized(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (expected === '') return true;
  return token === expected;
}

/** `<owner>/<repo>.git/...` split, or null when the path is not a git path. */
function gitPath(path: string): { owner: string; repo: string } | null {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
  if (match === null) return null;
  return { owner: match[1] as string, repo: match[2] as string };
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';
  let path = pathOf(req);
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  // The env's boot probe: no auth.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // The GitHub API root: a 200 with the token's scopes, no auth.
  if (method === 'GET' && path === '/api/v3') {
    sendJson(
      res,
      200,
      { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }

  // REST v3: auth first, then the resource handlers. Capture the owner
  // segment for the store's first-seen viewer login.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const ownerMatch = /^\/api\/v3\/repos\/([^/]+)/.exec(path);
    if (ownerMatch !== null) noteOwner(store, ownerMatch[1] as string);
    const handled = await handleRest(req, res, store);
    if (!handled) sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // GraphQL v4 (its handler owns auth: no token is a 401 there).
  if (path === '/api/graphql') {
    await handleGraphQL(req, res, store);
    return;
  }

  // MCP over streamable HTTP (its handler owns auth on tools/call).
  if (path === '/mcp') {
    await handleMCP(req, res, store);
    return;
  }

  // Git smart HTTP. Capture the owner segment first (first-seen viewer
  // capture for the store), then dispatch; handleGit parses the path itself.
  const git = gitPath(path);
  if (git !== null) {
    noteOwner(store, git.owner);
    await handleGit(req, res, store);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const store: Store = createStore();
  // Seed the viewer login from the deterministic scenario derivation, so the
  // store knows its owner from boot (first-seen capture via noteOwner above
  // agrees with it and stays as a fallback).
  noteOwner(store, deriveViewerLogin());
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleRequest(req, res, store).catch((err: unknown) => {
      try {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      } catch {
        // Nothing left to do: the socket is already gone.
      }
    });
  });
}
