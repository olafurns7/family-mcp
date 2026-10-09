use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use crate::errors::{Error, Result};
use crate::seam::{TEST_TMUTIL, fake_executable, test_seam};
use crate::spawn::run_bounded;
use crate::storage::lstat_or_missing;

const TMUTIL: &str = "/usr/bin/tmutil";

/// The sticky exclusion is this attribute; `tmutil addexclusion` (no -p) and Apple's
/// NSURLIsExcludedFromBackupKey write exactly this binary plist, the string `com.apple.backupd`.
/// It is written directly because `tmutil addexclusion` took 11 s per call on macOS 27.0.1, while
/// `tmutil isexcluded`, which stays the authority, answers in about 0.1 s.
pub(crate) const EXCLUDE_ITEM: &str = "com.apple.metadata:com_apple_backup_excludeItem";

pub(crate) const BACKUPD_PLIST: &[u8] = b"bplist00_\x10\x11com.apple.backupd\x08\0\0\0\0\0\0\x01\x01\0\0\0\0\0\0\0\x01\0\0\0\0\0\0\0\0\0\0\0\0\0\0\0\x1c";

const TIMEOUT: Duration = Duration::from_secs(5);

// Only the fallback: measured at 11 s per call, so it gets room beyond that.
const ADD_TIMEOUT: Duration = Duration::from_secs(20);

const NOT_EXCLUDED: &str = "Time Machine did not confirm that it skips this store folder. Run the command below; then tmutil isexcluded on the same folder should say [Excluded].";

/// The refusal for a directory Time Machine does not confirm as excluded.
fn not_excluded_refusal(path: &Path) -> Error {
    Error::refusal(NOT_EXCLUDED, path, Some("tmutil addexclusion"))
}

// Directories verified in this process, by inode: a recreated directory is excluded again.
static VERIFIED: Mutex<BTreeMap<PathBuf, (u64, u64)>> = Mutex::new(BTreeMap::new());

/// The tmutil to run: Apple's on macOS, a test's fake under the test seam, else none.
fn tmutil() -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }

    if !test_seam() {
        return Some(PathBuf::from(TMUTIL));
    }
    fake_executable(TEST_TMUTIL)
}

/// macOS: give each existing directory the sticky Time Machine exclusion and confirm it with
/// `tmutil isexcluded`, before any secret is written below it: the attribute first, then
/// `tmutil addexclusion` (no root) only for a directory that is still not confirmed. Anything
/// short of a confirmed exclusion is a refusal. Every tmutil run is bounded. A directory confirmed
/// in this process is skipped while its inode stays the same, unless `recheck` asks again, as a
/// start does. Other platforms have no standard and exclude nothing.
pub(crate) fn exclude_from_backups(directories: &[&Path], recheck: bool) -> Result<()> {
    let Some(executable) = tmutil() else {
        return Ok(());
    };
    let mut pending = Vec::new();

    for path in directories {
        let Some(info) = lstat_or_missing(path)? else {
            continue;
        };
        let stamp = (info.dev(), info.ino());
        let known = VERIFIED
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(*path)
            == Some(&stamp);

        if recheck || !known {
            pending.push((path.to_path_buf(), stamp));
        }
    }

    if pending.is_empty() {
        return Ok(());
    }
    let paths: Vec<PathBuf> = pending.iter().map(|(path, _)| path.clone()).collect();
    let included = not_excluded(&executable, &paths)?;

    if !included.is_empty() {
        // Its outcome does not matter: isexcluded decides.
        for path in &included {
            let _ = rustix::fs::setxattr(
                path,
                EXCLUDE_ITEM,
                BACKUPD_PLIST,
                rustix::fs::XattrFlags::empty(),
            );
        }
        let still = not_excluded(&executable, &included)?;

        if !still.is_empty() {
            let mut args = vec![OsStr::new("addexclusion")];
            args.extend(still.iter().map(|path| path.as_os_str()));
            let added = run_bounded(&executable, &args, ADD_TIMEOUT, 65_536);
            let left = match added.status {
                Some(0) => not_excluded(&executable, &still)?,
                _ => still,
            };

            if let Some(first) = left.first() {
                return Err(not_excluded_refusal(first));
            }
        }
    }
    VERIFIED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .extend(pending);
    Ok(())
}

/// The paths `tmutil isexcluded` does not report as `[Excluded]`, in order.
fn not_excluded(executable: &Path, paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut args = vec![OsStr::new("isexcluded")];
    args.extend(paths.iter().map(|path| path.as_os_str()));
    let run = run_bounded(executable, &args, TIMEOUT, 1_048_576);
    let lines: Vec<&str> = run
        .stdout
        .split('\n')
        .filter(|line| !line.is_empty())
        .collect();

    if run.status != Some(0) || lines.len() != paths.len() {
        return Err(not_excluded_refusal(&paths[0]));
    }
    Ok(paths
        .iter()
        .zip(lines)
        .filter(|(_, line)| !line.starts_with("[Excluded]"))
        .map(|(path, _)| path.clone())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_attribute_is_the_plist_tmutil_writes() {
        // The TypeScript package's hex, which equals tmutil's own attribute.
        let hex = "62706C69737430305F1011636F6D2E6170706C652E6261636B75706408000000000000010100000000000000010000000000000000000000000000001C";
        let bytes: Vec<u8> = (0..hex.len())
            .step_by(2)
            .map(|at| u8::from_str_radix(&hex[at..at + 2], 16).unwrap())
            .collect();
        assert_eq!(BACKUPD_PLIST, bytes.as_slice());
        assert_eq!(BACKUPD_PLIST.len(), 61);
    }
}
