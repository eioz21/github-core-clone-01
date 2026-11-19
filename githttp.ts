// githttp.ts — git smart HTTP: ref advertisements (v0/v2), v2 ls-refs, upload-pack fetch
// (v2 and v0) and receive-pack push with report-status. All wire shapes follow what the
// suite's client parses: pkt-line framing, side-band-64k pack delivery, shallow-info, and
// per-ref ok/ng report lines.

import {
  PKT_DELIM,
  PKT_FLUSH,
  encodePktLine,
  encodePktLines,
  decodePktLinesPrefix,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
  ZERO_OID,
} from './git.ts';
import type { GitObject } from './git.ts';
import type { Repo, Store } from './store.ts';

export interface AdvertisedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

function sidebandPackets(data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const MAX = 65515;
  for (let offset = 0; offset < data.length; offset += MAX) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + MAX));
    out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) out.push(encodePktLine(Buffer.from([1])));
  return out;
}

/** All refs of a repo, sorted, with peeled tag targets. */
export function listRefs(repo: Repo): AdvertisedRef[] {
  const refs: AdvertisedRef[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const ref: AdvertisedRef = { oid, name };
    const object = repo.objects.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      if (target) ref.peeled = target;
    }
    refs.push(ref);
  }
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) {
    refs.unshift({ oid: defaultTip, name: 'HEAD', symrefTarget: `refs/heads/${repo.defaultBranch}` });
  }
  return refs;
}

// ------------------------------------------------------------ advertisements

const V2_CAPABILITIES = [
  'agent=forge/1.0',
  'ls-refs',
  'fetch=shallow filter',
  'object-format=sha1',
];

export function v2Advertisement(): Buffer {
  const lines: (string | 'flush')[] = ['version 2\n', ...V2_CAPABILITIES.map((cap) => `${cap}\n`), 'flush'];
  return encodePktLines(lines);
}

