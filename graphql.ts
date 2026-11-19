// graphql.ts — a hand-written GraphQL subset (parser + executor) for the forge.
// Supports: query/mutation operations, $variables, aliases, inline fragments,
// input objects, enums, lists, batch arrays, and the introspection surface the
// conformance suite needs (__type / __schema). Unknown fields yield a GraphQL
// error (HTTP 200) naming the field; unknown repositories yield data.repository
// null with no errors.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, nowIso } from './store.ts';
import { globalCommentId, globalIssueId, globalPullId, globalRepoId, repoFilesDiff } from './rest.ts';

// ------------------------------------------------------------ tokenizer

type TokKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token { kind: TokKind; value: string }

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') { i += 1; continue; }
    if (c === '#') { while (i < input.length && input[i] !== '\n') i += 1; continue; }
    if (input.startsWith('...', i)) { tokens.push({ kind: 'spread', value: '...' }); i += 3; continue; }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        if (end === -1) throw new Error('Unterminated block string');
        tokens.push({ kind: 'string', value: input.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1]!;
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') { out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16)); j += 6; }
          else { out += map[esc] ?? esc; j += 2; }
        } else { out += input[j]; j += 1; }
      }
      if (j >= input.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i + 1;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.') { isFloat = true; j += 1; while (j < input.length && /[0-9]/.test(input[j]!)) j += 1; }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true; j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if ('{}():$!=@[]|&'.includes(c)) { tokens.push({ kind: 'punct', value: c }); i += 1; continue; }
    throw new Error(`Unexpected character '${c}'`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ------------------------------------------------------------ parser

export interface Selection {
  name: string;
  alias: string | null;
  args: Record<string, unknown>;
  selections: Selection[] | null;
  fragmentType: string | null;
}

interface Operation { kind: 'query' | 'mutation'; name: string | null; selections: Selection[] }

interface GqlValue { __var?: string; __enum?: string }

function valueFromToken(token: Token): unknown {
  if (token.kind === 'int' || token.kind === 'float') return Number(token.value);
  if (token.kind === 'string') return token.value;
  if (token.kind === 'name') {
    if (token.value === 'true') return true;
    if (token.value === 'false') return false;
    if (token.value === 'null') return null;
    return { __enum: token.value } as GqlValue;
  }
  throw new Error(`Unexpected token ${token.value}`);
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token { return this.tokens[this.pos]!; }
  private next(): Token { return this.tokens[this.pos++]!; }
  private expect(value: string): Token {
    const token = this.next();
    if (token.value !== value) throw new Error(`Expected '${value}' but got '${token.value}'`);
    return token;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`Expected name but got '${token.value}'`);
    return token.value;
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ kind: 'query', name: null, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.skipVariableDefinitions();
        operations.push({ kind: token.value as 'query' | 'mutation', name, selections: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        throw new Error('Named fragments are not supported');
      } else {
        throw new Error(`Unexpected token '${token.value}' in document`);
      }
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
      if (token.kind === 'eof') throw new Error('Unterminated variable definitions');
    }
  }

  parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'eof') throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): Selection {
    if (this.peek().kind === 'spread') {
      this.next();
      let fragmentType: string | null = null;
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        fragmentType = this.expectName();
      }
      const selections = this.parseSelectionSet();
      return { name: '__fragment', alias: null, args: {}, selections, fragmentType };
    }
    const first = this.expectName();
    let name = first;
    let alias: string | null = null;
    if (this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Record<string, unknown> = {};
    if (this.peek().value === '(') {
      this.next();
      while (this.peek().value !== ')') {
        const argName = this.expectName();
        this.expect(':');
        args[argName] = this.parseValue();
      }
      this.expect(')');
    }
    while (this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().value === '(') this.skipVariableDefinitions();
    }
    let selections: Selection[] | null = null;
    if (this.peek().value === '{') selections = this.parseSelectionSet();
    return { name, alias, args, selections, fragmentType: null };
  }

  private parseValue(): unknown {
    const token = this.peek();
    if (token.value === '$') {
      this.next();
      return { __var: this.expectName() } as GqlValue;
    }
    if (token.value === '[') {
      this.next();
      const list: unknown[] = [];
      while (this.peek().value !== ']') list.push(this.parseValue());
      this.expect(']');
      return list;
    }
    if (token.value === '{') {
      this.next();
      const object: Record<string, unknown> = {};
      while (this.peek().value !== '}') {
        const key = this.expectName();
        this.expect(':');
        object[key] = this.parseValue();
      }
      this.expect('}');
      return object;
    }
    this.next();
    return valueFromToken(token);
  }
}

