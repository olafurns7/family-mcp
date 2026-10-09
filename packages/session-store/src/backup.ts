import { isAbsolute } from 'node:path';

import { TEST_TMUTIL, testSeam } from './seam.js';
import { runBounded } from './spawn.js';
import { StoreRefusal, lstatOrMissing } from './storage.js';

const TMUTIL = '/usr/bin/tmutil';

const XATTR = '/usr/bin/xattr';

/*
 * The sticky exclusion is this attribute; `tmutil addexclusion` (no -p) and Apple's
 * NSURLIsExcludedFromBackupKey write exactly this binary plist, the string `com.apple.backupd`.
 * It is written with xattr(1) because `tmutil addexclusion` took 11 s per call on macOS 27.0.1,
 * while `tmutil isexcluded`, which stays the authority, answers in about 0.1 s.
 */
const EXCLUDE_ITEM = 'com.apple.metadata:com_apple_backup_excludeItem';

const BACKUPD_PLIST =
  '62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C';

const TIMEOUT_MS = 5000;

// Only the fallback: measured at 11 s per call, so it gets room beyond that.
const ADD_TIMEOUT_MS = 20_000;

const NOT_EXCLUDED =
  'Time Machine did not confirm that it skips this store folder. Run the command below; then tmutil isexcluded on the same folder should say [Excluded].';

/** The refusal for a directory Time Machine does not confirm as excluded. */
function notExcludedRefusal(path: string): StoreRefusal {
  return new StoreRefusal(NOT_EXCLUDED, path, { fix: 'tmutil addexclusion' });
}

// Directories verified in this process, by inode: a recreated directory is excluded again.
const verified = new Map<string, string>();

/** The tmutil to run: Apple's on macOS, a test's fake under the test seam, else none. */
function tmutil(): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  if (!testSeam()) return TMUTIL;
  const fake = process.env[TEST_TMUTIL];

  return fake !== undefined && isAbsolute(fake) ? fake : undefined;
}

/**
 * macOS: give each existing directory the sticky Time Machine exclusion and confirm it with
 * `tmutil isexcluded`, before any secret is written below it: the attribute first, then
 * `tmutil addexclusion` (no root) only for a directory that is still not confirmed.
 * Anything short of a confirmed exclusion is a StoreRefusal. Every tmutil run is bounded. A
 * directory confirmed in this process is skipped while its inode stays the same, unless `recheck`
 * asks again, as a start does. Other platforms have no standard and exclude nothing.
 */
export async function excludeFromBackups(
  directories: readonly string[],
  options: { recheck?: boolean | undefined } = {},
): Promise<void> {
  const executable = tmutil();

  if (executable === undefined) return;
  const pending: { path: string; stamp: string }[] = [];

  for (const path of directories) {
    const info = await lstatOrMissing(path);

    if (info === undefined) continue;
    const stamp = `${info.dev}:${info.ino}`;

    if (options.recheck || verified.get(path) !== stamp) pending.push({ path, stamp });
  }

  if (pending.length === 0) return;
  const paths = pending.map(({ path }) => path);
  const included = await notExcluded(executable, paths);

  if (included.length > 0) {
    // Its exit status does not matter: isexcluded decides.
    await runBounded(XATTR, ['-wx', EXCLUDE_ITEM, BACKUPD_PLIST, ...included], {
      timeoutMs: TIMEOUT_MS,
      maxBytes: 65_536,
    });
    const still = await notExcluded(executable, included);

    if (still.length > 0) {
      const added = await runBounded(executable, ['addexclusion', ...still], {
        timeoutMs: ADD_TIMEOUT_MS,
        maxBytes: 65_536,
      });

      const left = added.status === 0 ? await notExcluded(executable, still) : still;

      if (left.length > 0) throw notExcludedRefusal(left[0] ?? '');
    }
  }

  for (const { path, stamp } of pending) verified.set(path, stamp);
}

/** The paths `tmutil isexcluded` does not report as `[Excluded]`, in order. */
async function notExcluded(executable: string, paths: string[]): Promise<string[]> {
  const run = await runBounded(executable, ['isexcluded', ...paths], {
    timeoutMs: TIMEOUT_MS,
    maxBytes: 1_048_576,
  });

  const lines = run.stdout.split('\n').filter((line) => line !== '');

  if (run.status !== 0 || lines.length !== paths.length) throw notExcludedRefusal(paths[0] ?? '');

  return paths.filter((_, index) => !lines[index]?.startsWith('[Excluded]'));
}