function v0CapabilityString(repo: Repo, service: 'upload' | 'receive'): string {
  const caps: string[] = [];
  const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (defaultTip !== undefined) caps.push(`symref=HEAD:refs/heads/${repo.defaultBranch}`);
  if (service === 'upload') caps.push('side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'multi_ack');
  else caps.push('report-status', 'side-band-64k', 'delete-refs', 'ofs-delta');
  caps.push('agent=forge/1.0');
  return caps.join(' ');
}

export function v0Advertisement(repo: Repo, service: 'upload' | 'receive'): Buffer {
  const serviceName = service === 'upload' ? 'git-upload-pack' : 'git-receive-pack';
  const parts: Buffer[] = [encodePktLine(`# service=${serviceName}\n`), PKT_FLUSH];
  const caps = v0CapabilityString(repo, service);
  const refs = [...repo.refs.keys()].sort();
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const lines: string[] = [];
    if (defaultTip !== undefined) lines.push(`${defaultTip} HEAD`);
    for (const name of refs) {
      const oid = repo.refs.get(name)!;
      lines.push(`${oid} ${name}`);
      const object = repo.objects.get(oid);
      if (object?.type === 'tag') {
        const target = parseTag(object.data).object;
        if (target) lines.push(`${target} ${name}^{}`);
      }
    }
    for (const line of lines) {
      if (first) {
        parts.push(encodePktLine(`${line}\0${caps}\n`));
        first = false;
      } else {
        parts.push(encodePktLine(`${line}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ ls-refs (v2)

export function lsRefsResponse(repo: Repo, prefixes: string[], peel: boolean, symrefs: boolean): Buffer {
  const refs = listRefs(repo).filter((ref) => {
    if (prefixes.length === 0) return true;
    return prefixes.some((prefix) => ref.name.startsWith(prefix));
  });
  const lines: string[] = [];
  for (const ref of refs) {
    if (ref.name === 'HEAD' && !symrefs) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    lines.push(`${line}\n`);
  }
  return Buffer.concat([encodePktLines(lines), PKT_FLUSH]);
}

// ------------------------------------------------------------ fetch computation

export interface FetchPlan {
  objects: Map<string, GitObject>;
  shallowOut: string[];
  unshallow: string[];
}

function treeClosure(repo: Repo, treeOid: string, into: Set<string>): void {
  const stack = [treeOid];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (into.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    into.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    }
  }
}

/** Objects the client already holds: reachable from haves without crossing shallow boundaries. */
function haveClosure(repo: Repo, haves: readonly string[], shallowBoundaries: readonly string[]): Set<string> {
  const held = new Set<string>();
  const boundary = new Set(shallowBoundaries);
  const queue = [...haves];
  const seenCommits = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seenCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      held.add(oid);
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') {
      held.add(oid);
      continue;
    }
    seenCommits.add(oid);
    held.add(oid);
    const commit = parseCommit(object.data);
    treeClosure(repo, commit.tree, held);
    if (!boundary.has(oid)) {
      for (const parent of commit.parents) queue.push(parent);
    }
  }
  return held;
}

export function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const held = haveClosure(repo, haves, shallowBoundaries);
  const includedCommits = new Map<string, number>();
  const tagObjects = new Set<string>();
  const queue: { oid: string; dist: number }[] = wants.map((oid) => ({ oid, dist: 0 }));
  while (queue.length > 0) {
    const { oid, dist } = queue.shift()!;
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'tag') {
      if (tagObjects.has(oid)) continue;
      tagObjects.add(oid);
      queue.push({ oid: parseTag(object.data).object, dist });
      continue;
    }
    if (object.type !== 'commit') continue;
    if (includedCommits.has(oid)) continue;
    if (depth !== undefined && dist >= depth) continue;
    includedCommits.set(oid, dist);
    if (depth === undefined || dist + 1 < depth) {
      const commit = parseCommit(object.data);
      for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
    }
  }
  const objects = new Map<string, GitObject>();
  const addClosure = (rootOids: Iterable<string>): void => {
    const all = new Set<string>();
    for (const oid of rootOids) {
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'commit') {
        all.add(oid);
        treeClosure(repo, parseCommit(object.data).tree, all);
      } else if (object.type === 'tree') {
        treeClosure(repo, oid, all);
      } else {
        all.add(oid);
      }
    }
    for (const oid of all) {
      if (held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object) objects.set(oid, object);
    }
  };
  addClosure(tagObjects);
  addClosure(includedCommits.keys());

  let shallowOut: string[] = [];
  let unshallow: string[] = [];
  if (depth !== undefined || shallowBoundaries.length > 0) {
    for (const [oid] of includedCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      const boundary = parents.length === 0 || parents.some((parent) => !includedCommits.has(parent));
      if (boundary) shallowOut.push(oid);
    }
    const shallowSet = new Set(shallowOut);
    for (const old of shallowBoundaries) {
      if (includedCommits.has(old) && !shallowSet.has(old)) unshallow.push(old);
    }
  }
  return { objects, shallowOut, unshallow };
}

// ------------------------------------------------------------ upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

function parseV2Request(body: Buffer): { command: string; args: FetchRequest } {
  const { packets } = decodePktLinesPrefix(body);
  let command = '';
  const args: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (!inArgs) {
      if (line.startsWith('command=')) command = line.slice('command='.length).trim();
      continue;
    }
    const text = line.replace(/\n$/, '');
    if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (text === 'done') args.done = true;
  }
  return { command, args };
}

function parseV0FetchRequest(body: Buffer): FetchRequest {
  const { packets } = decodePktLinesPrefix(body);
  const args: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const firstSpace = line.indexOf(' ');
    const word = firstSpace < 0 ? line : line.slice(0, firstSpace);
    const rest = firstSpace < 0 ? '' : line.slice(firstSpace + 1);
    if (word === 'want') args.wants.push(rest.split(' ')[0]!);
    else if (word === 'have') args.haves.push(rest.trim());
    else if (word === 'shallow') args.shallow.push(rest.trim());
    else if (word === 'deepen') {
      const n = parseInt(rest.trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

function packSideband(pack: Buffer): Buffer {
  return Buffer.concat([...sidebandPackets(pack), PKT_FLUSH]);
}

function fetchCacheKey(prefix: string, wants: string[], haves: string[], shallow: string[], depth: number | undefined, done: boolean): string {
  return `${prefix}:${JSON.stringify([[...wants].sort(), [...haves].sort(), [...shallow].sort(), depth ?? null, done])}`;
}

function cachePut(repo: Repo, key: string, value: Buffer): Buffer {
  if (repo.packCache.size >= 64) repo.packCache.clear();
  repo.packCache.set(key, value);
  return value;
}

export function handleUploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { command, args } = parseV2Request(body);
  if (command === 'ls-refs') {
    let prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    const { packets } = decodePktLinesPrefix(body);
    let inArgs = false;
    for (const packet of packets) {
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind !== 'data' || !inArgs) continue;
      const text = packet.payload.toString('utf8').replace(/\n$/, '');
      if (text === 'peel') peel = true;
      else if (text === 'symrefs') symrefs = true;
      else if (text.startsWith('ref-prefix ')) prefixes.push(text.slice('ref-prefix '.length));
    }
    return lsRefsResponse(repo, prefixes, peel, symrefs);
  }
  if (command !== 'fetch') throw new Error(`unknown v2 command ${command}`);
  const cacheKey = fetchCacheKey('v2', args.wants, args.haves, args.shallow, args.depth, args.done);
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation round: acknowledgments only, no packfile. The client will
    // send another request with more haves or with `done`.
    parts.push(encodePktLine('acknowledgments\n'));
    parts.push(encodePktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    return cachePut(repo, cacheKey, Buffer.concat(parts));
  }
  // The client sent `done`, so negotiation is finished: the acknowledgments
  // section is omitted (protocol-v2) and the response starts with the
  // optional shallow-info section, then the packfile section.
  if (plan.shallowOut.length > 0 || plan.unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(packSideband(pack));
  return cachePut(repo, cacheKey, Buffer.concat(parts));
}

export function handleUploadPackV0(repo: Repo, body: Buffer): Buffer {
  const args = parseV0FetchRequest(body);
  const cacheKey = fetchCacheKey('v0', args.wants, args.haves, args.shallow, args.depth, false);
  const cached = repo.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const plan = computeFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(plan.objects.values());
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of plan.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(packSideband(pack));
  return cachePut(repo, cacheKey, Buffer.concat(parts));
}

// ------------------------------------------------------------ receive-pack

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): { status: number; body: Buffer } {
  const reportLines: string[] = [];
  try {
    const { packets, offset } = decodePktLinesPrefix(body);
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const text = line.replace(/\n$/, '');
      const parts = text.split(' ');
      if (parts.length < 3) continue;
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    const packBytes = body.subarray(offset);
    const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
    let unpackError: string | null = null;
    if (updatesRef) {
      if (packBytes.length === 0) {
        unpackError = 'no pack received';
      } else {
        try {
          if (!verifyPackChecksum(packBytes)) throw new Error('pack trailer checksum mismatch');
          const { objects } = readPack(packBytes, (oid) => repo.objects.get(oid));
          for (const [oid, object] of objects) {
            if (!repo.objects.has(oid)) {
              const computed = hashObject(object.type, object.data);
              if (computed !== oid) throw new Error(`pack object ${oid} does not hash to its id`);
              repo.objects.set(oid, object);
            }
          }
        } catch (err) {
          unpackError = err instanceof Error ? err.message : String(err);
        }
      }
    }
    const results: PushReportLine[] = [];
    for (const command of commands) {
      if (unpackError !== null) {
        results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
        continue;
      }
      const current = repo.refs.get(command.ref);
      let ok = true;
      let reason = '';
      const isTag = command.ref.startsWith('refs/tags/');
      if (command.newOid === ZERO_OID) {
        // delete
        if (current === undefined) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else if (command.oldOid === ZERO_OID) {
        // create
        if (current !== undefined) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      } else {
        // update
        if (current === undefined || current !== command.oldOid) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!repo.objects.has(command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        } else if (!isTag && !store.isAncestor(repo, command.oldOid, command.newOid)) {
          ok = false;
          reason = 'non-fast-forward';
        }
      }
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
      }
      results.push({ ref: command.ref, ok, reason });
    }
    if (results.some((result) => result.ok) || commands.length === 0) store.bump(repo);
    reportLines.push(unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`);
    for (const result of results) {
      reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
    }
  } catch (err) {
    reportLines.push(`unpack ${err instanceof Error ? err.message : String(err)}\n`);
  }
  const report = encodePktLines([...reportLines, 'flush']);
  return { status: 200, body: Buffer.concat([...sidebandPackets(report), PKT_FLUSH]) };
}
