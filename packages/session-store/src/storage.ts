import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { SessionStoreError, systemErrorCode } from './errors.js';
import { FOREIGN_FILE, LINKED_FILE, OPEN_FILE } from './files.js';
import { runBounded } from './spawn.js';

/**
 * A refused store path. The message stays path-free; `path` is for the owner's terminal only, and
 * `fix`, when there is one, is the command that fixes it once the path is added.
 */
export class StoreRefusal extends SessionStoreError {
  readonly fix: string | undefined;

  constructor(
    message: string,
    readonly path: string,
    options?: ErrorOptions & { fix?: string | undefined },
  ) {
    super('UNSAFE_FILE', message, options);
    this.name = 'StoreRefusal';
    this.fix = options?.fix;
  }
}

export type StoreStat = Pick<Stats, 'mode' | 'uid' | 'nlink'> & {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

const NOT_A_DIRECTORY =
  'Something other than a folder is at this store path. Move it away and start again.';

const FOREIGN_DIRECTORY =
  'This store directory belongs to another user, often root after a sudo run.';

const OPEN_DIRECTORY = 'Other users can open this store directory.';

const WRITABLE_ANCESTOR = 'Other users can write to a folder above the store.';

const OWNED_ACL =
  'Extra sharing permissions (an access control list, set in Finder’s Get Info) let other users in.';

// `chmod -N` would also drop the stock `everyone deny delete` entry, so this one has no command.
const ANCESTOR_ACL =
  'Extra sharing permissions (an access control list) on a folder above the store let other users change it. List them with ls -led and remove the entry that allows another user to write.';

// The command for each refusal that has one; the startup line adds the quoted path.
const FIXES = new Map([
  [FOREIGN_DIRECTORY, 'sudo chown -R "$(id -un)"'],
  [OPEN_DIRECTORY, 'chmod 700'],
  [WRITABLE_ANCESTOR, 'chmod go-w'],
  [OPEN_FILE, 'chmod 600'],
  [FOREIGN_FILE, 'sudo chown "$(id -un)"'],
  [OWNED_ACL, 'chmod -N'],
]);

/** A refusal with its fixed command, if it has one. */
function refusal(problem: string, path: string): StoreRefusal {
  return new StoreRefusal(problem, path, { fix: FIXES.get(problem) });
}

const STICKY = 0o1000;

/** A directory the store owns (keys/, a server's directory, family-mcp/): 0700, ours, real. */
export function ownedDirectoryProblem(info: StoreStat, uid: number): string | undefined {
  if (info.isSymbolicLink()) return 'The store directory is a symbolic link; use a real directory.';

  if (!info.isDirectory()) return NOT_A_DIRECTORY;

  if (info.uid !== uid) return FOREIGN_DIRECTORY;

  if ((info.mode & 0o077) !== 0) return OPEN_DIRECTORY;

  return undefined;
}

/**
 * A directory above the store must not let another user replace what is below it: owned by this
 * user or root and not writable by group or other. A sticky shared directory such as /tmp passes
 * when the entry below it is this user's or root's, which only they can rename or remove.
 */
export function ancestorProblem(
  info: StoreStat,
  uid: number,
  childUid: number | undefined,
): string | undefined {
  if (!info.isDirectory()) return NOT_A_DIRECTORY;

  if (info.uid !== uid && info.uid !== 0)
    return 'A directory above the store is owned by another user.';

  const sticky =
    (info.mode & STICKY) !== 0 && childUid !== undefined && (childUid === uid || childUid === 0);

  if ((info.mode & 0o022) !== 0 && !sticky) return WRITABLE_ANCESTOR;

  return undefined;
}

/**
 * A key, record or marker file: the same rules and texts as `readPrivateBytes`, less the command
 * that the refusal's `fix` carries. `links` is the number of names it may have, more than one
 * only for a recognised interrupted key publication.
 */
export function privateFileProblem(
  info: StoreStat,
  uid: number | undefined,
  links = 1,
): string | undefined {
  if (info.isSymbolicLink()) return 'The path is a symbolic link; use a regular file.';

  if (!info.isFile()) return 'The path is not a regular file.';

  if (info.nlink > links) return LINKED_FILE;

  if (process.platform === 'win32') return undefined;

  if ((info.mode & 0o077) !== 0) return OPEN_FILE;

  if (uid !== undefined && info.uid !== uid) return FOREIGN_FILE;

  return undefined;
}

/**
 * The directories the store owns for one of its files: the file's directory, and `family-mcp/`
 * above it when that is the parent (macOS for both, Linux for keys).
 */
export function storeDirectories(file: string): string[] {
  const directory = dirname(file);
  const parent = dirname(directory);

  return basename(parent) === 'family-mcp' ? [parent, directory] : [directory];
}

/** `lstat`, or undefined when nothing is there. */
export async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT' || systemErrorCode(error) === 'ENOTDIR')
      return undefined;
    throw new SessionStoreError('IO', 'Cannot inspect the secret store. Check its permissions.', {
      cause: error,
    });
  }
}

