//! The private-file cases of packages/session-store/test/files.test.ts that
//! tests/files_lock.rs does not already make.

mod common;

use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};

use common::*;
use family_store::{Cancel, Code, ensure_private_dir, read_private_file, write_private_file};

#[test]
fn private_files_are_written_atomically_owner_only_and_read_back() {
    let scratch = Scratch::new();
    let nested = scratch.join("nested");
    let file = nested.join("session.json");

    write(&file, "{\"version\":1}\n");
    assert_eq!(read_private_file(&file, 1024).unwrap(), "{\"version\":1}\n");
    assert_eq!(mode(&file), 0o600);
    assert_eq!(mode(&nested), 0o700);

    // A replacement is whole, and no temporary is left beside it.
    write_private_file(&file, b"replaced", &Cancel::default()).unwrap();
    assert_eq!(read_private_file(&file, 8).unwrap(), "replaced");
    assert_eq!(code(read_private_file(&file, 7)), Some(Code::TooLarge));
    let names: Vec<_> = fs::read_dir(&nested)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, ["session.json"]);
    assert_eq!(
        code(read_private_file(&scratch.join("missing.json"), 8)),
        Some(Code::NotFound)
    );
    assert_eq!(code(read_private_file(&nested, 8)), Some(Code::UnsafeFile));

    // The refusals say what to do.
    fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
    let open = read_private_file(&file, 8).unwrap_err();
    assert_eq!(open.code, Code::UnsafeFile);
    assert!(open.message.contains("chmod 600"), "{}", open.message);
    fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
    let link = nested.join("link.json");
    symlink(&file, &link).unwrap();
    let linked = read_private_file(&link, 8).unwrap_err();
    assert_eq!(linked.code, Code::UnsafeFile);
    assert!(
        linked.message.contains("link to another file"),
        "{}",
        linked.message
    );

    // A symbolic link at the destination is replaced by the rename, never followed.
    write_private_file(&link, b"unlinked", &Cancel::default()).unwrap();
    assert_eq!(fs::metadata(&file).unwrap().len(), 8);
    assert_eq!(text(&file), "replaced");
    assert_eq!(read_private_file(&link, 8).unwrap(), "unlinked");
    assert!(
        !fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
}

#[test]
fn private_directories_are_created_0700_and_tightened_only_on_request() {
    let scratch = Scratch::new();
    let a = scratch.join("a");

    ensure_private_dir(&a.join("b"), false).unwrap();
    assert_eq!(mode(&a.join("b")), 0o700);
    fs::set_permissions(&a, fs::Permissions::from_mode(0o755)).unwrap();
    ensure_private_dir(&a, false).unwrap();
    assert_eq!(mode(&a), 0o755);
    ensure_private_dir(&a, true).unwrap();
    assert_eq!(mode(&a), 0o700);

    // A file in the way is an error, and stays a file.
    fs::write(scratch.join("file"), "").unwrap();
    assert!(ensure_private_dir(&scratch.join("file"), false).is_err());
    assert!(fs::metadata(scratch.join("file")).unwrap().is_file());
}