// ------------------------------------------------------------ schema surface

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'createdAt', 'url'],
  User: ['id', 'databaseId', 'login', 'name', 'email'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  PullRequestConnection: ['nodes', 'totalCount', 'pageInfo', 'edges'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'totalCount', 'pageInfo'],
  FileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  File: ['path'],
  IssueComment: ['id', 'body'],
  IssueCommentEdge: ['node'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'ofType', 'interfaces', 'possibleTypes'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
  __InputValue: ['name', 'description', 'type'],
};

const TYPE_KIND: Record<string, string> = {
  Query: 'OBJECT', Mutation: 'OBJECT', Repository: 'OBJECT', Issue: 'OBJECT',
  PullRequest: 'OBJECT', User: 'OBJECT', Ref: 'OBJECT', IssueConnection: 'OBJECT',
  PullRequestConnection: 'OBJECT', FileConnection: 'OBJECT', PageInfo: 'OBJECT',
  File: 'OBJECT', IssueComment: 'OBJECT', IssueCommentEdge: 'OBJECT',
  CreateIssuePayload: 'OBJECT', CloseIssuePayload: 'OBJECT', CreatePullRequestPayload: 'OBJECT',
  MergePullRequestPayload: 'OBJECT', AddCommentPayload: 'OBJECT',
  String: 'SCALAR', Int: 'SCALAR', Boolean: 'SCALAR', ID: 'SCALAR',
  SearchType: 'ENUM', IssueState: 'ENUM', PullRequestState: 'ENUM', MergeableState: 'ENUM',
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'ORGANIZATION', 'PACKAGE', 'PROJECT', 'WIKI', 'RELEASE', 'TOPIC', 'PULL_REQUEST'];

// ------------------------------------------------------------ execution

interface Ctx {
  store: Store;
  vars: Record<string, unknown>;
  errors: { message: string; path?: (string | number)[] }[];
}

type GqlObj = Record<string, unknown> & { __typename: string };

function resolveValue(value: unknown, ctx: Ctx): unknown {
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, ctx));
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.__var === 'string') return ctx.vars[record.__var] ?? null;
    if (typeof record.__enum === 'string') return record.__enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(record)) out[key] = resolveValue(entry, ctx);
    return out;
  }
  return value;
}

function arg<T>(args: Record<string, unknown>, name: string, ctx: Ctx): T | undefined {
  if (!(name in args)) return undefined;
  return resolveValue(args[name], ctx) as T;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(after: string | null | undefined): number | null {
  if (typeof after !== 'string' || after === '') return null;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? parseInt(match[1]!, 10) : null;
  } catch {
    return null;
  }
}

function pageInfoFor<T extends { number: number }>(page: T[], hasNext: boolean): GqlObj {
  return {
    __typename: 'PageInfo',
    hasNextPage: hasNext,
    hasPreviousPage: false,
    startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
  };
}