type AclRole = 'owned' | 'ancestor';

/** `from` is the written store directory an ancestor was reached from, for its refusal's path. */
type Checked = { path: string; info: Stats; role: AclRole; from?: string };

/**
 * Check the store directories and every directory above them, on both the written path and the
 * path it resolves to, then the files. Creates `create` directories (0700) that are missing,
 * only after the directories above them passed. Nothing else is created, read or locked.
 */
export async function checkStorePaths(options: {
  directories: readonly string[];
  files?: readonly string[] | undefined;
  create?: readonly string[] | undefined;
  /** A file that may carry one recognised extra link, such as a key whose publication crashed. */
  allowLink?: ((path: string, info: Stats) => Promise<boolean>) | undefined;
}): Promise<void> {
  if (process.platform === 'win32') return;
  const uid = process.getuid?.() ?? 0;
  const checked: Checked[] = [];

  for (const directory of options.directories) {
    for (const ancestor of await ancestorsOf(directory, uid)) checked.push(ancestor);
    let info = await lstatOrMissing(directory);

    if (info === undefined && options.create?.includes(directory)) {
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 });
      } catch (error) {
        throw new StoreRefusal(
          'Cannot create the store directory. Check its permissions.',
          directory,
          {
            cause: error,
          },
        );
      }

      info = await lstatOrMissing(directory);
    }

    if (info === undefined) continue;
    const problem = ownedDirectoryProblem(info, uid);

    if (problem !== undefined) throw refusal(problem, directory);
    checked.push({ path: directory, info, role: 'owned' });
  }

  for (const file of options.files ?? []) {
    let info = await lstatOrMissing(file);

    if (info === undefined) continue;
    let links = 1;

    if (info.isFile() && info.nlink === 2 && options.allowLink !== undefined)
      if (await options.allowLink(file, info)) links = 2;
      else {
        // Another process may have removed the recognised second name after the lstat above:
        // look once more, and take the file only if it is the same one, now with one name.
        const fresh = await lstatOrMissing(file);

        if (fresh === undefined) continue;

        if (fresh.isFile() && fresh.dev === info.dev && fresh.ino === info.ino && fresh.nlink === 1)
          info = fresh;
      }

    const problem = privateFileProblem(info, uid, links);

    if (problem !== undefined) throw refusal(problem, file);
    checked.push({ path: file, info, role: 'owned' });
  }

  if (process.platform === 'darwin') await checkAcls(checked);
}

// More expansions than this above one store directory are a loop or an attack; macOS stops at 32.
const MAX_LINKS = 40;

/**
 * The existing directories above `directory`, each checked, along the route the kernel takes:
 * one name at a time from the root, and through every symbolic link on the way, including links
 * inside a link's target and the directories above that target. A link must be this user's or
 * root's. The walk stops at the first missing name; a dangling link or more than `MAX_LINKS`
 * expansions is refused. Paths in the result have no links.
 */
async function ancestorsOf(directory: string, uid: number): Promise<Checked[]> {
  const found = new Map<string, Checked>();
  const absolute = resolve(directory);
  const { root } = parse(absolute);
  const leaf = basename(absolute);
  const names = components(dirname(absolute));
  let current = root;
  let info = await lstat(root);
  let links = 0;

  for (;;) {
    const next = names.shift();
    const name = next ?? leaf;

    if (name === '.') continue;

    if (name === '..') {
      // Its parent was checked on the way down, with this directory as its child.
      current = dirname(current);
      info = await lstat(current);
      continue;
    }

    const entry = join(current, name);
    const child = await lstatOrMissing(entry);
    const problem = ancestorProblem(info, uid, child?.uid);

    if (problem !== undefined) throw refusal(problem, await shown(current, absolute));
    found.set(current, { path: current, info, role: 'ancestor', from: absolute });

    if (next === undefined || child === undefined) break;

    if (child.isSymbolicLink()) {
      if (child.uid !== uid && child.uid !== 0)
        throw new StoreRefusal(
          'A directory above the store is owned by another user.',
          await shown(entry, absolute),
        );

      if (++links > MAX_LINKS || !(await resolves(entry)))
        throw new StoreRefusal(
          'Cannot resolve a directory above the store.',
          await shown(entry, absolute),
        );
      const target = await readlink(entry);

      // A relative target continues from the link's directory, an absolute one from the root.
      if (isAbsolute(target)) {
        current = parse(target).root;
        info = await lstat(current);
      }

      names.unshift(...components(target));
      continue;
    }

    current = entry;
    info = child;
  }

  return [...found.values()];
}

/** The names of `path` below its root, `.` and `..` kept for the walk to apply. */
function components(path: string): string[] {
  return path.slice(parse(path).root.length).split(sep).filter(Boolean);
}

