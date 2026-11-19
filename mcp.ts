// MCP over streamable HTTP (POST /mcp) for the git forge.
//
// JSON-RPC 2.0, one JSON body per POST (no SSE stream needed: the client
// accepts a plain JSON answer). Modern era first: server/discover answers
// the 2026-07-28 revision with supportedVersions, capabilities and
// serverInfo, no handshake and no session. The legacy initialize handshake
// is also answered, so a pre-discover client can still connect.
//
// Tools (six, canonical github-mcp-server names): create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request.
// Every tool call reads/writes the same in-memory store the REST, GraphQL
// and git layers use, via the shared store helpers in graphql.ts.
//
// Auth: a missing or wrong Bearer token is HTTP 401, decided before any
// tool exists. A malformed JSON body is HTTP 400 + JSON-RPC -32700.
// An unknown tool is JSON-RPC -32601; a tool execution failure (missing
// repo, missing arguments, merge conflict) is isError:true, never a
// JSON-RPC error and never HTTP 500.
//
// Determinism: the tools list is one fixed literal, the session id is a
// constant, ids come from the store. No wall clock, no randomness.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Repo, Store } from './store.ts';
import { createRepo, getRepo } from './store.ts';
import {
  createIssueInStore,
  createPullRequestInStore,
  mergePullRequestInStore,
} from './graphql.ts';
import {
  BodyError,
  deriveViewerLogin,
  isRecord,
  readBody,
  sendJson,
} from './util.ts';

// ---------------------------------------------------------------------------
// Auth (same rule as app.ts; decided before any tool exists)
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

function viewerLoginOf(store: Store): string {
  return store.viewerLogin ?? deriveViewerLogin();
}

// ---------------------------------------------------------------------------
// Tools (one fixed literal: tools/list is byte-identical across calls)
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SESSION_ID = 'mcp-session-1';
const SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) and close it.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool results
// ---------------------------------------------------------------------------

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

function okResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: false };
}

function errResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asStr(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function repoResult(repo: Repo): Record<string, unknown> {
  return {
    id: repo.dbId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner },
  };
}

function requireRepo(store: Store, args: Record<string, unknown>): Repo | null {
  const owner = asStr(args.owner);
  const name = asStr(args.repo);
  if (owner === '' || name === '') return null;
  return getRepo(store, owner, name) ?? null;
}

/** Missing required arguments (by the tool's own schema), or null. */
function missingArgs(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of tool.inputSchema.required) {
    const value = args[key];
    if (value === undefined || value === null || value === '') return key;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return errResult(`Unknown tool: ${name}`);
  const missing = missingArgs(tool, args);
  if (missing !== null) return errResult(`Missing required argument: ${missing}`);

  if (name === 'create_repo') {
    const repoName = asStr(args.name);
    if (repoName === '') return errResult('Missing required argument: name');
    const owner = viewerLoginOf(store);
    const existing = getRepo(store, owner, repoName);
    if (existing !== undefined) return okResult(repoResult(existing));
    const repo = createRepo(
      store,
      owner,
      repoName,
      asStr(args.description),
      args.private === true,
    );
    return okResult(repoResult(repo));
  }

  if (name === 'get_repo') {
    const repo = requireRepo(store, args);
    if (repo === null) return errResult(`Repository not found: ${asStr(args.owner)}/${asStr(args.repo)}`);
    return okResult(repoResult(repo));
  }

  if (name === 'create_issue') {
    const repo = requireRepo(store, args);
    if (repo === null) return errResult(`Repository not found: ${asStr(args.owner)}/${asStr(args.repo)}`);
    const issue = createIssueInStore(store, repo, asStr(args.title), asStr(args.body));
    return okResult({
      id: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      repository: `${repo.owner}/${repo.name}`,
    });
  }

  if (name === 'list_issues') {
    const repo = requireRepo(store, args);
    if (repo === null) return errResult(`Repository not found: ${asStr(args.owner)}/${asStr(args.repo)}`);
    const state = asStr(args.state) === '' ? 'open' : asStr(args.state);
    let items = repo.issues;
    if (state === 'open') items = items.filter((issue) => issue.state === 'open');
    else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
    return okResult(
      items.map((issue) => ({
        id: issue.id,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
      })),
    );
  }

  if (name === 'create_pull_request') {
    const repo = requireRepo(store, args);
    if (repo === null) return errResult(`Repository not found: ${asStr(args.owner)}/${asStr(args.repo)}`);
    const pr = createPullRequestInStore(
      store,
      repo,
      asStr(args.title),
      asStr(args.body),
      asStr(args.head),
      asStr(args.base),
    );
    if (pr === null) return errResult('Head and base branches must exist');
    return okResult({
      id: pr.id,
      number: pr.number,
      pull_number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      head: { ref: pr.head.ref, sha: pr.head.sha },
      base: { ref: pr.base.ref, sha: pr.base.sha },
    });
  }

  if (name === 'merge_pull_request') {
    const repo = requireRepo(store, args);
    if (repo === null) return errResult(`Repository not found: ${asStr(args.owner)}/${asStr(args.repo)}`);
    const number = asNumber(args.pull_number);
    if (number === null) return errResult('Missing required argument: pull_number');
    const pr = repo.prs.find((entry) => entry.number === number);
    if (pr === undefined) return errResult(`Pull request not found: #${number}`);
    const merged = mergePullRequestInStore(store, repo, pr);
    if (!merged.ok) return errResult(merged.reason ?? 'Pull request could not be merged');
    return okResult({
      id: pr.id,
      number: pr.number,
      pull_number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: pr.merged,
      merge_commit_sha: pr.mergeCommitSha,
      merged_at: pr.mergedAt,
    });
  }

  return errResult(`Unknown tool: ${name}`);
}

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(res: ServerResponse, id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result }, extraHeaders);
}

