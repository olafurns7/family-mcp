//! The private-file and lock rules the secret-store tests reach only indirectly.

mod common;

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::process::Command;
use std::time::Duration;

use common::*;
use family_store::{
    Cancel, Code, Error, LockOptions, read_private_file, sweep_temp, with_file_lock,
    write_private_file,
};

const NO_WAIT: Duration = Duration::ZERO;

fn no_wait() -> LockOptions {
    LockOptions {
        wait: NO_WAIT,
        ..LockOptions::default()
    }
}

#[test]
fn private_reads_refuse_everything_but_an_owner_only_regular_file() {
    let scratch = Scratch::new();
    let file = scratch.join("nested").join("session.json");
    assert_eq!(code(read_private_file(&file, 64)), Some(Code::NotFound));

    write(&file, "contents");
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&scratch.join("nested")), 0o700);
    assert_eq!(read_private_file(&file, 8).unwrap(), "contents");
    assert_eq!(code(read_private_file(&file, 7)), Some(Code::TooLarge));
    assert_eq!(fs::read_dir(scratch.join("nested")).unwrap().count(), 1);

    let alias = scratch.join("alias");
    symlink(&file, &alias).unwrap();
    assert_eq!(code(read_private_file(&alias, 64)), Some(Code::UnsafeFile));
    assert_eq!(
        code(read_private_file(&scratch.join("nested"), 64)),
        Some(Code::UnsafeFile)
    );
    fs::remove_file(&alias).unwrap();

    fs::hard_link(&file, &alias).unwrap();
    assert_eq!(code(read_private_file(&file, 64)), Some(Code::UnsafeFile));
    fs::remove_file(&alias).unwrap();

    fs::set_permissions(&file, fs::Permissions::from_mode(0o640)).unwrap();
    assert_eq!(code(read_private_file(&file, 64)), Some(Code::UnsafeFile));

    // A cancelled write changes nothing.
    let cancel = Cancel::default();
    cancel.cancel();
    assert_eq!(
        code(write_private_file(&file, b"new", &cancel)),
        Some(Code::Cancelled)
    );
    assert_eq!(fs::read_to_string(&file).unwrap(), "contents");
}

#[test]
fn sweeps_remove_only_this_files_own_temporaries() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    let own = scratch.join("session.json.0b0e5cbb-7d1c-4d7a-9d0e-3f2a6c1b8e4f.tmp");
    let kept = [
        scratch.join("session.json.not-a-uuid.tmp"),
        scratch.join("other.json.0b0e5cbb-7d1c-4d7a-9d0e-3f2a6c1b8e4f.tmp"),
        scratch.join("session.json.0B0E5CBB-7D1C-4D7A-9D0E-3F2A6C1B8E4F.tmp"),
    ];

    for path in kept.iter().chain([&own]) {
        fs::write(path, "").unwrap();
    }
    assert_eq!(sweep_temp(&file, Duration::from_secs(300)).unwrap(), 0);
    assert_eq!(sweep_temp(&file, Duration::ZERO).unwrap(), 1);
    assert!(!own.exists());
    assert!(kept.iter().all(|path| path.exists()));
    assert_eq!(
        sweep_temp(&scratch.join("missing").join("x"), Duration::ZERO).unwrap(),
        0
    );
}

#[test]
fn the_lock_excludes_reports_a_lost_owner_and_recovers_a_dead_one() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    let lock = scratch.join("session.json.lock");

    let value = with_file_lock(&file, &no_wait(), || {
        assert_eq!(fs::read_dir(&lock).unwrap().count(), 1);
        let nested = with_file_lock(&file, &no_wait(), || Ok::<_, Error>(()));
        assert_eq!(code(nested), Some(Code::Busy));
        // The same directory through an alias is the same lock.
        symlink(&scratch.0, scratch.join("alias")).unwrap();
        let aliased = scratch.join("alias").join("session.json");
        assert_eq!(
            code(with_file_lock(&aliased, &no_wait(), || Ok::<_, Error>(()))),
            Some(Code::Busy)
        );
        Ok::<_, Error>(7)
    });
    assert_eq!(value.unwrap(), 7);
    assert!(!lock.exists());
    assert_eq!(
        fs::read_dir(&scratch.0).unwrap().count(),
        1,
        "only the alias is left"
    );

    // Work's own error passes through, and the lock is released.
    let failed = with_file_lock(&file, &no_wait(), || {
        Err::<(), _>(Error::new(Code::NotFound, "x"))
    });
    assert_eq!(code(failed), Some(Code::NotFound));
    assert!(!lock.exists());

    let lost = with_file_lock(&file, &no_wait(), || {
        fs::remove_dir_all(&lock).unwrap();
        Ok::<_, Error>(())
    });
    assert_eq!(code(lost), Some(Code::LockLost));

    // An owner whose process is gone is taken over; a malformed or live owner is not.
    let mut child = Command::new("/bin/true").spawn().unwrap();
    let dead = child.id();
    child.wait().unwrap();
    let id = "0b0e5cbb-7d1c-4d7a-9d0e-3f2a6c1b8e4f";

    for (owner, expected) in [
        (format!("{dead}-{id}"), None),
        (format!("{}-{id}", std::process::id()), Some(Code::Busy)),
        (format!("0{dead}-{id}"), Some(Code::Busy)),
        (format!("{dead}-{}", id.to_uppercase()), Some(Code::Busy)),
        (format!("99999999999-{id}"), Some(Code::Busy)),
    ] {
        fs::create_dir(&lock).unwrap();
        fs::write(lock.join(&owner), "").unwrap();
        let taken = with_file_lock(&file, &no_wait(), || Ok::<_, Error>(()));
        assert_eq!(code(taken), expected, "{owner}");
        let _ = fs::remove_dir_all(&lock);
    }

    // An empty lock directory is a released shell.
    fs::create_dir(&lock).unwrap();
    with_file_lock(&file, &no_wait(), || Ok::<_, Error>(())).unwrap();

    write(&file, "x");
    fs::hard_link(&file, scratch.join("link")).unwrap();
    let linked = with_file_lock(&file, &no_wait(), || Ok::<_, Error>(()));
    assert_eq!(code(linked), Some(Code::UnsafeFile));

    let cancel = Cancel::default();
    cancel.cancel();
    let cancelled = LockOptions {
        cancel,
        wait: NO_WAIT,
    };
    let other = scratch.join("other.json");
    assert_eq!(
        code(with_file_lock(&other, &cancelled, || Ok::<_, Error>(()))),
        Some(Code::Cancelled)
    );
}
