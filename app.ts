// app.ts — the forge HTTP server: routing, body reading, auth, and the
// X-GitHub-Request-Id header on every reply.
//   GET  /healthz                                  -> 200 {"status":"ok"}
//   POST /api/graphql                              -> GraphQL (Bearer)
//   POST /mcp                                      -> MCP JSON-RPC (Bearer)
//   /api/v3/*                                      -> REST v3 (Bearer)
//   /{owner}/{repo}.git/info/refs                  -> smart-HTTP advertisement
//   /{owner}/{repo}.git/git-upload-pack            -> fetch / ls-refs
//   /{owner}/{repo}.git/git-receive-pack           -> push

import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { handleReceivePack, handleUploadPackV0, handleUploadPackV2, v0Advertisement, v2Advertisement } from './githttp.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest } from './rest.ts';
import { Store } from './store.ts';

const MAX_BODY = 64 * 1024 * 1024;

export interface ForgeOptions {
  token: string;
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, requestId: string, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  const headers: Record<string, string> = {
    'x-github-request-id': requestId,
    'content-type': 'application/json',
    ...extraHeaders,
  };
  res.writeHead(status, headers);
  res.end(payload);
}

function sendBytes(res: http.ServerResponse, requestId: string, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'x-github-request-id': requestId, 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

export function createServer(store: Store, options: ForgeOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      const method = req.method ?? 'GET';
      const pathname = url.pathname;

      // Health check: no auth, always 200 while the server is up.
      if (pathname === '/healthz' && method === 'GET') {
        sendJson(res, requestId, 200, { status: 'ok' });
        return;
      }

      const isApi = pathname === '/api/graphql' || pathname === '/mcp' || pathname === '/api/v3' || pathname.startsWith('/api/v3/');
      if (isApi) {
        const auth = req.headers.authorization ?? '';
        const expected = options.token === '' ? null : `Bearer ${options.token}`;
        const authorized = expected === null ? auth.startsWith('Bearer ') && auth.length > 7 : auth === expected;
        if (!authorized) {
          sendJson(res, requestId, 401, { message: 'Requires authentication' });
          return;
        }
      }

      // GraphQL
      if (pathname === '/api/graphql' && method === 'POST') {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString('utf8'));
        } catch {
          sendJson(res, requestId, 400, { message: 'Request body must be valid JSON' });
          return;
        }
        const result = handleGraphql(store, parsed);
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // MCP
      if (pathname === '/mcp' && method === 'POST') {
        const raw = await readBody(req);
        const result = handleMcp(store, raw.toString('utf8'));
        if (result.status === 202) {
          res.writeHead(202, { 'x-github-request-id': requestId });
          res.end();
          return;
        }
        sendJson(res, requestId, result.status, result.body);
        return;
      }

      // REST v3
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restPath = pathname.slice('/api/v3'.length);
        const segments = restPath.split('/').filter((segment) => segment !== '');
        let parsed: unknown = undefined;
        if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          const raw = await readBody(req);
          if (raw.length > 0) {
            try {
              parsed = JSON.parse(raw.toString('utf8'));
            } catch {
              sendJson(res, requestId, 400, { message: 'Request body must be valid JSON' });
              return;
            }
          }
        }
        const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
        const reply = handleRest(store, method, segments, url.searchParams, parsed, origin, pathname);
        sendJson(res, requestId, reply.status, reply.body, reply.headers ?? {});
        return;
      }

      // Git smart HTTP
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const action = gitMatch[3]!;
        const repo = store.getRepo(owner, repoName);
        if (repo === undefined) {
          sendJson(res, requestId, 404, { message: 'Not Found' });
          return;
        }
        const gitProtocol = (req.headers['git-protocol'] ?? '') as string;
        const isV2 = gitProtocol.includes('version=2');

        if (action === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service') ?? '';
          if (service === 'git-upload-pack') {
            if (isV2) {
              sendBytes(res, requestId, 200, v2Advertisement(repo), 'application/x-git-upload-pack-advertisement');
            } else {
              sendBytes(res, requestId, 200, v0Advertisement(repo, 'upload'), 'application/x-git-upload-pack-advertisement');
            }
            return;
          }
          if (service === 'git-receive-pack') {
            sendBytes(res, requestId, 200, v0Advertisement(repo, 'receive'), 'application/x-git-receive-pack-advertisement');
            return;
          }
          sendJson(res, requestId, 400, { message: 'Unknown service' });
          return;
        }

        if (action === 'git-upload-pack' && method === 'POST') {
          const raw = await readBody(req);
          try {
            const out = isV2 ? handleUploadPackV2(repo, raw) : handleUploadPackV0(repo, raw);
            sendBytes(res, requestId, 200, out, 'application/x-git-upload-pack-result');
          } catch (error) {
            sendJson(res, requestId, 400, { message: error instanceof Error ? error.message : 'Bad request' });
          }
          return;
        }

        if (action === 'git-receive-pack' && method === 'POST') {
          const raw = await readBody(req);
          try {
            const out = handleReceivePack(store, repo, raw);
            sendBytes(res, requestId, out.status, out.body, 'application/x-git-receive-pack-result');
          } catch (error) {
            sendJson(res, requestId, 400, { message: error instanceof Error ? error.message : 'Bad request' });
          }
          return;
        }

        sendJson(res, requestId, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, requestId, 404, { message: 'Not Found' });
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, requestId, 500, { message: error instanceof Error ? error.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}