function viewerObj(): GqlObj {
  return { __typename: 'User', login: VIEWER_LOGIN, id: String(VIEWER_ID), databaseId: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoObj(store: Store, repo: Repo): GqlObj {
  return {
    __typename: 'Repository',
    id: globalRepoId(repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: viewerObj(),
    defaultBranchRef: { __typename: 'Ref', name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    _repo: repo,
    _store: store,
  };
}

function issueObj(store: Store, repo: Repo, issue: Issue): GqlObj {
  return {
    __typename: 'Issue',
    id: globalIssueId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    author: viewerObj(),
    _repo: repo,
    _issue: issue,
    _store: store,
  };
}

function prObj(store: Store, repo: Repo, pr: PullRequest): GqlObj {
  return {
    __typename: 'PullRequest',
    id: globalPullId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.head.ref,
    baseRefName: pr.base.ref,
    createdAt: pr.created_at,
    url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pr.number}`,
    _repo: repo,
    _pr: pr,
    _store: store,
  };
}

function mergeableOf(store: Store, repo: Repo, pr: PullRequest): string {
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  return store.mergeConflicts(repo, baseTip, headTip) ? 'CONFLICTING' : 'MERGEABLE';
}

function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number; commentId: number } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const repoMatch = /^repo:([^/]+)\/([^:]+)$/.exec(decoded);
    if (repoMatch) return { kind: 'repo', owner: repoMatch[1]!, name: repoMatch[2]!, number: 0, commentId: 0 };
    const issueMatch = /^issue:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
    if (issueMatch) return { kind: 'issue', owner: issueMatch[1]!, name: issueMatch[2]!, number: parseInt(issueMatch[3]!, 10), commentId: 0 };
    const prMatch = /^pr:([^/]+)\/([^:]+):(\d+)$/.exec(decoded);
    if (prMatch) return { kind: 'pr', owner: prMatch[1]!, name: prMatch[2]!, number: parseInt(prMatch[3]!, 10), commentId: 0 };
    const commentMatch = /^comment:([^/]+)\/([^:]+):(\d+):(\d+)$/.exec(decoded);
    if (commentMatch) return { kind: 'comment', owner: commentMatch[1]!, name: commentMatch[2]!, number: parseInt(commentMatch[3]!, 10), commentId: parseInt(commentMatch[4]!, 10) };
    return null;
  } catch {
    return null;
  }
}

function typeObject(name: string): GqlObj | null {
  const kind = TYPE_KIND[name];
  if (kind === undefined && name !== 'SearchType') return null;
  const fields = TYPE_FIELDS[name] ?? [];
  return {
    __typename: '__Type',
    name,
    kind: kind ?? 'OBJECT',
    description: null,
    fields: fields.map((field) => ({ __typename: '__Field', name: field, description: null, args: [], type: { __typename: '__Type', name: 'String', kind: 'SCALAR' } })),
    enumValues: name === 'SearchType' ? SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value, description: null })) : null,
    inputFields: null,
    ofType: null,
    interfaces: [],
    possibleTypes: null,
  };
}

// ------------------------------------------------------------ field resolution

function resolveField(typeName: string, parent: GqlObj | null, sel: Selection, ctx: Ctx, path: (string | number)[]): unknown {
  const name = sel.name;
  const responseKey = sel.alias ?? sel.name;
  const fieldPath = [...path, responseKey];

  if (name === '__typename') return typeName;

  const allowed = TYPE_FIELDS[typeName];
  if (allowed === undefined || !allowed.includes(name)) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".`, path: fieldPath });
    return null;
  }

  const store = ctx.store;

  // Query root
  if (typeName === 'Query') {
    if (name === 'viewer') return viewerObj();
    if (name === 'repository') {
      const owner = arg<string>(sel.args, 'owner', ctx);
      const repoName = arg<string>(sel.args, 'name', ctx);
      if (owner === undefined || repoName === undefined) return null;
      const repo = store.getRepo(owner, repoName);
      return repo === undefined ? null : repoObj(store, repo);
    }
    if (name === 'node') {
      const id = arg<string>(sel.args, 'id', ctx);
      if (id === undefined) return null;
      const decoded = decodeGlobalId(id);
      if (decoded === null) return null;
      const repo = store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      if (decoded.kind === 'repo') return repoObj(store, repo);
      if (decoded.kind === 'issue') {
        const issue = repo.issues.find((entry) => entry.number === decoded.number);
        return issue === undefined ? null : issueObj(store, repo, issue);
      }
      if (decoded.kind === 'pr') {
        const pr = repo.pulls.find((entry) => entry.number === decoded.number);
        return pr === undefined ? null : prObj(store, repo, pr);
      }
      return null;
    }
    if (name === '__type') {
      const typeNameArg = arg<string>(sel.args, 'name', ctx);
      return typeNameArg === undefined ? null : typeObject(typeNameArg);
    }
    if (name === '__schema') {
      return {
        __typename: '__Schema',
        types: Object.keys(TYPE_FIELDS).map((type) => typeObject(type)).filter((entry): entry is GqlObj => entry !== null),
        queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
        mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
      };
    }
  }

  // Repository
  if (typeName === 'Repository') {
    const repo = parent!._repo as Repo;
    if (name === 'issue') {
      const number = arg<number>(sel.args, 'number', ctx);
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue === undefined ? null : issueObj(store, repo, issue);
    }
    if (name === 'issues') {
      const states = arg<string[]>(sel.args, 'states', ctx);
      const orderBy = arg<{ field?: string; direction?: string }>(sel.args, 'orderBy', ctx);
      const first = arg<number>(sel.args, 'first', ctx);
      const after = arg<string>(sel.args, 'after', ctx);
      let list = [...repo.issues];
      if (states !== undefined && states.length > 0) {
        const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      const direction = orderBy?.direction ?? 'DESC';
      list.sort((a, b) => (direction === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
      const afterNumber = cursorNumber(after);
      if (afterNumber !== null) {
        const index = list.findIndex((issue) => issue.number === afterNumber);
        if (index !== -1) list = list.slice(index + 1);
      }
      const take = first ?? list.length;
      const page = list.slice(0, take);
      const hasNext = list.length > take;
      return {
        __typename: 'IssueConnection',
        nodes: page.map((issue) => issueObj(store, repo, issue)),
        totalCount: repo.issues.length,
        pageInfo: pageInfoFor(page, hasNext),
        edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueObj(store, repo, issue), cursor: cursorFor(issue.number) })),
      };
    }
    if (name === 'pullRequests') {
      const first = arg<number>(sel.args, 'first', ctx);
      const after = arg<string>(sel.args, 'after', ctx);
      let list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      const afterNumber = cursorNumber(after);
      if (afterNumber !== null) {
        const index = list.findIndex((pr) => pr.number === afterNumber);
        if (index !== -1) list = list.slice(index + 1);
      }
      const take = first ?? list.length;
      const page = list.slice(0, take);
      const hasNext = list.length > take;
      return {
        __typename: 'PullRequestConnection',
        nodes: page.map((pr) => prObj(store, repo, pr)),
        totalCount: repo.pulls.length,
        pageInfo: pageInfoFor(page, hasNext),
        edges: page.map((pr) => ({ __typename: 'PullRequestEdge', node: prObj(store, repo, pr), cursor: cursorFor(pr.number) })),
      };
    }
    if (name === 'pullRequest') {
      const number = arg<number>(sel.args, 'number', ctx);
      const pr = repo.pulls.find((entry) => entry.number === number);
      return pr === undefined ? null : prObj(store, repo, pr);
    }
    // scalar fields fall through to the raw value below
  }

  // PullRequest
  if (typeName === 'PullRequest') {
    const repo = parent!._repo as Repo;
    const pr = parent!._pr as PullRequest;
    if (name === 'mergeable') return mergeableOf(store, repo, pr);
    if (name === 'files') {
      const first = arg<number>(sel.args, 'first', ctx);
      const files = repoFilesDiff(store, repo, pr);
      const take = first ?? files.length;
      const page = files.slice(0, take);
      return {
        __typename: 'FileConnection',
        nodes: page.map((file) => ({ __typename: 'File', path: file.filename })),
        totalCount: files.length,
        pageInfo: { __typename: 'PageInfo', hasNextPage: files.length > take, hasPreviousPage: false, startCursor: null, endCursor: null },
      };
    }
  }

  // Issue
  if (typeName === 'Issue') {
    if (name === 'comments') {
      const issue = parent!._issue as Issue;
      const first = arg<number>(sel.args, 'first', ctx);
      const nodes = issue.comments.slice(0, first ?? issue.comments.length).map((comment) => ({
        __typename: 'IssueComment',
        id: globalCommentId((parent!._repo as Repo).owner, (parent!._repo as Repo).name, issue.number, comment.id),
        body: comment.body,
      }));
      return { __typename: 'IssueCommentConnection', nodes, totalCount: issue.comments.length, pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
    }
  }

  // Mutations
  if (typeName === 'Mutation') {
    return resolveMutation(name, sel, ctx, path);
  }

  // Plain scalar / object fields already present on the internal object.
  const value = parent === null ? undefined : parent[name];
  return value === undefined ? null : value;
}

function resolveMutation(name: string, sel: Selection, ctx: Ctx, path: (string | number)[]): unknown {
  const store = ctx.store;
  const input = (arg<Record<string, unknown>>(sel.args, 'input', ctx) ?? {}) as Record<string, unknown>;
  const fieldPath = [...path, sel.alias ?? sel.name];

  if (name === 'createIssue') {
    const repositoryId = String(input.repositoryId ?? '');
    const decoded = decodeGlobalId(repositoryId);
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found.', path: fieldPath });
      return null;
    }
    const title = String(input.title ?? '');
    if (title === '') {
      ctx.errors.push({ message: 'title is required.', path: fieldPath });
      return null;
    }
    const stamp = nowIso();
    const issue: Issue = {
      id: store.nextIssueId++,
      number: repo.nextIssue++,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      user: VIEWER_LOGIN,
      created_at: stamp,
      updated_at: stamp,
      closed_at: null,
      seq: store.seqCounter++,
    };
    repo.issues.push(issue);
    return { __typename: 'CreateIssuePayload', issue: issueObj(store, repo, issue) };
  }

  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(String(input.issueId ?? ''));
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded!.number);
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'Issue not found.', path: fieldPath });
      return null;
    }
    issue.state = 'closed';
    issue.closed_at = nowIso();
    issue.updated_at = issue.closed_at;
    return { __typename: 'CloseIssuePayload', issue: issueObj(store, repo, issue) };
  }

  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) {
      ctx.errors.push({ message: 'Repository not found.', path: fieldPath });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: 'head or base branch does not exist.', path: fieldPath });
      return null;
    }
    const existing = repo.pulls.find((pr) => pr.head.ref === head && pr.base.ref === base && pr.state === 'open');
    if (existing !== undefined) {
      ctx.errors.push({ message: 'A pull request already exists for this head and base.', path: fieldPath });
      return null;
    }
    const stamp = nowIso();
    const pr: PullRequest = {
      id: store.nextPullId++,
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      head: { ref: head, sha: headSha },
      base: { ref: base, sha: baseSha },
      user: VIEWER_LOGIN,
      created_at: stamp,
      updated_at: stamp,
      closed_at: null,
      seq: store.seqCounter++,
    };
    repo.pulls.push(pr);
    return { __typename: 'CreatePullRequestPayload', pullRequest: prObj(store, repo, pr) };
  }

  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const pr = repo?.pulls.find((entry) => entry.number === decoded!.number);
    if (repo === undefined || pr === undefined) {
      ctx.errors.push({ message: 'Pull request not found.', path: fieldPath });
      return null;
    }
    if (pr.merged || pr.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is already merged or closed.', path: fieldPath });
      return null;
    }
    const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
    if (baseTip === undefined || headTip === undefined || store.mergeConflicts(repo, baseTip, headTip)) {
      ctx.errors.push({ message: 'Merge conflict.', path: fieldPath });
      return null;
    }
    const sha = store.squashMerge(repo, pr, `Merge pull request #${pr.number} from ${pr.head.ref}`);
    if (sha === null) {
      ctx.errors.push({ message: 'Merge conflict.', path: fieldPath });
      return null;
    }
    pr.merged = true;
    pr.state = 'closed';
    pr.merged_at = nowIso();
    pr.merge_commit_sha = sha;
    pr.closed_at = pr.merged_at;
    pr.updated_at = pr.merged_at;
    return { __typename: 'MergePullRequestPayload', pullRequest: prObj(store, repo, pr) };
  }

  if (name === 'addComment') {
    const decoded = decodeGlobalId(String(input.subjectId ?? ''));
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded!.number);
    if (repo === undefined || issue === undefined || decoded!.kind !== 'issue') {
      ctx.errors.push({ message: 'Subject not found.', path: fieldPath });
      return null;
    }
    const body = String(input.body ?? '');
    const stamp = nowIso();
    const comment = { id: store.nextCommentId++, body, user: VIEWER_LOGIN, created_at: stamp, updated_at: stamp };
    issue.comments.push(comment);
    return {
      __typename: 'AddCommentPayload',
      commentEdge: {
        __typename: 'IssueCommentEdge',
        node: { __typename: 'IssueComment', id: globalCommentId(repo.owner, repo.name, issue.number, comment.id), body },
      },
    };
  }

  ctx.errors.push({ message: `Unknown mutation "${name}".`, path: fieldPath });
  return null;
}

