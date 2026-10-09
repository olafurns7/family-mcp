import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, parse, sep } from 'node:path';

import { SessionStoreError, systemErrorCode } from './errors.js';
import { runBounded } from './spawn.js';

/** A refused store path. The message stays path-free; `path` is for the owner's terminal only. */
export class StoreRefusal extends SessionStoreError {
  constructor(
    message: string,
    readonly path: string,
    options?: ErrorOptions,
  ) {
    super('UNSAFE_FILE', message, options);
    this.name = 'StoreRefusal';
  }
}

export type StoreStat = Pick<Stats, 'mode' | 'uid' | 'nlink'> & {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
};

const NOT_A_DIRECTORY = 'The directory path is not a directory.';

const STICKY = 0o1000;

/** A directory the store owns (keys/, a server's directory, family-mcp/): 0700, ours, real. */
export function ownedDirectoryProblem(info: StoreStat, uid: number): string | undefined {
  if (info.isSymbolicLink()) return 'The store directory is a symbolic link; use a real directory.';

  if (!info.isDirectory()) return NOT_A_DIRECTORY;

  if (info.uid !== uid) return 'The store directory is owned by another user.';

  if ((info.mode & 0o077) !== 0)
    return 'The store directory is accessible to other users; use owner-only permissions (chmod 700).';

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

  if ((info.mode & 0o022) !== 0 && !sticky)
    return 'A directory above the store is writable by other users; remove their write permission (chmod go-w).';

  return undefined;
}

/**
 * A key, record or marker file: the same rules and texts as `readPrivateBytes`. `links` is the
 * number of names it may have, more than one only for a recognised interrupted key publication.
 */
export function privateFileProblem(
  info: StoreStat,
  uid: number | undefined,
  links = 1,
): string | undefined {
  if (info.isSymbolicLink()) return 'The path is a symbolic link; use a regular file.';

  if (!info.isFile()) return 'The path is not a regular file.';

  if (info.nlink > links) return 'Files with hard links are not supported.';

  if (process.platform === 'win32') return undefined;

  if ((info.mode & 0o077) !== 0)
    return 'The file is accessible to other users; use owner-only permissions (chmod 600).';

  if (uid !== undefined && info.uid !== uid) return 'The file is owned by another user.';

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

type Checked = { path: string; info: Stats; role: AclRole };

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

    if (problem !== undefined) throw new StoreRefusal(problem, directory);
    checked.push({ path: directory, info, role: 'owned' });
  }

  for (const file of options.files ?? []) {
    const info = await lstatOrMissing(file);

    if (info === undefined) continue;
    const linked = info.isFile() && info.nlink === 2 && (await options.allowLink?.(file, info));
    const problem = privateFileProblem(info, uid, linked ? 2 : 1);

    if (problem !== undefined) throw new StoreRefusal(problem, file);
    checked.push({ path: file, info, role: 'owned' });
  }

  if (process.platform === 'darwin') await checkAcls(checked);
}

/**
 * The existing directories above `directory`, each checked: first along the path as written,
 * where a symbolic link must be this user's or root's, then along the resolved path.
 */
async function ancestorsOf(directory: string, uid: number): Promise<Checked[]> {
  const found: Checked[] = [];
  const written = prefixes(dirname(directory));
  let deepest: string | undefined;

  for (const [index, path] of written.entries()) {
    const info = await lstatOrMissing(path);

    if (info === undefined) break;
    deepest = path;

    if (info.isSymbolicLink()) {
      if (info.uid !== uid && info.uid !== 0)
        throw new StoreRefusal('A directory above the store is owned by another user.', path);
      continue;
    }

    const child = written[index + 1] ?? directory;
    const problem = ancestorProblem(info, uid, (await lstatOrMissing(child))?.uid);

    if (problem !== undefined) throw new StoreRefusal(problem, path);
    found.push({ path, info, role: 'ancestor' });
  }

  if (deepest === undefined) return found;
  let resolved: string;

  try {
    resolved = await realpath(deepest);
  } catch (error) {
    throw new StoreRefusal('Cannot resolve a directory above the store.', deepest, {
      cause: error,
    });
  }

  const route = prefixes(resolved);

  for (const [index, path] of route.entries()) {
    if (found.some((entry) => entry.path === path)) continue;
    const info = await lstatOrMissing(path);

    // The resolved route has no links; a component that vanished is a race, refused next time.
    if (info === undefined) break;
    const child = route[index + 1] ?? directory;
    const problem = ancestorProblem(info, uid, (await lstatOrMissing(child))?.uid);

    if (problem !== undefined) throw new StoreRefusal(problem, path);
    found.push({ path, info, role: 'ancestor' });
  }

  return found;
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

/** macOS keeps ACLs apart from the mode bits; `ls -le` is the only reader without a native API. */
async function checkAcls(checked: readonly Checked[]): Promise<void> {
  const stamp = ({ path, info }: Checked) =>
    `${path}\0${info.dev}:${info.ino}:${info.ctimeMs}:${info.mode}`;

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

    if (problem !== undefined) throw new StoreRefusal(problem, entry.path);
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
  return role === 'owned'
    ? 'The store path grants access to other users through an access control list; remove it (chmod -N).'
    : 'A directory above the store lets other users change it through an access control list; remove that entry (chmod -a).';
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
