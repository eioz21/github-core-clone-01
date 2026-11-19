// mcp.ts — Model Context Protocol over Streamable HTTP (POST /mcp, JSON-RPC 2.0).
// Supports the modern 2026-07-28 era via `server/discover` and the legacy
// `initialize` handshake, plus exactly the six tools the suite requires, all
// acting on the same store as REST and GraphQL.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Store } from './store.ts';
import { VIEWER_LOGIN, nowIso } from './store.ts';

export interface McpReply {
  status: number;
  body: unknown;
}

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';

const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
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
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(content: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof content === 'string' ? content : JSON.stringify(content, null, 2) }],
    structuredContent: typeof content === 'object' && content !== null ? content : { value: content },
    isError,
  };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function repoOf(store: Store, args: Record<string, unknown>): { owner: string; name: string; repo: NonNullable<ReturnType<Store['getRepo']>> } | { error: string } {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  if (owner === '' || name === '') return { error: 'owner and repo are required' };
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
  if (repo === undefined) return { error: `Repository ${owner}/${name} not found` };
  return { owner, name, repo };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'create_repo') {
    const repoName = typeof args.name === 'string' ? args.name : '';
    if (repoName === '') return toolError('name is required');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    const repo = store.createRepo(VIEWER_LOGIN, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return toolResult(repoJson(repo));
  }

  if (name === 'get_repo') {
    const found = repoOf(store, args);
    if ('error' in found) return toolError(found.error);
    return toolResult(repoJson(found.repo));
  }

  if (name === 'create_issue') {
    const found = repoOf(store, args);
    if ('error' in found) return toolError(found.error);
    const title = typeof args.title === 'string' ? args.title : '';
    if (title === '') return toolError('title is required');
    const stamp = nowIso();
    const issue = {
      id: store.nextIssueId++,
      number: found.repo.nextIssue++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      labels: [],
      comments: [],
      user: VIEWER_LOGIN,
      created_at: stamp,
      updated_at: stamp,
      closed_at: null as string | null,
      seq: store.seqCounter++,
    };
    found.repo.issues.push(issue);
    return toolResult(issueJson(found.repo, issue));
  }

  if (name === 'list_issues') {
    const found = repoOf(store, args);
    if ('error' in found) return toolError(found.error);
    const state = typeof args.state === 'string' ? args.state : 'open';
    let list = [...found.repo.issues];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    list.sort((a, b) => b.seq - a.seq);
    const issues = list.map((issue) => issueJson(found.repo, issue));
    return toolResult({ issues });
  }

  if (name === 'create_pull_request') {
    const found = repoOf(store, args);
    if ('error' in found) return toolError(found.error);
    const title = typeof args.title === 'string' ? args.title : '';
    const head = typeof args.head === 'string' ? args.head : '';
    const base = typeof args.base === 'string' ? args.base : '';
    if (title === '' || head === '' || base === '') return toolError('title, head and base are required');
    const headSha = found.repo.refs.get(`refs/heads/${head}`);
    const baseSha = found.repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return toolError(`head branch '${head}' does not exist`);
    if (baseSha === undefined) return toolError(`base branch '${base}' does not exist`);
    const existing = found.repo.pulls.find((pr) => pr.head.ref === head && pr.base.ref === base && pr.state === 'open');
    if (existing !== undefined) return toolError('A pull request already exists for this head and base');
    const stamp = nowIso();
    const pr = {
      id: store.nextPullId++,
      number: found.repo.nextPull++,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open' as const,
      merged: false,
      merged_at: null as string | null,
      merge_commit_sha: null as string | null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      user: VIEWER_LOGIN,
      created_at: stamp,
      updated_at: stamp,
      closed_at: null as string | null,
      seq: store.seqCounter++,
    };
    found.repo.pulls.push(pr);
    return toolResult(pullJson(store, found.repo, pr));
  }

  if (name === 'merge_pull_request') {
    const found = repoOf(store, args);
    if ('error' in found) return toolError(found.error);
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : parseInt(String(args.pull_number ?? ''), 10);
    if (!Number.isFinite(pullNumber)) return toolError('pull_number is required');
    const pr = found.repo.pulls.find((entry) => entry.number === pullNumber);
    if (pr === undefined) return toolError(`Pull request #${pullNumber} not found`);
    if (pr.merged || pr.state !== 'open') return toolError('Pull request is already merged or closed');
    const baseTip = found.repo.refs.get(`refs/heads/${pr.base.ref}`);
    const headTip = found.repo.refs.get(`refs/heads/${pr.head.ref}`);
    if (baseTip === undefined || headTip === undefined || store.mergeConflicts(found.repo, baseTip, headTip)) {
      return toolError('Merge conflict');
    }
    const sha = store.squashMerge(found.repo, pr, `Merge pull request #${pr.number} from ${pr.head.ref}`);
    if (sha === null) return toolError('Merge conflict');
    pr.merged = true;
    pr.state = 'closed';
    pr.merged_at = nowIso();
    pr.merge_commit_sha = sha;
    pr.closed_at = pr.merged_at;
    pr.updated_at = pr.merged_at;
    return toolResult({ ...pullJson(store, found.repo, pr), sha, merged: true });
  }

  return toolError(`Unknown tool '${name}'`);
}

function handleRequest(store: Store, request: unknown): McpReply {
  const record = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>;
  const id = 'id' in record ? record.id : null;
  const method = typeof record.method === 'string' ? record.method : '';
  const params = (typeof record.params === 'object' && record.params !== null ? record.params : {}) as Record<string, unknown>;

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
    if (toolName === '') return rpcError(id, -32602, 'Tool name is required');
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) return rpcError(id, -32602, `Unknown tool '${toolName}'`);
    const required = (TOOLS.find((tool) => tool.name === toolName)!.inputSchema as { required?: string[] }).required ?? [];
    const missing = required.filter((prop) => args[prop] === undefined || args[prop] === null || args[prop] === '');
    if (missing.length > 0) return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    const result = callTool(store, toolName, args);
    return rpcResult(id, result);
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function handleMcp(store: Store, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies = parsed.map((entry) => handleRequest(store, entry));
    return { status: 200, body: replies.map((reply) => reply.body) };
  }
  return handleRequest(store, parsed);
}
