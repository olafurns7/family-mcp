//! packages/session-store/test/storage.test.ts: the store's directory, ancestor, file and ACL
//! checks, and key publication. Each refusal reads no key, takes no lock and creates nothing.

mod common;

use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::*;
use family_store::{
    Cancel, Code, Error, Key, KeyProvider, LocalKeyFileProvider, Publish, SecretRecordOptions,
    StoreCheck, check_secret_store, create_secret_key, with_secret_record, with_secret_store,
};

const E1: &str =
    "This store folder is a link to another place. Replace it with a real folder and start again.";

const E3: &str = "Other users can open this store folder.";

const E4: &str = "Other users can write to a folder above the store.";

const HARD_LINKS: &str =
    "This file has a second name (a hard link). Remove the other name and start again.";

const OWNED_ACL: &str = "Extra sharing permissions (an access control list, set in Finder’s Get Info) let other users in.";

const ANCESTOR_ACL: &str = "Extra sharing permissions (an access control list) on a folder above the store let other users change it. List them with ls -led and remove the entry that allows another user to write.";

const BROKEN_LINK: &str = "A link in a folder above the store is broken, loops back on itself, or leads into a folder you cannot open.";

const TEMPORARY: &str = "0f0e0d0c-0b0a-4908-8706-050403020100";

/// A scratch tree whose ACLs go before it is removed: a deny-delete entry would keep it.
struct Tree(Scratch);

impl Tree {
    fn new() -> Self {
        Self(Scratch::new())
    }

    fn root(&self) -> &Path {
        &self.0.0
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        if cfg!(target_os = "macos") {
            let _ = Command::new("/bin/chmod")
                .args(["-R", "-N"])
                .arg(self.root())
                .status();
        }
    }
}

/// A key file provider that counts reads, so a test can show the preflight never reads it.
struct Counting {
    inner: LocalKeyFileProvider,
    reads: AtomicUsize,
}

impl KeyProvider for Counting {
    fn backend(&self) -> &str {
        self.inner.backend()
    }

    fn key_source(&self) -> &str {
        self.inner.key_source()
    }

    fn key_id(&self) -> &str {
        self.inner.key_id()
    }

    fn get_key(&self, cancel: &Cancel) -> Result<Key, Error> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.inner.get_key(cancel)
    }

    fn create_key(&self, cancel: &Cancel) -> Result<(), Error> {
        self.inner.create_key(cancel)
    }

    fn key_file(&self) -> Option<&Path> {
        self.inner.key_file()
    }
}

/// The macOS layout under `root`: `family-mcp/{keys,test-mcp}`.
struct Layout {
    store: SecretRecordOptions,
    keys: Arc<Counting>,
    key: PathBuf,
}

impl Layout {
    fn new(root: &Path) -> Self {
        let key = root.join("family-mcp/keys/test-mcp.default.key");
        let keys = Arc::new(Counting {
            inner: LocalKeyFileProvider::new(&key),
            reads: AtomicUsize::new(0),
        });
        let store = SecretRecordOptions::new(
            root.join("family-mcp/test-mcp/session.enc"),
            "test-mcp",
            "default",
            "session",
            1,
            keys.clone(),
            1024,
        );
        Self { store, keys, key }
    }

    fn reads(&self) -> usize {
        self.keys.reads.load(Ordering::SeqCst)
    }

    fn marker(&self) -> PathBuf {
        marker_path(&self.store)
    }
}

fn refused<T: std::fmt::Debug>(result: Result<T, Error>, message: &str, path: Option<&Path>) {
    let error = result.expect_err("refused");
    assert_eq!(error.code, Code::UnsafeFile, "{}", error.message);
    assert_eq!(error.message, message);

    if let Some(path) = path {
        assert_eq!(error.path(), Some(path));
    }
}

fn listing(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_owned()];

    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).unwrap() {
            let path = entry.unwrap().path();

            if fs::symlink_metadata(&path).unwrap().is_dir() {
                pending.push(path.clone());
            }
            found.push(path.strip_prefix(root).unwrap().to_owned());
        }
    }
    found.sort();
    found
}

