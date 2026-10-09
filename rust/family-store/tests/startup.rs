//! packages/session-store/test/startup.test.ts: the server CLI's preflight output, and the
//! leftovers of an earlier layout. Where the TypeScript case spies on `stat` to save during the
//! check, this one pauses the check with the `test-seam` feature's `after_identity`.

mod common;

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::{DirBuilderExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::rc::Rc;
use std::sync::Arc;

use common::*;
use family_store::{
    Code, Error, LocalKeyFileProvider, SecretRecordOptions, after_identity, create_secret_key,
    read_secret_record, startup_check, with_secret_store,
};

fn store(root: &Path, retired: &[PathBuf]) -> SecretRecordOptions {
    SecretRecordOptions {
        retired: retired.to_vec(),
        ..SecretRecordOptions::new(
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
}

fn check(store: impl FnOnce() -> Result<SecretRecordOptions, Error>) -> (bool, String) {
    let mut text = String::new();
    let passed = startup_check("test-mcp", "test-mcp auth login", store, &mut |line| {
        text.push_str(line)
    })
    .unwrap();
    (passed, text)
}

fn quote(path: &Path) -> String {
    format!("'{}'", path.display().to_string().replace('\'', r"'\''"))
}

fn mkdir(path: &Path) {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
        .unwrap();
}

fn unreadable(path: &Path) {
    fs::write(path, "x").unwrap();
    fs::set_permissions(path, fs::Permissions::from_mode(0o000)).unwrap();
}

fn held_exists(options: &SecretRecordOptions) -> bool {
    with_secret_store(options, |held| held.exists()).unwrap()
}

#[test]
fn an_unsafe_store_gets_the_path_and_the_exact_command_that_fixes_it() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    // A space and a quote in the path, as in Application Support: the commands still paste.
    let base = root.join("Owner's Support");
    let records = base.join("family-mcp/test-mcp");
    let quoted = quote(&records);
    mkdir(&records);
    fs::set_permissions(&records, fs::Permissions::from_mode(0o750)).unwrap();

    assert_eq!(
        check(|| Ok(store(&base, &[]))),
        (
            false,
            [
                "test-mcp: cannot start. Other users can open this store folder.".to_owned(),
                format!("  Path: {quoted}"),
                format!("  Fix:  chmod 700 {quoted}"),
                String::new(),
            ]
            .join("\n")
        )
    );
    assert_eq!(fs::read_dir(&records).unwrap().count(), 0);
    let fixed = Command::new("/bin/sh")
        .args(["-c", &format!("chmod 700 {quoted} && echo done")])
        .output()
        .unwrap();
    assert_eq!(String::from_utf8_lossy(&fixed.stdout), "done\n");

    // A refusal without a one-line fix names only the path.
    mkdir(&base.join("family-mcp/keys"));
    let key = base.join("family-mcp/keys/test-mcp.key");
    write(&key, [0; 32]);
    fs::hard_link(&key, root.join("second-name")).unwrap();
    assert_eq!(
        check(|| Ok(store(&base, &[]))),
        (
            false,
            format!(
                "test-mcp: cannot start. This file has a second name (a hard link). Remove the other name and start again.\n  Path: {}\n",
                quote(&key)
            )
        )
    );

    // An unknown home is reported the same way, from building the store's options.
    assert_eq!(
        check(|| Err(Error::new(
            Code::StoreUnavailable,
            "The home directory is not known; set HOME to an absolute path."
        ))),
        (
            false,
            "test-mcp: cannot start. The home directory is not known; set HOME to an absolute path.\n"
                .to_owned()
        )
    );

    // A bug is not a store refusal and is not hidden.
    let mut text = String::new();
    let bug = startup_check(
        "test-mcp",
        "test-mcp auth login",
        || {
            Err(Error::new(
                Code::InvalidArgument,
                "Store names must be 1-64 letters, digits, dots, dashes or underscores.",
            ))
        },
        &mut |line| text.push_str(line),
    );
    assert_eq!(code(bug), Some(Code::InvalidArgument));
    assert!(text.is_empty());
}

#[test]
fn a_safe_store_passes_silently() {
    let scratch = Scratch::new();
    assert_eq!(check(|| Ok(store(&scratch.0, &[]))), (true, String::new()));
}

#[test]
fn an_earlier_builds_store_gets_the_exact_cleanup_commands_by_metadata_only() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    let old = root.join("old");
    mkdir(&old.join("session.enc.lock"));
    // Unreadable files: the notice only knows they exist.
    unreadable(&old.join("session.enc"));
    unreadable(&old.join("it's.marker"));
    let retired = [
        old.join("session.enc"),
        old.join("it's.marker"),
        old.join("session.enc.lock"),
        old.join("test-mcp.default.key"),
    ];
    let shown = |name: &str| old.join(name).display().to_string();

    assert_eq!(
        check(|| Ok(store(root, &retired))),
        (
            true,
            [
                "test-mcp: an earlier test build left an old session store. Nothing uses it:".to_owned(),
                format!("  {}", shown("session.enc")),
                format!("  {}", shown("it's.marker")),
                format!("  {}", shown("session.enc.lock")),
                "Sign in again: test-mcp auth login".to_owned(),
                "After the new sign-in works, quit your MCP host (for example Claude Desktop) so no test-mcp is running, then remove the old files:".to_owned(),
                format!("  rm '{}' '{}'", shown("session.enc"), shown("it'\\''s.marker")),
                format!("  rm -r '{}'", shown("session.enc.lock")),
                "If that build kept its key in the macOS Keychain, remove that too (macOS may ask for your login password):".to_owned(),
                "  security delete-generic-password -s family-mcp.test-mcp -a default.data-key".to_owned(),
                "Time Machine backups made before today may still hold copies of those files.".to_owned(),
                String::new(),
            ]
            .join("\n")
        )
    );

    // Signed in again with a key file left behind: no sign-in line and no Keychain step.
    unreadable(&old.join("test-mcp.default.key"));
    create_secret_key(&store(root, &[])).unwrap();
    put(&store(root, &[]), "secret").unwrap();
    let (passed, text) = check(|| Ok(store(root, &retired)));
    assert!(passed);
    assert!(!text.contains("Sign in again"));
    assert!(!text.contains("security delete-generic-password"));
    assert!(text.contains(&format!("'{}'", shown("test-mcp.default.key"))));
}

#[test]
fn the_current_store_is_never_named_as_old_also_through_a_link() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    let current = store(root, &[]);
    create_secret_key(&current).unwrap();
    put(&current, "secret").unwrap();
    mkdir(&root.join("family-mcp/test-mcp/session.enc.lock"));

    // An old layout that is the current one under another name: a linked directory and a link.
    symlink(root.join("family-mcp"), root.join("alias")).unwrap();
    mkdir(&root.join("old"));
    symlink(
        root.join("family-mcp/keys/test-mcp.key"),
        root.join("old/test-mcp.default.key"),
    )
    .unwrap();
    let aliases = vec![
        root.join("alias/test-mcp/session.enc"),
        root.join("alias/test-mcp/session.enc.marker"),
        root.join("alias/test-mcp/session.enc.lock"),
        root.join("old/test-mcp.default.key"),
    ];
    assert_eq!(check(|| Ok(store(root, &aliases))), (true, String::new()));
    // The lock directory left above is in the way of a hold; the decision needs none.
    fs::remove_dir(root.join("family-mcp/test-mcp/session.enc.lock")).unwrap();
    assert!(held_exists(&store(root, &aliases)));

    // A really separate old file is still named, and only that one.
    let separate = root.join("old/session.enc");
    write(&separate, "x");
    let (_, text) = check(|| {
        Ok(store(
            root,
            &[aliases.clone(), vec![separate.clone()]].concat(),
        ))
    });
    assert!(text.contains(&format!("  rm '{}'\n", separate.display())));
    assert!(!text.contains(&root.join("alias").display().to_string()));
    assert!(!text.contains("test-mcp.default.key"));
}

