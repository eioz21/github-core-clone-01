// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the in-memory store. Every reply is JSON with a
// {message} error body on failure; ownership is the token's login (adaiversen), so the
// same repository name under another owner is a 404, never a 403.

import { isObjectId, parseCommit } from './git.ts';
import type { Issue, Label, PullRequest, Repo, Store } from './store.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, nowIso } from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

export function globalRepoId(owner: string, name: string): string {
  return Buffer.from(`repo:${owner}/${name}`, 'utf8').toString('base64');
}

export function globalIssueId(owner: string, name: string, number: number): string {
  return Buffer.from(`issue:${owner}/${name}:${number}`, 'utf8').toString('base64');
}

export function globalPullId(owner: string, name: string, number: number): string {
  return Buffer.from(`pr:${owner}/${name}:${number}`, 'utf8').toString('base64');
}

export function globalCommentId(owner: string, name: string, number: number, id: number): string {
  return Buffer.from(`comment:${owner}/${name}:${number}:${id}`, 'utf8').toString('base64');
}

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER_LOGIN ? VIEWER_ID : 1001,
    avatar_url: `https://example.invalid/avatars/${login}`,
    type: 'User',
    html_url: `https://example.invalid/${login}`,
    url: `/api/v3/users/${login}`,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: globalRepoId(repo.owner, repo.name),
    name: repo.name,
    full_name: fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: repo.created_at,
    updated_at: repo.updated_at,
    pushed_at: repo.updated_at,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://example.invalid/${fullName}`,
    url: `/api/v3/repos/${fullName}`,
    clone_url: `https://example.invalid/${fullName}.git`,
    git_url: `git://example.invalid/${fullName}.git`,
    ssh_url: `git@example.invalid:${fullName}.git`,
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return { id: labelId(label.name), node_id: Buffer.from(`label:${label.name}`, 'utf8').toString('base64'), name: label.name, color: label.color, description: label.description, default: false };
}

function labelId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return 30000 + (hash % 10000);
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: globalIssueId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map(labelJson),
    assignees: [],
    milestone: null,
    comments: issue.comments.length,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    html_url: `https://example.invalid/${fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${fullName}`,
    labels_url: `/api/v3/repos/${fullName}/issues/${issue.number}/labels`,
    comments_url: `/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; created_at: string; updated_at: string }): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: comment.id,
    node_id: globalCommentId(repo.owner, repo.name, issue.number, comment.id),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    html_url: `https://example.invalid/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    issue_url: `/api/v3/repos/${fullName}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const files = repoFilesDiff(store, repo, pr);
  const conflicting = repoMergeConflicts(store, repo, pr);
  return {
    id: pr.id,
    node_id: globalPullId(repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    merged_at: pr.merged_at,
    merge_commit_sha: pr.merge_commit_sha,
    head: { label: `${repo.owner}:${pr.head.ref}`, ref: pr.head.ref, sha: pr.head.sha, user: userJson(repo.owner) },
    base: { label: `${repo.owner}:${pr.base.ref}`, ref: pr.base.ref, sha: pr.base.sha, user: userJson(repo.owner) },
    user: userJson(pr.user),
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    html_url: `https://example.invalid/${fullName}/pull/${pr.number}`,
    url: `/api/v3/repos/${fullName}/pulls/${pr.number}`,
    draft: false,
    mergeable: !pr.merged && !conflicting,
    mergeable_state: pr.merged ? 'merged' : conflicting ? 'conflicting' : 'clean',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    changed_files: files.length,
  };
}

function repoMergeConflicts(store: Store, repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseTip === undefined || headTip === undefined) return false;
  return store.mergeConflicts(repo, baseTip, headTip);
}

export interface PullFile {
  sha: string;
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  blob_url: string;
  raw_url: string;
  contents_url: string;
}