fn names(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn chmod(path: &Path, mode: u32) {
    fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn mkdir(path: &Path, mode: u32) {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
    chmod(path, mode);
}

fn missing() -> StoreCheck {
    StoreCheck { exists: false }
}

fn set_up(layout: &Layout) {
    create_secret_key(&layout.store).unwrap();
    put(&layout.store, "secret").unwrap();
}

#[test]
fn the_preflight_passes_on_a_missing_store_creates_nothing_and_reads_no_key() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    assert_eq!(check_secret_store(&layout.store).unwrap(), missing());
    assert!(names(root).is_empty());
    assert_eq!(layout.reads(), 0);

    // Set up, then the preflight still reads nothing.
    set_up(&layout);
    let reads = layout.reads();
    let before = listing(root);
    assert_eq!(
        check_secret_store(&layout.store).unwrap(),
        StoreCheck { exists: true }
    );
    assert_eq!(layout.reads(), reads);
    assert_eq!(listing(root), before);

    for directory in ["family-mcp", "family-mcp/keys", "family-mcp/test-mcp"] {
        assert_eq!(mode(&root.join(directory)), 0o700);
    }
    for file in [&layout.key, &layout.store.path, &layout.marker()] {
        assert_eq!(mode(file), 0o600);
    }
}

#[test]
fn the_preflight_refuses_unsafe_files_without_reading_the_key() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    set_up(&layout);
    let reads = layout.reads();

    for file in [&layout.key, &layout.store.path, &layout.marker()] {
        chmod(file, 0o644);
        refused(
            check_secret_store(&layout.store),
            "Other users can open this file.",
            Some(file),
        );
        chmod(file, 0o600);

        let alias = root.join("alias");
        fs::hard_link(file, &alias).unwrap();
        refused(check_secret_store(&layout.store), HARD_LINKS, Some(file));
        fs::remove_file(&alias).unwrap();
    }

    let saved = fs::read(&layout.key).unwrap();
    fs::remove_file(&layout.key).unwrap();
    write(&root.join("elsewhere.key"), saved);
    symlink(root.join("elsewhere.key"), &layout.key).unwrap();
    refused(
        check_secret_store(&layout.store),
        "This file is a link to another file. Put the real file here and start again.",
        Some(&layout.key),
    );
    assert_eq!(layout.reads(), reads);
}

#[test]
fn a_store_directory_with_group_or_other_bits_is_refused_and_left_unchanged() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    let records = root.join("family-mcp/test-mcp");
    let keys = root.join("family-mcp/keys");
    mkdir(&records, 0o750);

    refused(check_secret_store(&layout.store), E3, Some(&records));
    refused(
        with_secret_store(&layout.store, |_| Ok::<_, Error>(())),
        E3,
        Some(&records),
    );
    assert_eq!(mode(&records), 0o750);
    assert!(names(&records).is_empty());

    chmod(&records, 0o700);
    mkdir(&keys, 0o750);
    let cancel = Cancel::default();
    refused(layout.keys.get_key(&cancel), E3, Some(&keys));
    refused(layout.keys.create_key(&cancel), E3, Some(&keys));
    refused(create_secret_key(&layout.store), E3, Some(&keys));
    assert!(names(&keys).is_empty());
    assert_eq!(mode(&keys), 0o750);

    // The store root is a store directory too.
    chmod(&keys, 0o700);
    chmod(&root.join("family-mcp"), 0o755);
    refused(
        check_secret_store(&layout.store),
        E3,
        Some(&root.join("family-mcp")),
    );
}

#[test]
fn a_symlinked_store_directory_is_refused() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    for directory in ["family-mcp", "real-records", "real-keys"] {
        mkdir(&root.join(directory), 0o700);
    }
    symlink(root.join("real-records"), root.join("family-mcp/test-mcp")).unwrap();
    symlink(root.join("real-keys"), root.join("family-mcp/keys")).unwrap();
    let cancel = Cancel::default();

    refused(
        with_secret_store(&layout.store, |_| Ok::<_, Error>(())),
        E1,
        Some(&root.join("family-mcp/test-mcp")),
    );
    refused(
        layout.keys.get_key(&cancel),
        E1,
        Some(&root.join("family-mcp/keys")),
    );
    refused(
        layout.keys.create_key(&cancel),
        E1,
        Some(&root.join("family-mcp/keys")),
    );
    assert!(names(&root.join("real-keys")).is_empty());
    assert!(names(&root.join("real-records")).is_empty());
}

#[test]
fn ancestors_that_another_user_could_replace_are_refused_also_above_a_missing_store() {
    let tree = Tree::new();
    let root = tree.root();
    let shared = root.join("shared");
    mkdir(&shared, 0o775);
    let layout = Layout::new(&shared);

    refused(check_secret_store(&layout.store), E4, Some(&shared));
    refused(
        with_secret_store(&layout.store, |_| Ok::<_, Error>(())),
        E4,
        Some(&shared),
    );
    assert!(names(&shared).is_empty());

    // A link above the store is followed: the directory it resolves to is checked too.
    chmod(&shared, 0o755);
    let open = root.join("open");
    mkdir(&open.join("inner"), 0o700);
    chmod(&open, 0o777);
    symlink(open.join("inner"), root.join("alias")).unwrap();
    let aliased = Layout::new(&root.join("alias"));
    refused(
        check_secret_store(&aliased.store),
        E4,
        Some(&fs::canonicalize(&open).unwrap()),
    );

    // Sticky and shared like /tmp: only this user can move the entry below it.
    chmod(&open, 0o1777);
    assert_eq!(check_secret_store(&aliased.store).unwrap(), missing());
}