#[test]
fn a_save_during_the_check_never_makes_the_current_store_look_old() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    let current = store(root, &[]);
    create_secret_key(&current).unwrap();
    put(&current, "secret").unwrap();

    // The current files under other names: a linked directory, a link to the record, and a link
    // to the lock, which exists only while a save runs.
    symlink(root.join("family-mcp"), root.join("alias")).unwrap();
    mkdir(&root.join("old"));
    symlink(&current.path, root.join("old/session.enc")).unwrap();
    symlink(
        root.join("family-mcp/test-mcp/session.enc.lock"),
        root.join("old/session.enc.lock"),
    )
    .unwrap();
    let aliases = [
        root.join("alias/test-mcp/session.enc"),
        root.join("alias/test-mcp/session.enc.marker"),
        root.join("old/session.enc"),
        root.join("old/session.enc.lock"),
    ];

    // Another process saves right after the check first reads the record's inode: the atomic
    // rename gives the record and its marker new inodes before the check looks at the old names.
    let saved = Rc::new(Cell::new(false));
    let writer = (current.clone(), Rc::clone(&saved));
    after_identity(&current.path, move || {
        put(&writer.0, "saved meanwhile").unwrap();
        writer.1.set(true);
    });

    assert_eq!(check(|| Ok(store(root, &aliases))), (true, String::new()));
    assert!(saved.get());
    assert_eq!(read_secret_record(&current).unwrap(), "saved meanwhile");
}

