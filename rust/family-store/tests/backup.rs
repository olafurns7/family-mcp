//! packages/session-store/test/backup.test.ts: the Time Machine exclusion of the store
//! directories, confirmed before any secret is written in them. The fake tmutil is set through
//! the environment, which a test cannot change in its own process, so each case runs in a child
//! of this test binary.

mod common;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use common::*;
use family_store::{
    Cancel, Code, Error, LocalKeyFileProvider, SecretRecordOptions, TEST_TMUTIL,
    check_secret_store, create_secret_key, with_secret_store,
};

const NOT_EXCLUDED: &str = "Time Machine did not confirm that it skips this store folder. Run the command below; then tmutil isexcluded on the same folder should say [Excluded].";

const ATTRIBUTE: &str = "com.apple.metadata:com_apple_backup_excludeItem";

const ROOT: &str = "FAMILY_STORE_TEST_ROOT";

const MODE: &str = "FAMILY_STORE_TEST_MODE";

/// A fake tmutil that logs each call with its stdin state and the directory's entries at that
/// moment. `isexcluded` reports a directory excluded when it carries the real exclusion attribute
/// (unless the mode ignores it) or `addexclusion` named it before. It runs with only PATH and
/// HOME, so its own paths are written into it.
fn fake_tmutil(directory: &Path, mode: &str) -> PathBuf {
    let log = directory.join("tmutil.log");
    let state = directory.join("tmutil.state");
    let executable = directory.join("tmutil");
    let (log, state) = (log.display(), state.display());
    fs::write(directory.join("tmutil.state"), "").unwrap();
    fs::write(
        &executable,
        format!(
            r#"#!/bin/sh
if read -r line; then input=data; else input=eof; fi
echo "$1 stdin=$input" >> '{log}'
command=$1
shift
for path in "$@"; do echo "  $path: $(ls -A "$path" | tr '\n' ' ')" >> '{log}'; done
case {mode} in
  fails) exit 1 ;;
  hangs) sleep 60 ;;
esac
case $command in
  addexclusion) for path in "$@"; do echo "$path" >> '{state}'; done ;;
  isexcluded)
    for path in "$@"; do
      if [ {mode} = lies ]; then excluded=no
      elif grep -qxF "$path" '{state}'; then excluded=yes
      elif [ {mode} = works ] && /usr/bin/xattr -p {ATTRIBUTE} "$path" >/dev/null 2>&1; then excluded=yes
      else excluded=no; fi
      if [ $excluded = yes ]; then echo "[Excluded]    $path"; else echo "[Included]    $path"; fi
    done ;;
esac
"#
        ),
    )
    .unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o700)).unwrap();
    executable
}

fn calls(directory: &Path) -> Vec<String> {
    fs::read_to_string(directory.join("tmutil.log"))
        .unwrap_or_default()
        .lines()
        .map(str::to_owned)
        .collect()
}

fn attribute(path: &Path) -> bool {
    Command::new("/usr/bin/xattr")
        .args(["-p", ATTRIBUTE])
        .arg(path)
        .output()
        .unwrap()
        .status
        .success()
}

fn layout(root: &Path) -> SecretRecordOptions {
    SecretRecordOptions::new(
        root.join("family-mcp/test-mcp/session.enc"),
        "test-mcp",
        "default",
        "session",
        1,
        Arc::new(LocalKeyFileProvider::new(
            root.join("family-mcp/keys/test-mcp.key"),
        )),
        1024,
    )
}