// ------------------------------------------------------------ selection execution

function executeSelections(typeName: string, value: GqlObj, selections: Selection[], ctx: Ctx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.name === '__fragment') {
      if (sel.fragmentType !== null && sel.fragmentType !== typeName) continue;
      const nested = executeSelections(typeName, value, sel.selections ?? [], ctx, path);
      Object.assign(out, nested);
      continue;
    }
    const responseKey = sel.alias ?? sel.name;
    const resolved = resolveField(typeName, value, sel, ctx, path);
    out[responseKey] = executeValue(resolved, sel, ctx, [...path, responseKey]);
  }
  return out;
}

function executeValue(resolved: unknown, sel: Selection, ctx: Ctx, path: (string | number)[]): unknown {
  if (sel.selections === null) return resolved;
  if (resolved === null || resolved === undefined) return null;
  if (Array.isArray(resolved)) {
    return resolved.map((item, index) => {
      if (item === null || typeof item !== 'object') return item;
      return executeSelections((item as GqlObj).__typename, item as GqlObj, sel.selections!, ctx, [...path, index]);
    });
  }
  if (typeof resolved === 'object') {
    return executeSelections((resolved as GqlObj).__typename, resolved as GqlObj, sel.selections, ctx, path);
  }
  return resolved;
}

function executeOperation(store: Store, operation: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: Ctx = { store, vars: variables, errors: [] };
  const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, { __typename: rootType } as GqlObj, operation.selections, ctx, []);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

// ------------------------------------------------------------ entry point

export function handleGraphql(store: Store, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeSingle(store, entry)) };
  }
  return { status: 200, body: executeSingle(store, body) };
}

function executeSingle(store: Store, entry: unknown): Record<string, unknown> {
  const record = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  if (query === '') return { data: null, errors: [{ message: 'Must provide query string.' }] };
  let variables: Record<string, unknown> = {};
  if (typeof record.variables === 'object' && record.variables !== null) variables = record.variables as Record<string, unknown>;
  else if (typeof record.variables === 'string') {
    try { variables = JSON.parse(record.variables) as Record<string, unknown>; } catch { variables = {}; }
  }
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'GraphQL syntax error.' }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'Must provide an operation.' }] };
  let operation = operations[0]!;
  if (typeof record.operationName === 'string') {
    const named = operations.find((op) => op.name === record.operationName);
    if (named !== undefined) operation = named;
  }
  return executeOperation(store, operation, variables);
}