#[test]
fn every_link_above_the_store_is_followed_also_links_inside_a_links_target() {
    // The written route and the final target are safe; the hop between them is replaceable.
    let outside = Tree::new();
    let tree = Tree::new();
    let root = tree.root();
    let open = outside.root().join("open");
    mkdir(&open, 0o777);
    mkdir(&root.join("safe"), 0o700);
    symlink(root.join("safe"), open.join("hop")).unwrap();
    symlink(open.join("hop"), root.join("alias")).unwrap();
    let layout = Layout::new(&root.join("alias"));
    let real_open = fs::canonicalize(&open).unwrap();
    let cancel = Cancel::default();

    refused(check_secret_store(&layout.store), E4, Some(&real_open));
    refused(
        with_secret_store(&layout.store, |_| Ok::<_, Error>(())),
        E4,
        Some(&real_open),
    );
    refused(layout.keys.create_key(&cancel), E4, Some(&real_open));
    assert!(names(&root.join("safe")).is_empty());

    // The same hop through a relative link.
    symlink("safe", root.join("relative")).unwrap();
    fs::remove_file(open.join("hop")).unwrap();
    symlink(root.join("relative"), open.join("hop")).unwrap();
    refused(check_secret_store(&layout.store), E4, Some(&real_open));

    // Once the hop's directory is safe, the route is.
    chmod(&open, 0o755);
    assert_eq!(check_secret_store(&layout.store).unwrap(), missing());
    create_secret_key(&layout.store).unwrap();
    assert_eq!(names(&root.join("safe")), ["family-mcp"]);

    // A loop of links is refused, not followed forever.
    symlink(root.join("loop-b"), root.join("loop-a")).unwrap();
    symlink(root.join("loop-a"), root.join("loop-b")).unwrap();
    refused(
        check_secret_store(&Layout::new(&root.join("loop-a")).store),
        BROKEN_LINK,
        None,
    );
    // chmod -R cannot pass a loop on cleanup.
    fs::remove_file(root.join("loop-a")).unwrap();
    fs::remove_file(root.join("loop-b")).unwrap();
}

#[cfg(target_os = "macos")]
fn acl(operation: &str, entry: &str, path: &Path) {
    let status = Command::new("/bin/chmod")
        .args([operation, entry])
        .arg(path)
        .status()
        .unwrap();
    assert!(status.success());
}

#[cfg(target_os = "macos")]
#[test]
fn macos_acls_that_grant_other_users_access_are_refused_deny_entries_pass() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    set_up(&layout);
    let records = root.join("family-mcp/test-mcp");

    acl("+a", "everyone deny delete", &records);
    assert!(check_secret_store(&layout.store).unwrap().exists);

    for path in [&layout.key, &layout.store.path, &records] {
        acl("+a", "everyone allow read", path);
        refused(check_secret_store(&layout.store), OWNED_ACL, Some(path));
        acl("-a", "everyone allow read", path);
    }

    acl("+a", "everyone allow add_file,delete_child", root);
    refused(check_secret_store(&layout.store), ANCESTOR_ACL, Some(root));
    refused(
        with_secret_store(&layout.store, |_| Ok::<_, Error>(())),
        ANCESTOR_ACL,
        Some(root),
    );
    acl("-a", "everyone allow add_file,delete_child", root);

    // A read-only grant above the store cannot replace anything below it.
    acl("+a", "everyone allow list,search", root);
    assert!(check_secret_store(&layout.store).unwrap().exists);

    // This user's own grant above the store changes nothing another user can do.
    let me = String::from_utf8(
        Command::new("/usr/bin/id")
            .arg("-un")
            .output()
            .unwrap()
            .stdout,
    )
    .unwrap();
    acl(
        "+a",
        &format!("{} allow add_file,delete_child", me.trim()),
        root,
    );
    assert!(check_secret_store(&layout.store).unwrap().exists);
}

