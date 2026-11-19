// store.ts — the forge's in-memory store: repositories, their git objects and refs, and the
// REST/GraphQL/MCP-visible issue, pull-request, label and comment state. Everything the
// suite creates lives here; nothing is persisted, which matches the trial (one fresh process
// per trial) and keeps the replay identical.

import {
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
} from './git.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;
export const DEFAULT_BRANCH = 'main';

export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  seq: number;
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  created_at: string;
  updated_at: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  issues: Issue[];
  pulls: PullRequest[];
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  seq: number;
  // pack cache for fetch: key -> pack bytes (invalidated by any ref change via version)
  packCache: Map<string, Buffer>;
  version: number;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextIssueId = 10000;
  nextPullId = 20000;
  nextCommentId = 1;
  seqCounter = 0;

  createRepo(owner: string, name: string, opts: { description?: string; private?: boolean } = {}): Repo {
    const stamp = nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner,
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      created_at: stamp,
      updated_at: stamp,
      refs: new Map(),
      objects: new Map(),
      issues: [],
      pulls: [],
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      seq: this.seqCounter++,
      packCache: new Map(),
      version: 0,
    };
    this.repos.set(repoKey(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(repoKey(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === VIEWER_LOGIN) out.push(repo);
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  bump(repo: Repo): void {
    repo.version += 1;
    repo.packCache.clear();
    repo.updated_at = nowIso();
  }

  // ---------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Every object reachable from `roots` (commits, trees, blobs, tags). */
  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root) && root !== ZERO_OID) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        for (const parent of commit.parents) queue.push(parent);
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /** True when `ancestor` is reachable from `descendant` by following parents (or equal). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }

  /** A common ancestor of a and b: BFS from both sides, the first meeting point. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const fromA = new Map<string, number>();
    const queueA: [string, number][] = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift()!;
      if (fromA.has(oid)) continue;
      fromA.set(oid, dist);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueA.push([parent, dist + 1]);
    }
    const queueB: [string, number][] = [[b, 0]];
    const seenB = new Set<string>();
    let best: string | null = null;
    let bestScore = Infinity;
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = fromA.get(oid);
      if (da !== undefined) {
        const score = da + dist;
        if (score < bestScore) {
          bestScore = score;
          best = oid;
        }
      }
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  /** The flat file map (path -> blob oid + mode) of a commit's tree. */
  filesAtCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return out;
    const rootTree = parseCommit(object.data).tree;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (!tree || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(rootTree, '');
    return out;
  }

  /** Build (and store) a tree from a flat file map; returns the root tree oid. */
  treeFromFiles(repo: Repo, files: Map<string, { oid: string; mode: string } | Buffer>): string {
    interface Node {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, value] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i]!;
        if (!node.dirs.has(name)) node.dirs.set(name, make());
        node = node.dirs.get(name)!;
      }
      const leaf = segments[segments.length - 1]!;
      if (Buffer.isBuffer(value)) {
        const oid = this.putObject(repo, 'blob', value);
        node.files.set(leaf, { oid, mode: '100644' });
      } else {
        node.files.set(leaf, value);
      }
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object on a branch tip (or unborn) and move the branch. */
  commitOnBranch(
    repo: Repo,
    branch: string,
    message: string,
    changes: Map<string, Buffer | null>,
    opts: { baseBranch?: string } = {},
  ): { commitSha: string; treeSha: string } {
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref);
    if (tip === undefined && opts.baseBranch !== undefined) {
      tip = repo.refs.get(`refs/heads/${opts.baseBranch}`);
    }
    const files = tip !== undefined ? this.filesAtCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
    const nextFiles = new Map<string, { oid: string; mode: string } | Buffer>(files);
    for (const [path, content] of changes) {
      if (content === null) nextFiles.delete(path);
      else nextFiles.set(path, content);
    }
    const treeSha = this.treeFromFiles(repo, nextFiles);
    const parents = tip !== undefined ? [tip] : [];
    const commitData = buildCommit({
      tree: treeSha,
      parents,
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: nowSec(),
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    this.bump(repo);
    return { commitSha, treeSha };
  }

  /** Commits reachable from `tip`, newest first (by committer timestamp, then discovery order). */
  commitsFrom(repo: Repo, tip: string): string[] {
    const seen = new Set<string>();
    const order: { oid: string; ts: number; depth: number }[] = [];
    const queue: [string, number][] = [[tip, 0]];
    while (queue.length > 0) {
      const [oid, depth] = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.add(oid);
      const commit = parseCommit(object.data);
      const ts = parseInt(commit.committer.split(' ').slice(-2, -1)[0] ?? '0', 10) || 0;
      order.push({ oid, ts, depth });
      for (const parent of commit.parents) queue.push([parent, depth + 1]);
    }
    order.sort((a, b) => b.ts - a.ts || a.depth - b.depth);
    return order.map((entry) => entry.oid);
  }

  /** Diff two trees: paths changed from `base` to `head`. */
  diffTrees(
    repo: Repo,
    baseCommit: string | null,
    headCommit: string,
  ): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const baseFiles = baseCommit === null ? new Map() : this.filesAtCommit(repo, baseCommit);
    const headFiles = this.filesAtCommit(repo, headCommit);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base && !head) out.push({ path, status: 'removed', oldOid: base.oid, newOid: null });
      else if (!base && head) out.push({ path, status: 'added', oldOid: null, newOid: head.oid });
      else if (base && head && base.oid !== head.oid) out.push({ path, status: 'modified', oldOid: base.oid, newOid: head.oid });
    }
    return out;
  }

  /** Whether merging head into base would conflict (same file changed both sides differently). */
  mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
    const base = this.mergeBase(repo, baseTip, headTip);
    const baseFiles = base === null ? new Map() : this.filesAtCommit(repo, base);
    const baseTipFiles = this.filesAtCommit(repo, baseTip);
    const headFiles = this.filesAtCommit(repo, headTip);
    const paths = new Set([...baseTipFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path);
      const onBase = baseTipFiles.get(path);
      const onHead = headFiles.get(path);
      const baseChanged = (ancestor?.oid ?? null) !== (onBase?.oid ?? null);
      const headChanged = (ancestor?.oid ?? null) !== (onHead?.oid ?? null);
      if (baseChanged && headChanged && (onBase?.oid ?? null) !== (onHead?.oid ?? null)) return true;
    }
    return false;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit or null on conflict. */
  squashMerge(repo: Repo, pr: PullRequest, message: string): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pr.base.ref}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head.ref}`);
    if (baseTip === undefined || headTip === undefined) return null;
    if (this.mergeConflicts(repo, baseTip, headTip)) return null;
    const base = this.mergeBase(repo, baseTip, headTip);
    const changes = this.diffTrees(repo, base, headTip);
    const files = this.filesAtCommit(repo, baseTip);
    const nextFiles = new Map<string, { oid: string; mode: string } | Buffer>(files);
    for (const change of changes) {
      if (change.status === 'removed') nextFiles.delete(change.path);
      else {
        const headFile = this.filesAtCommit(repo, headTip).get(change.path);
        if (headFile) nextFiles.set(change.path, headFile);
      }
    }
    const treeSha = this.treeFromFiles(repo, nextFiles);
    const commitData = buildCommit({
      tree: treeSha,
      parents: [baseTip],
      message,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp: nowSec(),
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.base.ref}`, commitSha);
    this.bump(repo);
    return commitSha;
  }
}