function rpcError(
  res: ServerResponse,
  status: number,
  id: unknown,
  code: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, extraHeaders);
}

const SERVER_INFO = { name: SERVER_NAME, version: SERVER_VERSION };

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: [...SUPPORTED_VERSIONS],
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    instructions: 'GitHub-compatible git forge MCP server.',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function initializeResult(offered: unknown): Record<string, unknown> {
  const offeredStr = typeof offered === 'string' ? offered : '';
  const protocolVersion = (SUPPORTED_VERSIONS as readonly string[]).includes(offeredStr)
    ? offeredStr
    : '2025-11-25';
  return {
    protocolVersion,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
  };
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

export async function handleMCP(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const method = req.method ?? 'GET';

  // Legacy session close: best-effort DELETE, always fine.
  if (method === 'DELETE') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof BodyError) {
      sendJson(res, err.status, { message: err.message });
      return;
    }
    throw err;
  }

  // Parse error: HTTP 400 + JSON-RPC -32700 (the body carries no usable id).
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }

  // Auth is decided before any method or tool exists.
  if (!authorized(req)) {
    const id = isRecord(parsed) && 'id' in parsed ? parsed.id : null;
    rpcError(res, 401, id, -32001, 'Unauthorized');
    return;
  }

  if (!isRecord(parsed)) {
    // A JSON array (batch) or a bare value is not a request object.
    rpcError(res, 200, null, -32600, 'Invalid Request');
    return;
  }

  const id = 'id' in parsed ? parsed.id : null;
  const hasId = 'id' in parsed && parsed.id !== undefined && parsed.id !== null;
  const rpcMethod = typeof parsed.method === 'string' ? parsed.method : '';
  const params = isRecord(parsed.params) ? (parsed.params as Record<string, unknown>) : {};

  // Notifications carry no id and get no JSON-RPC response.
  if (!hasId) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  if (rpcMethod === '') {
    rpcError(res, 200, id, -32600, 'Invalid Request: missing method');
    return;
  }

  if (rpcMethod === 'server/discover') {
    rpcResult(res, id, discoverResult());
    return;
  }

  if (rpcMethod === 'initialize') {
    rpcResult(res, id, initializeResult(params.protocolVersion), { 'mcp-session-id': SESSION_ID });
    return;
  }

  if (rpcMethod === 'ping') {
    rpcResult(res, id, {});
    return;
  }

  if (rpcMethod === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }

  if (rpcMethod === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : null;
    if (toolName === '') {
      rpcError(res, 200, id, -32602, 'Invalid params: tools/call requires a tool name');
      return;
    }
    if (args === null) {
      rpcError(res, 200, id, -32602, 'Invalid params: tools/call requires arguments');
      return;
    }
    if (TOOLS.find((entry) => entry.name === toolName) === undefined) {
      rpcError(res, 200, id, -32601, `Method not found: unknown tool ${toolName}`);
      return;
    }
    rpcResult(res, id, callTool(store, toolName, args));
    return;
  }

  rpcError(res, 200, id, -32601, `Method not found: ${rpcMethod}`);
}
