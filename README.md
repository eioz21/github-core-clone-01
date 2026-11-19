# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/eioz21/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/eioz21/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A small, dependency-free forge (Node standard library only) that speaks the
protocols a GitHub client expects:

- **Smart HTTP git** — clone and push over `git-upload-pack` /
  `git-receive-pack`, protocol v0 and v2, shallow and incremental fetch.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merge).
- **GraphQL** (`/api/graphql`) — repositories, issues, pull requests and the
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, plus introspection.
- **MCP** (`POST /mcp`) — JSON-RPC 2.0 Streamable HTTP with
  `server/discover`, `initialize`, and six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

State lives in memory: every process starts with an empty forge.

## Run

```sh
MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

With `MAKEFUN_ENV_URL` set, the process binds an ephemeral port, registers
it with the harness, serves until the harness reports done, and exits 0.
Without it, it listens on `$PORT` (or an ephemeral port) for local use.

## Layout

- `main.ts` — entrypoint and trial lifecycle
- `app.ts` — HTTP server and routing
- `git.ts` — git object model, pkt-line and packfile codec
- `githttp.ts` — smart-HTTP advertisements and fetch/push handlers
- `store.ts` — in-memory repositories, refs, objects, issues and PRs
- `rest.ts` — REST v3 handlers and serializers
- `graphql.ts` — GraphQL parser, executor and schema
- `mcp.ts` — MCP handshake and tools