#[test]
fn an_old_entry_that_cannot_be_followed_is_never_named_and_still_decides() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    let old = root.join("old");
    let hidden = root.join("hidden");
    mkdir(&old);
    mkdir(&hidden);
    write(&hidden.join("session.enc.marker"), "x");

    // No sign-in yet. A link to the current lock is the store in use under another name, so it
    // neither decides nor is named, also while a hold has the lock.
    let lock = old.join("session.enc.lock");
    symlink(root.join("family-mcp/test-mcp/session.enc.lock"), &lock).unwrap();
    assert_eq!(
        check(|| Ok(store(root, std::slice::from_ref(&lock)))),
        (true, String::new())
    );
    assert!(!held_exists(&store(root, std::slice::from_ref(&lock))));

    // A dangling link and a link into a folder that cannot be opened exist by lstat, but their
    // targets cannot be followed: not shown to be separate, so not named, and the store decides.
    let dangling = old.join("session.enc.marker");
    let blocked = old.join("session.enc");
    symlink(root.join("missing/session.enc.marker"), &dangling).unwrap();
    symlink(hidden.join("session.enc.marker"), &blocked).unwrap();
    fs::set_permissions(&hidden, fs::Permissions::from_mode(0o000)).unwrap();

    for entry in [&dangling, &blocked] {
        let retired = [lock.clone(), entry.clone()];
        let outcome = (
            check(|| Ok(store(root, &retired))),
            held_exists(&store(root, &retired)),
        );

        if entry == &blocked {
            fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(
            outcome,
            ((true, String::new()), true),
            "{}",
            entry.display()
        );
    }

    // Once followable, the separate old file is named again.
    let (_, text) = check(|| Ok(store(root, &[lock.clone(), blocked.clone()])));
    assert!(text.contains(&format!("  rm '{}'\n", blocked.display())));
    assert!(!text.contains(&lock.display().to_string()));
}

#[test]
fn when_the_current_files_cannot_be_read_every_old_entry_decides() {
    let scratch = Scratch::new();
    let root = &scratch.0;
    // The current lock under an old name: the store in use, so normally it does not decide.
    let lock = root.join("old/session.enc.lock");
    mkdir(&root.join("old"));
    symlink(root.join("family-mcp/test-mcp/session.enc.lock"), &lock).unwrap();
    let options = store(root, std::slice::from_ref(&lock));
    assert!(!held_exists(&options));

    // The key's metadata cannot be read, so no old entry can be shown to be the current store.
    // (The preflight refuses such a key folder first; a hold does not look at it.)
    let keys = root.join("family-mcp/keys");
    mkdir(&keys);
    fs::set_permissions(&keys, fs::Permissions::from_mode(0o000)).unwrap();
    let decided = held_exists(&options);
    fs::set_permissions(&keys, fs::Permissions::from_mode(0o700)).unwrap();
    assert!(decided);
    assert!(!held_exists(&options));
}