#[cfg(target_os = "macos")]
/// Runs `test` of this file in a child with `variables`, which a test cannot set in its own
/// process; the child's assertions decide.
fn in_child(test: &str, variables: &[(&str, &Path)]) {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command.args(["--exact", test, "--ignored", "--nocapture"]);

    for (name, value) in variables {
        command.env(name, value);
    }
    let output = command.output().unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        output.status.success() && stdout.contains("1 passed"),
        "{stdout}{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(target_os = "macos")]
#[test]
fn a_slow_acl_listing_is_waited_for_and_a_failed_one_is_still_refused() {
    let tree = Tree::new();
    let root = tree.root();
    let executable = root.join("ls");
    let log = root.join("ls.log");
    // The child gets only PATH and HOME, so the script carries its own paths.
    let install = |body: &str| {
        let _ = fs::remove_file(&executable);
        fs::write(
            &executable,
            format!("#!/bin/sh\necho run >> '{}'\n{body}\n", log.display()),
        )
        .unwrap();
        chmod(&executable, 0o700);
    };
    let directory = |name: &str| root.join(name).join("family-mcp/test-mcp/session.enc");

    install("exit 1");
    in_child(
        "list_with_the_fake_ls",
        &[
            ("FAMILY_STORE_TEST_RECORD", &directory("failed")),
            ("FAMILY_MCP_STORE_TEST_LS", &executable),
        ],
    );

    // Longer than the 5 s bound that a loaded CI runner once hit with a working ls.
    install("sleep 6\nexec /bin/ls \"$@\"");
    in_child(
        "list_with_the_fake_ls",
        &[
            ("FAMILY_STORE_TEST_RECORD", &directory("slow")),
            ("FAMILY_MCP_STORE_TEST_LS", &executable),
        ],
    );
    assert_eq!(fs::read_to_string(&log).unwrap(), "run\nrun\n");
}

/// `exit 1` refuses with IO; any other fake must pass. Run by the test above.
#[test]
#[ignore = "run by a_slow_acl_listing_is_waited_for_and_a_failed_one_is_still_refused"]
fn list_with_the_fake_ls() {
    let record = PathBuf::from(std::env::var_os("FAMILY_STORE_TEST_RECORD").unwrap());
    let ls = PathBuf::from(std::env::var_os("FAMILY_MCP_STORE_TEST_LS").unwrap());
    let failing = fs::read_to_string(&ls).unwrap().contains("exit 1");
    let store = SecretRecordOptions::new(
        &record,
        "test-mcp",
        "default",
        "session",
        1,
        Arc::new(family_store::FakeKeyProvider::new(Some(KEY))),
        1024,
    );
    let outcome = with_secret_store(&store, |_| Ok::<_, Error>(()));

    if failing {
        assert_eq!(code(outcome), Some(Code::Io));
    } else {
        outcome.unwrap();
    }
}

#[test]
fn key_creation_never_replaces_a_key_and_leaves_no_temporary_or_partial_key() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    let other = LocalKeyFileProvider::new(&layout.key);
    let cancel = Cancel::default();
    let results = std::thread::scope(|scope| {
        let first = scope.spawn(|| layout.keys.create_key(&cancel));
        let second = scope.spawn(|| other.create_key(&cancel));
        [first.join().unwrap(), second.join().unwrap()]
    });

    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let failure = results.into_iter().find_map(Result::err).unwrap();
    assert_eq!(
        failure.message,
        "A store key already exists; it is never replaced."
    );
    let info = fs::metadata(&layout.key).unwrap();
    assert_eq!(info.len(), 32);
    assert_eq!(mode(&layout.key), 0o600);
    assert_eq!(std::os::unix::fs::MetadataExt::nlink(&info), 1);
    assert_eq!(
        names(&root.join("family-mcp/keys")),
        ["test-mcp.default.key"]
    );

    let bytes = fs::read(&layout.key).unwrap();
    assert!(layout.keys.create_key(&cancel).is_err());
    assert_eq!(fs::read(&layout.key).unwrap(), bytes);
}

fn nlink(path: &Path) -> u64 {
    std::os::unix::fs::MetadataExt::nlink(&fs::symlink_metadata(path).unwrap())
}