fn names(directory: &Path) -> Vec<String> {
    fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

fn not_excluded<T: std::fmt::Debug>(result: Result<T, Error>) {
    let error = result.expect_err("refused");
    assert_eq!(error.code, Code::UnsafeFile);
    assert_eq!(error.message, NOT_EXCLUDED);
    assert_eq!(error.fix(), Some("tmutil addexclusion"));
}

/// Runs the ignored case `test` in a child with the fake tmutil in `mode` (none for `None`).
fn in_child(test: &str, mode: &str, tmutil: Option<&str>) {
    let scratch = Scratch::new();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args(["--exact", test, "--ignored", "--nocapture"])
        .env(ROOT, &scratch.0)
        .env(MODE, mode)
        .env_remove(TEST_TMUTIL);

    if let Some(mode) = tmutil {
        command.env(TEST_TMUTIL, fake_tmutil(&scratch.0, mode));
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{mode}: {stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn child() -> (PathBuf, String) {
    (
        PathBuf::from(std::env::var_os(ROOT).unwrap()),
        std::env::var(MODE).unwrap(),
    )
}

#[cfg(target_os = "macos")]
#[test]
fn setup_excludes_each_directory_before_any_secret_is_written_in_it() {
    for mode in ["works", "ignores-attribute"] {
        in_child("setup_excludes", mode, Some(mode));
    }
}

#[test]
#[ignore = "run by setup_excludes_each_directory_before_any_secret_is_written_in_it"]
fn setup_excludes() {
    let (directory, mode) = child();
    let home = directory.join("home");
    let store = layout(&home);
    let records = home.join("family-mcp/test-mcp");
    let keys = home.join("family-mcp/keys");

    create_secret_key(&store).unwrap();
    put(&store, "secret").unwrap();
    assert!(attribute(&records));
    assert!(attribute(&keys));

    // The attribute is confirmed by isexcluded; addexclusion runs only when that fails. Each
    // directory is still empty when it is confirmed, and stdin is closed.
    let confirmed = |path: &Path| {
        let listed = format!("  {}: ", path.display());
        let mut lines = vec![
            "isexcluded stdin=eof".to_owned(),
            listed.clone(),
            "isexcluded stdin=eof".to_owned(),
            listed.clone(),
        ];

        if mode != "works" {
            lines.extend([
                "addexclusion stdin=eof".to_owned(),
                listed.clone(),
                "isexcluded stdin=eof".to_owned(),
                listed,
            ]);
        }
        lines
    };
    assert_eq!(
        calls(&directory),
        [confirmed(&records), confirmed(&keys)].concat()
    );

    // A start confirms again; a lost exclusion is applied again before the server serves.
    let removed = Command::new("/usr/bin/xattr")
        .args(["-d", ATTRIBUTE])
        .arg(&records)
        .status()
        .unwrap();
    assert!(removed.success());
    check_secret_store(&store).unwrap();
    // The fallback fake remembers addexclusion by path, so only the attribute fake loses it.
    assert_eq!(attribute(&records), mode == "works");
    assert_eq!(
        calls(&directory)
            .iter()
            .rfind(|line| !line.starts_with(' '))
            .map(String::as_str),
        Some("isexcluded stdin=eof")
    );

    // A directory that is removed and made again is excluded again.
    fs::remove_dir_all(&records).unwrap();
    with_secret_store(&store, |_| Ok::<_, Error>(())).unwrap();
    assert_eq!(attribute(&records), mode == "works");
}

#[cfg(target_os = "macos")]
#[test]
fn a_store_that_cannot_be_excluded_is_refused_before_any_secret() {
    for mode in ["fails", "lies"] {
        in_child("cannot_be_excluded", mode, Some(mode));
    }
}

#[test]
#[ignore = "run by a_store_that_cannot_be_excluded_is_refused_before_any_secret"]
fn cannot_be_excluded() {
    let (directory, _) = child();
    let home = directory.join("home");
    let store = layout(&home);

    not_excluded(create_secret_key(&store));
    not_excluded(store.keys.create_key(&Cancel::default()));
    // The record directory was made for the exclusion, and nothing went into it.
    assert!(names(&home.join("family-mcp/test-mcp")).is_empty());
    assert!(names(&home.join("family-mcp/keys")).is_empty());
}

#[cfg(target_os = "macos")]
#[test]
fn a_hung_tmutil_is_abandoned_within_its_bound() {
    in_child("hung", "hangs", Some("hangs"));
}

#[test]
#[ignore = "run by a_hung_tmutil_is_abandoned_within_its_bound"]
fn hung() {
    let (directory, _) = child();
    let started = std::time::Instant::now();

    let served = with_secret_store(&layout(&directory.join("home")), |_| -> Result<(), Error> {
        panic!("a store that is not excluded is never served")
    });
    not_excluded(served);
    assert!(started.elapsed().as_millis() < 7000);
}

#[test]
fn no_tmutil_runs_off_macos_or_under_the_test_seam_without_a_fake() {
    let fake = (!cfg!(target_os = "macos")).then_some("works");
    in_child("no_tmutil", "works", fake);
}

#[test]
#[ignore = "run by no_tmutil_runs_off_macos_or_under_the_test_seam_without_a_fake"]
fn no_tmutil() {
    let (directory, _) = child();
    let store = layout(&directory.join("home"));

    create_secret_key(&store).unwrap();
    put(&store, "secret").unwrap();
    check_secret_store(&store).unwrap();
    assert!(calls(&directory).is_empty());
    assert!(!(cfg!(target_os = "macos") && attribute(&directory.join("home/family-mcp/keys"))));
}