export function repoFilesDiff(store: Store, repo: Repo, pr: PullRequest): PullFile[] {
  const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
  if (baseTip === undefined || headTip === undefined) return [];
  const base = store.mergeBase(repo, baseTip, headTip);
  const changes = store.diffTrees(repo, base, headTip);
  const out: PullFile[] = [];
  for (const change of changes) {
    const newContent = change.newOid ? repo.objects.get(change.newOid)?.data : null;
    const oldContent = change.oldOid ? repo.objects.get(change.oldOid)?.data : null;
    const additions = newContent ? newContent.toString('utf8').split('\n').length : 0;
    const deletions = oldContent ? oldContent.toString('utf8').split('\n').length : 0;
    out.push({
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status === 'removed' ? 'removed' : change.status === 'added' ? 'added' : 'modified',
      additions: change.status === 'removed' ? 0 : additions,
      deletions: change.status === 'added' ? 0 : deletions,
      changes: (change.status === 'removed' ? 0 : additions) + (change.status === 'added' ? 0 : deletions),
      blob_url: '',
      raw_url: '',
      contents_url: '',
    });
  }
  return out;
}

// ------------------------------------------------------------ pagination

function paginate<T>(items: T[], query: URLSearchParams, origin: string, path: string): { page: T[]; link: string | null } {
  const perPageRaw = parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = parseInt(query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  let link: string | null = null;
  if (page < totalPages) {
    const next = new URL(`${origin}${path}`);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const last = new URL(`${origin}${path}`);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(totalPages));
    link = `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function linkHeaders(link: string | null): Record<string, string> | undefined {
  return link === null ? undefined : { link };
}

// ------------------------------------------------------------ helpers

function resolveRefTip(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`);
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`);
  if (repo.refs.has(ref)) return repo.refs.get(ref);
  if (isObjectId(ref) && repo.objects.has(ref)) return ref;
  return undefined;
}

function commitDateOf(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return nowIso();
  const commit = parseCommit(object.data);
  const parts = commit.committer.split(' ');
  const ts = parseInt(parts[parts.length - 2] ?? '0', 10);
  return Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : nowIso();
}

function commitAuthorOf(repo: Repo, oid: string): { name: string; email: string; date: string } {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() };
  const commit = parseCommit(object.data);
  const parse = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (!match) return { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() };
    return { name: match[1]!, email: match[2]!, date: new Date(parseInt(match[3]!, 10) * 1000).toISOString() };
  };
  return parse(commit.author);
}

function messageOf(repo: Repo, oid: string): string {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'commit') return '';
  const message = parseCommit(object.data).message;
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

// ------------------------------------------------------------ the router

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  origin: string,
  path: string,
): RestReply {
  const jsonBody = (typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');

  // API root and meta
  if (segments.length === 0) {
    if (method === 'GET') {
      return ok(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method === 'GET') return ok(200, { installed_version: '1.0.0' });
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method === 'GET') {
      return ok(200, {
        login: VIEWER_LOGIN,
        id: VIEWER_ID,
        node_id: Buffer.from(`user:${VIEWER_LOGIN}`, 'utf8').toString('base64'),
        avatar_url: `https://example.invalid/avatars/${VIEWER_LOGIN}`,
        type: 'User',
        name: VIEWER_NAME,
        email: VIEWER_EMAIL,
        html_url: `https://example.invalid/${VIEWER_LOGIN}`,
        url: '/api/v3/user',
      });
    }
    return err(404, 'Not Found');
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const { page, link } = paginate(store.viewerRepos().map(repoJson), query, origin, path);
      return ok(200, page, linkHeaders(link));
    }
    if (method === 'POST') {
      const name = str(jsonBody.name);
      if (name === '') return err(422, 'name is required');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'name is invalid');
      if (store.getRepo(VIEWER_LOGIN, name) !== undefined) return err(422, 'Repository already exists');
      const repo = store.createRepo(VIEWER_LOGIN, name, {
        description: str(jsonBody.description),
        private: jsonBody.private === true,
      });
      return ok(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  if (segments[0] !== 'repos' || segments.length < 3) return err(404, 'Not Found');
  const owner = decodeURIComponent(segments[1]!);
  const repoName = decodeURIComponent(segments[2]!);
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (repo === undefined) return err(404, 'Not Found');
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof jsonBody.description === 'string') repo.description = jsonBody.description;
      store.bump(repo);
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, body: null };
    }
    return err(404, 'Not Found');
  }

  if (repo === undefined) return err(404, 'Not Found');

  // branches
  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({
          name,
          commit: { sha: repo.refs.get(`refs/heads/${name}`)!, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(`refs/heads/${name}`)!}` },
          protected: false,
        }));
      return ok(200, branches);
    }
    if (rest.length === 2 && method === 'GET') {
      const branch = decodeURIComponent(rest[1]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
    }
    return err(404, 'Not Found');
  }

  // git refs
  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const ref = str(jsonBody.ref);
      const sha = str(jsonBody.sha);
      if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return err(422, 'Invalid ref');
      if (repo.refs.has(ref)) return err(422, 'Reference already exists');
      const object = repo.objects.get(sha);
      if (!isObjectId(sha) || object === undefined || (ref.startsWith('refs/heads/') && object.type !== 'commit')) {
        return err(422, 'Invalid sha');
      }
      repo.refs.set(ref, sha);
      store.bump(repo);
      return ok(201, { ref, object: { sha, type: object.type, url: `/api/v3/repos/${owner}/${repoName}/git/${object.type}s/${sha}` } });
    }
    if (method === 'GET' && rest.length === 4 && rest[2] === 'heads') {
      const branch = decodeURIComponent(rest[3]!);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` } });
    }
    return err(404, 'Not Found');
  }

  // commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const ref = query.get('sha') ?? undefined;
    const tip = resolveRefTip(repo, ref);
    if (tip === undefined) return ok(200, []);
    const commits = store.commitsFrom(repo, tip).map((sha) => {
      const object = repo.objects.get(sha)!;
      const commit = parseCommit(object.data);
      const author = commitAuthorOf(repo, sha);
      return {
        sha,
        commit: {
          message: messageOf(repo, sha),
          author,
          committer: author,
          tree: { sha: commit.tree },
        },
        author: userJson(VIEWER_LOGIN),
        committer: userJson(VIEWER_LOGIN),
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    return ok(200, commits);
  }

  // contents
  if (rest[0] === 'contents') {
    const filePath = rest.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
    if (method === 'PUT') {
      const branch = typeof jsonBody.branch === 'string' && jsonBody.branch !== '' ? jsonBody.branch : repo.defaultBranch;
      const contentB64 = str(jsonBody.content);
      if (contentB64 === '') return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const message = str(jsonBody.message) || 'Update file';
      const refName = `refs/heads/${branch}`;
      let tip = repo.refs.get(refName);
      if (tip === undefined && branch !== repo.defaultBranch) {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      }
      const files = tip !== undefined ? store.filesAtCommit(repo, tip) : new Map();
      const existing = files.get(filePath);
      const isUpdate = existing !== undefined;
      if (isUpdate) {
        const sha = str(jsonBody.sha);
        if (sha === '') return err(409, 'sha is required to update a file');
        if (sha.toLowerCase() !== existing.oid.toLowerCase()) return err(409, 'sha does not match the current file');
      } else if (typeof jsonBody.sha === 'string' && jsonBody.sha !== '') {
        return err(422, 'sha does not match: the file does not exist');
      }
      const blobSha = store.putObject(repo, 'blob', content);
      const changes = new Map<string, Buffer | null>([[filePath, content]]);
      const { commitSha } = store.commitOnBranch(repo, branch, message, changes, { baseBranch: branch === repo.defaultBranch ? undefined : repo.defaultBranch });
      return ok(isUpdate ? 200 : 201, {
        content: {
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          sha: blobSha,
          size: content.length,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
          html_url: `https://example.invalid/${owner}/${repoName}/blob/${branch}/${filePath}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobSha}`,
          download_url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}?raw=1`,
          type: 'file',
          encoding: 'base64',
        },
        commit: { sha: commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: nowIso() } },
      });
    }
    if (method === 'DELETE') {
      const tip = resolveRefTip(repo, query.get('ref') ?? undefined);
      if (tip === undefined) return err(404, 'Not Found');
      const files = store.filesAtCommit(repo, tip);
      const existing = files.get(filePath);
      if (existing === undefined) return err(404, 'Not Found');
      if (typeof jsonBody.sha === 'string' && jsonBody.sha !== '' && jsonBody.sha.toLowerCase() !== existing.oid.toLowerCase()) {
        return err(409, 'sha does not match the current file');
      }
      const message = str(jsonBody.message) || 'Delete file';
      const changes = new Map<string, Buffer | null>([[filePath, null]]);
      const { commitSha } = store.commitOnBranch(repo, repo.defaultBranch, message, changes);
      return ok(200, { commit: { sha: commitSha, message } });
    }
    if (method === 'GET') {
      const tip = resolveRefTip(repo, query.get('ref') ?? undefined);
      if (tip === undefined) return err(404, 'Not Found');
      const files = store.filesAtCommit(repo, tip);
      if (filePath === '') {
        const entries = dirEntries(repo, files, '');
        return ok(200, entries);
      }
      const direct = files.get(filePath);
      if (direct !== undefined) {
        const object = repo.objects.get(direct.oid)!;
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          size: object.data.length,
          name: filePath.split('/').pop() ?? filePath,
          path: filePath,
          content: object.data.toString('base64'),
          sha: direct.oid,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}`,
          html_url: `https://example.invalid/${owner}/${repoName}/blob/${repo.defaultBranch}/${filePath}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${direct.oid}`,
          download_url: `/api/v3/repos/${owner}/${repoName}/contents/${filePath}?raw=1`,
        });
      }
      const prefix = `${filePath}/`;
      const hasChildren = [...files.keys()].some((path) => path.startsWith(prefix));
      if (!hasChildren) return err(404, 'Not Found');
      return ok(200, dirEntries(repo, files, filePath));
    }
    return err(404, 'Not Found');
  }

  // labels
  if (rest[0] === 'labels') {
    if (method === 'GET' && rest.length === 1) return ok(200, [...repo.labels.values()].map(labelJson));
    if (method === 'POST' && rest.length === 1) {
      const name = str(jsonBody.name);
      if (name === '') return err(422, 'name is required');
      const existing = repo.labels.get(name);
      if (existing !== undefined) return ok(201, labelJson(existing));
      const label: Label = { name, color: str(jsonBody.color) || 'ededed', description: str(jsonBody.description) };
      repo.labels.set(name, label);
      return ok(201, labelJson(label));
    }
    return err(404, 'Not Found');
  }

  // issues
  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const title = str(jsonBody.title);
        if (title === '') return err(422, 'title is required');
        const labelNames = Array.isArray(jsonBody.labels) ? jsonBody.labels.map((label) => String(label)) : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) return err(422, `Label '${labelName}' does not exist`);
          labels.push(label);
        }
        const stamp = nowIso();
        const issue: Issue = {
          id: store.nextIssueId++,
          number: repo.nextIssue++,
          title,
          body: str(jsonBody.body),
          state: 'open',
          labels,
          comments: [],
          user: VIEWER_LOGIN,
          created_at: stamp,
          updated_at: stamp,
          closed_at: null,
          seq: store.seqCounter++,
        };
        repo.issues.push(issue);
        return ok(201, issueJson(repo, issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((issue) => issue.state === 'open');
        else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { page, link } = paginate(list.map((issue) => issueJson(repo, issue)), query, origin, path);
        return ok(200, page, linkHeaders(link));
      }
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1]!, 10);
    const issue = repo.issues.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, issueJson(repo, issue));
      if (method === 'PATCH') {
        if (jsonBody.state === 'open' || jsonBody.state === 'closed') {
          issue.state = jsonBody.state;
          issue.closed_at = jsonBody.state === 'closed' ? nowIso() : null;
        }
        if (typeof jsonBody.title === 'string') issue.title = jsonBody.title;
        if (typeof jsonBody.body === 'string') issue.body = jsonBody.body;
        issue.updated_at = nowIso();
        return ok(200, issueJson(repo, issue));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (issue === undefined) return err(404, 'Not Found');
      if (method === 'POST') {
        const bodyText = str(jsonBody.body);
        if (bodyText === '') return err(422, 'body is required');
        const stamp = nowIso();
        const comment = { id: store.nextCommentId++, body: bodyText, user: VIEWER_LOGIN, created_at: stamp, updated_at: stamp };
        issue.comments.push(comment);
        return ok(201, commentJson(repo, issue, comment));
      }
      if (method === 'GET') return ok(200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // pull requests
  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const head = str(jsonBody.head);
        const base = str(jsonBody.base);
        const title = str(jsonBody.title);
        if (head === '' || base === '' || title === '') return err(422, 'head, base and title are required');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined) return err(422, `head branch '${head}' does not exist`);
        if (baseSha === undefined) return err(422, `base branch '${base}' does not exist`);
        const existing = repo.pulls.find((pr) => pr.head.ref === head && pr.base.ref === base && pr.state === 'open');
        if (existing !== undefined) return err(422, 'A pull request already exists for this head and base');
        const stamp = nowIso();
        const pr: PullRequest = {
          id: store.nextPullId++,
          number: repo.nextPull++,
          title,
          body: str(jsonBody.body),
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
        return ok(201, pullJson(store, repo, pr));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((pr) => pr.state === 'open');
        else if (state === 'closed') list = list.filter((pr) => pr.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(list.map((pr) => pullJson(store, repo, pr)), query, origin, path);
        return ok(200, page, linkHeaders(link));
      }
      return err(404, 'Not Found');
    }
    const number = parseInt(rest[1]!, 10);
    const pr = repo.pulls.find((entry) => entry.number === number);
    if (rest.length === 2) {
      if (pr === undefined) return err(404, 'Not Found');
      if (method === 'GET') return ok(200, pullJson(store, repo, pr));
      return err(404, 'Not Found');
    }
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
      if (pr === undefined) return err(404, 'Not Found');
      return ok(200, repoFilesDiff(store, repo, pr));
    }
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
      if (pr === undefined) return err(404, 'Not Found');
      if (pr.merged || pr.state !== 'open') return err(405, 'Pull request is already merged or closed');
      const mergeMethod = str(jsonBody.merge_method) || 'squash';
      if (mergeMethod !== 'squash' && mergeMethod !== 'merge' && mergeMethod !== 'rebase') {
        return err(422, `Unknown merge method '${mergeMethod}'`);
      }
      const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
      const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
      if (baseTip === undefined || headTip === undefined) return err(409, 'The head or base branch is missing');
      if (store.mergeConflicts(repo, baseTip, headTip)) {
        return err(405, 'Merge conflict');
      }
      const message = `Merge pull request #${pr.number} from ${pr.head.ref}`;
      const sha = store.squashMerge(repo, pr, message);
      if (sha === null) return err(405, 'Merge conflict');
      pr.merged = true;
      pr.state = 'closed';
      pr.merged_at = nowIso();
      pr.merge_commit_sha = sha;
      pr.closed_at = pr.merged_at;
      pr.updated_at = pr.merged_at;
      return ok(200, { sha, merged: true, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

function dirEntries(repo: Repo, files: Map<string, { oid: string; mode: string }>, dir: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const children = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const rest = path.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash === -1) {
      const object = repo.objects.get(file.oid);
      children.set(rest, { type: 'file', oid: file.oid, size: object ? object.data.length : 0 });
    } else {
      const name = rest.slice(0, slash);
      if (!children.has(name)) children.set(name, { type: 'dir', oid: '', size: 0 });
    }
  }
  const entries: Record<string, unknown>[] = [];
  for (const name of [...children.keys()].sort()) {
    const child = children.get(name)!;
    const path = prefix + name;
    entries.push({
      type: child.type,
      name,
      path,
      sha: child.oid,
      size: child.type === 'file' ? child.size : 0,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${child.oid}`,
      download_url: child.type === 'file' ? `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}?raw=1` : null,
    });
  }
  return entries;
}