#[test]
fn a_crash_at_any_key_publication_step_restarts_cleanly_through_the_preflight() {
    for step in ["written", "linked"] {
        let tree = Tree::new();
        let root = tree.root();
        let layout = Layout::new(root);
        let status = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "publish_a_key_until_killed", "--ignored"])
            .env("FAMILY_STORE_TEST_KEY", &layout.key)
            .env("FAMILY_STORE_TEST_STEP", step)
            .output()
            .unwrap()
            .status;
        assert_eq!(
            std::os::unix::process::ExitStatusExt::signal(&status),
            Some(9),
            "{step}"
        );
        let keys = root.join("family-mcp/keys");
        let cancel = Cancel::default();

        if step == "written" {
            // No key yet: the temporary never became one, and setup simply runs again.
            assert_eq!(names(&keys).len(), 1);
            assert!(!check_secret_store(&layout.store).unwrap().exists);
            assert_eq!(
                code(layout.keys.get_key(&cancel)),
                Some(Code::StoreUnavailable)
            );
            layout.keys.create_key(&cancel).unwrap();
        } else {
            // The whole key, with the temporary as its second name.
            assert_eq!(names(&keys).len(), 2);
            assert_eq!(nlink(&layout.key), 2);

            // Concurrent restarts all pass the preflight while the second name is still there.
            std::thread::scope(|scope| {
                let checks: Vec<_> = (0..4)
                    .map(|_| scope.spawn(|| check_secret_store(&layout.store)))
                    .collect();
                for check in checks {
                    check.join().unwrap().unwrap();
                }
            });
            assert_eq!(layout.keys.get_key(&cancel).unwrap().bytes().len(), 32);
            assert_eq!(names(&keys), ["test-mcp.default.key"]);
        }
        assert_eq!(nlink(&layout.key), 1);
        assert_eq!(check_secret_store(&layout.store).unwrap(), missing());
        put(&layout.store, "secret").unwrap();
    }
}

/// Creates the key and kills itself with SIGKILL right after the named step.
#[test]
#[ignore = "run by a_crash_at_any_key_publication_step_restarts_cleanly_through_the_preflight"]
fn publish_a_key_until_killed() {
    let key = PathBuf::from(std::env::var_os("FAMILY_STORE_TEST_KEY").unwrap());
    let step = match std::env::var("FAMILY_STORE_TEST_STEP").as_deref() {
        Ok("written") => Publish::Written,
        _ => Publish::Linked,
    };
    LocalKeyFileProvider::new(key)
        .with_on_publish(move |reached| {
            if reached == step {
                let _ = rustix::process::kill_process(
                    rustix::process::getpid(),
                    rustix::process::Signal::KILL,
                );
                // Another thread may take the signal; this one must not reach the next step.
                loop {
                    std::thread::park();
                }
            }
        })
        .create_key(&Cancel::default())
        .unwrap();
}

#[test]
fn only_the_stores_own_temporary_of_the_same_key_is_recovered() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    let cancel = Cancel::default();
    layout.keys.create_key(&cancel).unwrap();

    // A hard link under any other name stays refused.
    let stray = root.join("family-mcp/keys/copy.key");
    fs::hard_link(&layout.key, &stray).unwrap();
    refused(
        check_secret_store(&layout.store),
        HARD_LINKS,
        Some(&layout.key),
    );
    let error = layout.keys.get_key(&cancel).unwrap_err();
    assert_eq!(error.message, HARD_LINKS);
    fs::remove_file(&stray).unwrap();

    // A temporary name of another file is not the key's second name.
    let mut name = layout.key.clone().into_os_string();
    name.push(format!(".{TEMPORARY}.tmp"));
    let temporary = PathBuf::from(name);
    write(&temporary, "other");
    let outside = root.join("outside.key");
    fs::hard_link(&layout.key, &outside).unwrap();
    refused(
        check_secret_store(&layout.store),
        HARD_LINKS,
        Some(&layout.key),
    );
    assert_eq!(text(&temporary), "other");
    fs::remove_file(&outside).unwrap();
    fs::remove_file(&temporary).unwrap();

    // The recognised second name goes, and the key keeps its bytes.
    let bytes = fs::read(&layout.key).unwrap();
    fs::hard_link(&layout.key, &temporary).unwrap();
    check_secret_store(&layout.store).unwrap();
    assert_eq!(nlink(&temporary), 2);
    assert_eq!(
        layout.keys.get_key(&cancel).unwrap().bytes().as_slice(),
        bytes.as_slice()
    );
    assert_eq!(
        names(&root.join("family-mcp/keys")),
        ["test-mcp.default.key"]
    );
}

#[test]
fn the_secret_store_uses_the_same_checks() {
    let tree = Tree::new();
    let root = tree.root();
    let layout = Layout::new(root);
    set_up(&layout);
    let shared = with_secret_record(&layout.store, |current| {
        Ok::<_, Error>(current.map(str::to_owned))
    });
    assert_eq!(shared.unwrap().as_deref(), Some("secret"));
    chmod(&layout.store.path, 0o640);
    refused(
        with_secret_record(&layout.store, |_| Ok::<_, Error>(None)),
        "Other users can open this file. Make it owner-only with chmod 600.",
        None,
    );
}