/** False for a dangling link or a loop. */
async function resolves(path: string): Promise<boolean> {
  try {
    await stat(path);

    return true;
  } catch {
    return false;
  }
}

/** The route as the owner wrote it when it names the same entry, else the resolved one. */
async function shown(path: string, written: string): Promise<string> {
  for (const prefix of prefixes(written)) {
    const parent = await realpath(dirname(prefix)).catch(() => undefined);

    if (parent !== undefined && join(parent, basename(prefix)) === path) return prefix;
  }

  return path;
}

/** `/a/b` gives `/`, `/a`, `/a/b`. */
function prefixes(path: string): string[] {
  const { root } = parse(path);
  const parts = path.slice(root.length).split(sep).filter(Boolean);

  return [root, ...parts.map((_, index) => join(root, ...parts.slice(0, index + 1)))];
}

// Grants that let another user replace or change what is below a directory above the store.
const CHANGING = new Set([
  'write',
  'append',
  'add_file',
  'add_subdirectory',
  'delete',
  'delete_child',
  'writeattr',
  'writeextattr',
  'writesecurity',
  'chown',
]);

const ACL_ENTRY = /^ \d+: (\S+)(?: inherited)? (allow|deny) (\S+)$/;

// An ACL listing changes the inode's ctime, so an unchanged inode keeps its last answer.
const aclCache = new Map<string, true>();

function stamp({ path, info }: Checked): string {
  return `${path}\0${info.dev}:${info.ino}:${info.ctimeMs}:${info.mode}`;
}

/** macOS keeps ACLs apart from the mode bits; `ls -le` is the only reader without a native API. */
async function checkAcls(checked: readonly Checked[]): Promise<void> {
  const unknown = checked.filter(
    (entry, index) =>
      !aclCache.has(stamp(entry)) && checked.findIndex(({ path }) => path === entry.path) === index,
  );

  if (unknown.length === 0) return;

  if (unknown.some(({ path }) => path.includes('\n')))
    throw new StoreRefusal('The store path contains a line break.', unknown[0]?.path ?? '');

  const listing = await runBounded('/bin/ls', ['-ldef', '--', ...unknown.map(({ path }) => path)], {
    timeoutMs: 5000,
    maxBytes: 1_048_576,
  });

  if (listing.status !== 0)
    throw new SessionStoreError(
      'IO',
      'Cannot check the store’s access control lists. Check its permissions and try again.',
    );

  const entries = aclEntries(listing.stdout);

  if (entries.length !== unknown.length)
    throw new SessionStoreError(
      'IO',
      'Cannot check the store’s access control lists. Check its permissions and try again.',
    );

  const self = userInfo().username;

  for (const [index, entry] of unknown.entries()) {
    const problem = aclProblem(entries[index] ?? [], entry.role, self);

    if (problem !== undefined)
      throw refusal(
        problem,
        entry.from === undefined ? entry.path : await shown(entry.path, entry.from),
      );
  }

  for (const entry of unknown) aclCache.set(stamp(entry), true);
}

/** The ACL lines of each `ls -lde` entry, in argument order. */
export function aclEntries(output: string): string[][] {
  const entries: string[][] = [];

  for (const line of output.split('\n')) {
    if (line === '') continue;

    if (line.startsWith(' ')) entries.at(-1)?.push(line);
    else entries.push([]);
  }

  return entries;
}

/**
 * Deny entries pass: a stock home carries `group:everyone deny delete`. A store directory or file
 * refuses every allow entry; a directory above it refuses one that lets another user change it.
 * An entry this check cannot read is refused rather than guessed at.
 */
export function aclProblem(
  lines: readonly string[],
  role: AclRole,
  self: string,
): string | undefined {
  for (const line of lines) {
    const match = ACL_ENTRY.exec(line);

    if (match === null) return aclMessage(role);
    const [, principal, kind, permissions = ''] = match;

    if (kind === 'deny') continue;

    if (role === 'owned') return aclMessage(role);

    if (principal === `user:${self}`) continue;

    if (permissions.split(',').some((permission) => CHANGING.has(permission)))
      return aclMessage(role);
  }

  return undefined;
}

function aclMessage(role: AclRole): string {
  return role === 'owned' ? OWNED_ACL : ANCESTOR_ACL;
}

/** The store's recognised temporaries of `path`: `<name>.<uuid>.tmp` beside it. */
export async function temporariesOf(path: string): Promise<string[]> {
  const prefix = `${basename(path)}.`;
  let names: string[];

  try {
    names = await readdir(dirname(path));
  } catch (error) {
    if (systemErrorCode(error) === 'ENOENT') return [];
    throw new SessionStoreError('IO', 'Cannot list the directory. Check its permissions.', {
      cause: error,
    });
  }

  return names
    .filter((name) => name.startsWith(prefix) && TEMPORARY.test(name.slice(prefix.length)))
    .map((name) => join(dirname(path), name));
}

const TEMPORARY = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.tmp$/;
