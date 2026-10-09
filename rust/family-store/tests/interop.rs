//! The Rust crate and the TypeScript package on one store. `FAMILY_MCP_BUN` must name a Bun
//! 1.4.2 executable: these tests fail without it and are never skipped.

mod common;

use std::fs;
use std::io::{BufRead, BufReader};
use std::os::unix::fs::DirBuilderExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use common::*;
use family_store::{
    Code, Error, LocalKeyFileProvider, SecretRecordOptions, TEST_SEAM, create_secret_key,
    read_secret_record, with_secret_record, with_secret_store,
};

const HOLD_RECORD: &str = "FAMILY_STORE_TEST_HOLD_RECORD";

const HOLD_KEY: &str = "FAMILY_STORE_TEST_HOLD_KEY";

/// One scratch store that both languages open with the same options.
struct Shared {
    scratch: Scratch,
    key: PathBuf,
}

impl Shared {
    fn new() -> Self {
        let scratch = Scratch::new();
        let key = scratch.join("keys").join("test-mcp.default.key");
        Self { scratch, key }
    }

    fn options_in(&self, directory: &Path) -> SecretRecordOptions {
        options_with(
            directory,
            Arc::new(LocalKeyFileProvider::new(&self.key)),
            1024,
        )
    }

    fn options(&self) -> SecretRecordOptions {
        self.options_in(&self.scratch.0)
    }

    fn command(&self, mode: &str, record: &Path, arguments: &[&str]) -> Command {
        let bun = std::env::var_os("FAMILY_MCP_BUN")
            .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; interop tests never skip");
        let mut command = Command::new(bun);
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ts/store.ts"))
            .arg(mode)
            .arg(record)
            .arg(&self.key)
            .args(arguments)
            .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
            .env(TEST_SEAM, "1")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    /// The TypeScript package's outcome: `value:<text>`, `none` or `error:<CODE>`.
    fn ts_in(&self, directory: &Path, mode: &str, arguments: &[&str]) -> String {
        let record = self.options_in(directory).path;
        let output = self.command(mode, &record, arguments).output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "store.ts {mode} failed: {stderr}");
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }

    fn ts(&self, mode: &str, arguments: &[&str]) -> String {
        self.ts_in(&self.scratch.0, mode, arguments)
    }

    /// Start `store.ts hold` and return once it holds the record lock.
    fn ts_hold(&self, release: &Path) -> Child {
        let record = self.options().path;
        let mut child = self
            .command("hold", &record, &[release.to_str().unwrap()])
            .spawn()
            .unwrap();
        wait_for_line(&mut child, "held");
        child
    }
}

fn wait_for_line(child: &mut Child, expected: &str) {
    let mut line = String::new();
    BufReader::new(child.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    assert_eq!(line.trim_end(), expected);
}

/// The Rust crate's outcome in the form `Shared::ts` reports.
fn shown(result: Result<Option<String>, Error>) -> String {
    match result {
        Ok(Some(value)) => format!("value:{value}"),
        Ok(None) => "none".to_owned(),
        Err(error) => format!("error:{}", error.code.as_str()),
    }
}

fn rust_read(store: &SecretRecordOptions) -> String {
    shown(read_secret_record(store).map(Some))
}

fn copy_tree(from: &Path, to: &Path) {
    // A store directory is owner-only; both languages refuse any other.
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(to)
        .unwrap();

    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), to.join(entry.file_name())).unwrap();
    }
}

fn pending(marker: &str, generation: u64, nonce: &str) -> String {
    marker.replace(
        "}\n",
        &format!(",\"pending\":{{\"generation\":{generation},\"nonce\":\"{nonce}\"}}}}\n"),
    )
}

fn nonce_of(record: &str) -> String {
    let start = record.find("\"nonce\":\"").unwrap() + 9;
    record[start..start + 16].to_owned()
}

/// The Rust side of `store.ts blocked-write`.
fn rust_blocked_write(store: &SecretRecordOptions, value: &str) {
    let aside = store.path.with_extension("aside");

    with_secret_store(store, |held| {
        let current = held.read()?;

        if current.is_some() {
            fs::rename(&store.path, &aside).unwrap();
        }
        fs::create_dir_all(store.path.join("blocked")).unwrap();
        assert_eq!(code(held.write(value)), Some(Code::StoreWriteUncertain));
        fs::remove_dir_all(&store.path).unwrap();

        if current.is_some() {
            fs::rename(&aside, &store.path).unwrap();
        }
        Ok::<_, Error>(())
    })
    .unwrap();
}

#[test]
fn the_configured_bun_is_1_4_2() {
    let bun = std::env::var_os("FAMILY_MCP_BUN")
        .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; interop tests never skip");
    let output = Command::new(bun).arg("--version").output().unwrap();
    assert_eq!(String::from_utf8_lossy(&output.stdout).trim(), "1.4.2");
}

#[test]
fn each_language_reads_and_continues_what_the_other_wrote() {
    for creator in ["ts", "rust"] {
        let shared = Shared::new();
        let store = shared.options();
        let marker = marker_path(&store);

        if creator == "ts" {
            assert_eq!(shared.ts("create-key", &[]), "none");
        } else {
            create_secret_key(&store).unwrap();
        }
        assert_eq!(mode(&shared.key), 0o600);
        assert_eq!(shared.ts("read", &[]), "error:SECRET_NOT_FOUND");
        assert_eq!(rust_read(&store), "error:SECRET_NOT_FOUND");
        // A key that exists is never replaced by either side.
        assert_eq!(shared.ts("create-key", &[]), "error:STORE_ERROR");
        assert_eq!(code(create_secret_key(&store)), Some(Code::StoreError));

        assert_eq!(shared.ts("write", &["from-ts-1"]), "value:from-ts-1");
        assert_eq!(rust_read(&store), "value:from-ts-1");
        assert!(text(&marker).ends_with("\"migrated\":true,\"generation\":1}\n"));

        let unicode = "frá-rust-2 þýðing 🔑";
        assert_eq!(put(&store, unicode).unwrap().as_deref(), Some(unicode));
        assert_eq!(shared.ts("read", &[]), format!("value:{unicode}"));
        let after_rust = text(&marker);

        assert_eq!(shared.ts("write", &["from-ts-3 ñ"]), "value:from-ts-3 ñ");
        assert_eq!(rust_read(&store), "value:from-ts-3 ñ");
        // The marker either side commits is the same text but for its generation.
        assert_eq!(
            text(&marker),
            after_rust.replace("\"generation\":2", "\"generation\":3")
        );
        assert_eq!(
            after_rust,
            "{\"backend\":\"encrypted-file\",\"keySource\":\"local-file\",\"keyId\":\"local\",\"profile\":\"default\",\"migrated\":true,\"generation\":2}\n"
        );
        assert_eq!(mode(&store.path), 0o600);
        assert_eq!(mode(&marker), 0o600);
    }
}

#[test]
fn a_lock_held_by_one_language_blocks_the_other() {
    let shared = Shared::new();
    let store = shared.options();
    let no_wait = SecretRecordOptions {
        wait: Duration::ZERO,
        ..store.clone()
    };
    create_secret_key(&store).unwrap();

    // Rust holds: the TypeScript package is BUSY, then proceeds once the hold ends.
    with_secret_store(&store, |held| {
        held.write("rust-held")?;
        assert_eq!(shared.ts("write", &["ts-intruder", "0"]), "error:BUSY");
        assert_eq!(shared.ts("write", &["ts-intruder", "300"]), "error:BUSY");
        Ok::<_, Error>(())
    })
    .unwrap();
    assert_eq!(shared.ts("read", &[]), "value:rust-held");

    // TypeScript holds: Rust is BUSY, then proceeds once the hold ends.
    let release = shared.scratch.join("release");
    let mut holder = shared.ts_hold(&release);
    assert_eq!(code(put(&no_wait, "rust-intruder")), Some(Code::Busy));
    let brief = SecretRecordOptions {
        wait: Duration::from_millis(300),
        ..store.clone()
    };
    assert_eq!(code(put(&brief, "rust-intruder")), Some(Code::Busy));
    assert_eq!(rust_read(&no_wait), "error:BUSY");
    fs::write(&release, "").unwrap();
    assert!(holder.wait().unwrap().success());
    assert_eq!(
        put(&no_wait, "rust-after").unwrap().as_deref(),
        Some("rust-after")
    );
    assert_eq!(shared.ts("read", &[]), "value:rust-after");
}

#[test]
fn both_languages_serialize_read_modify_write_cycles_on_one_record() {
    let shared = Shared::new();
    let store = shared.options();
    create_secret_key(&store).unwrap();
    let record = store.path.clone();

    let workers: Vec<Child> = (0..3)
        .map(|_| {
            shared
                .command("increment", &record, &["100"])
                .spawn()
                .unwrap()
        })
        .collect();
    let threads: Vec<_> = (0..3)
        .map(|_| {
            let store = store.clone();
            std::thread::spawn(move || {
                with_secret_record(&store, |current| {
                    std::thread::sleep(Duration::from_millis(100));
                    let count: u32 = current.unwrap_or("0").parse().unwrap();
                    Ok::<_, Error>(Some((count + 1).to_string()))
                })
            })
        })
        .collect();

    for thread in threads {
        thread.join().unwrap().unwrap();
    }

    for worker in workers {
        let output = worker.wait_with_output().unwrap();
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(output.status.success(), "{stderr}");
    }
    assert_eq!(rust_read(&store), "value:6");
    assert_eq!(shared.ts("read", &[]), "value:6");
    assert!(text(&marker_path(&store)).ends_with("\"generation\":6}\n"));
}

#[test]
fn a_lock_left_by_a_killed_holder_is_recovered_by_the_other_language() {
    let shared = Shared::new();
    let store = shared.options();
    let no_wait = SecretRecordOptions {
        wait: Duration::ZERO,
        ..store.clone()
    };
    create_secret_key(&store).unwrap();
    let lock = store.path.with_extension("enc.lock");

    // A TypeScript holder dies: its owner file stays, and Rust takes the lock over.
    let mut holder = shared.ts_hold(&shared.scratch.join("never"));
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert_eq!(fs::read_dir(&lock).unwrap().count(), 1);
    assert_eq!(
        put(&no_wait, "after-ts-crash").unwrap().as_deref(),
        Some("after-ts-crash")
    );
    assert!(!lock.exists());

    // A Rust holder dies: the TypeScript package takes the lock over.
    let mut holder = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "hold_the_lock_until_killed",
            "--nocapture",
            "--ignored",
        ])
        .env(HOLD_RECORD, &store.path)
        .env(HOLD_KEY, &shared.key)
        .env(TEST_SEAM, "1")
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(holder.stdout.as_mut().unwrap()).lines();
    assert!(lines.any(|line| line.unwrap().ends_with("held")));
    assert_eq!(shared.ts("write", &["ts-intruder", "0"]), "error:BUSY");
    holder.kill().unwrap();
    holder.wait().unwrap();
    assert_eq!(fs::read_dir(&lock).unwrap().count(), 1);
    assert_eq!(
        shared.ts("write", &["after-rust-crash", "0"]),
        "value:after-rust-crash"
    );
    assert!(!lock.exists());
    assert_eq!(rust_read(&store), "value:after-rust-crash");
}

/// Run by the test above in a child process, which it kills while this holds the lock.
#[test]
#[ignore = "helper for a_lock_left_by_a_killed_holder_is_recovered_by_the_other_language"]
fn hold_the_lock_until_killed() {
    let record = PathBuf::from(std::env::var_os(HOLD_RECORD).unwrap());
    let key = std::env::var_os(HOLD_KEY).unwrap();
    let store = options_with(
        record.parent().unwrap().parent().unwrap(),
        Arc::new(LocalKeyFileProvider::new(key)),
        1024,
    );
    assert_eq!(store.path, record);

    with_secret_store(&store, |_| {
        println!("held");
        std::thread::sleep(Duration::from_secs(120));
        Ok::<_, Error>(())
    })
    .unwrap();
}

#[test]
fn a_pending_marker_left_by_either_language_is_recovered_identically_by_both() {
    for builder in ["ts", "rust"] {
        let shared = Shared::new();
        let store = shared.options();
        let marker = marker_path(&store);
        let records = shared.scratch.join("records");
        create_secret_key(&store).unwrap();
        let mut case = 0;

        // Recover copies of the current state with each language and compare everything.
        let mut recovered = |expected: &str, expected_marker: &str| {
            case += 1;
            let ts_copy = shared.scratch.join(&format!("ts-{case}"));
            let rust_copy = shared.scratch.join(&format!("rust-{case}"));
            copy_tree(&records, &ts_copy.join("records"));
            copy_tree(&records, &rust_copy.join("records"));
            let by_rust = shared.options_in(&rust_copy);
            let by_ts = shared.options_in(&ts_copy);
            let label = format!("{builder} case {case}");

            assert_eq!(shared.ts_in(&ts_copy, "read", &[]), expected, "{label}");
            assert_eq!(rust_read(&by_rust), expected, "{label}");
            assert_eq!(text(&marker_path(&by_ts)), expected_marker, "{label}");
            assert_eq!(text(&marker_path(&by_rust)), expected_marker, "{label}");
            assert_eq!(by_ts.path.exists(), store.path.exists(), "{label}");
            assert_eq!(by_rust.path.exists(), store.path.exists(), "{label}");

            if store.path.exists() {
                assert_eq!(text(&by_ts.path), text(&store.path), "{label}");
                assert_eq!(text(&by_rust.path), text(&store.path), "{label}");
            }
            // Each language also accepts the other's recovery.
            assert_eq!(shared.ts_in(&rust_copy, "read", &[]), expected, "{label}");
            assert_eq!(rust_read(&by_ts), expected, "{label}");
        };

        let blocked_write = |value: &str| {
            if builder == "ts" {
                let outcome = shared.ts("blocked-write", &[value]);
                assert_eq!(outcome, "error:STORE_WRITE_UNCERTAIN");
            } else {
                rust_blocked_write(&store, value);
            }
        };
        let commit = |value: &str| {
            if builder == "ts" {
                assert_eq!(shared.ts("write", &[value]), format!("value:{value}"));
            } else {
                put(&store, value).unwrap();
            }
        };
        let empty = "{\"backend\":\"encrypted-file\",\"keySource\":\"local-file\",\"keyId\":\"local\",\"profile\":\"default\",\"migrated\":false,\"generation\":0}\n";
        let marker1 = empty.replace(
            "\"migrated\":false,\"generation\":0",
            "\"migrated\":true,\"generation\":1",
        );
        let marker2 = marker1.replace("\"generation\":1", "\"generation\":2");

        // A first write that stopped after its pending marker: an empty store.
        blocked_write("lost");
        assert!(text(&marker).contains("\"pending\":{\"generation\":1,"));
        assert!(!store.path.exists());
        recovered("error:SECRET_NOT_FOUND", empty);

        // A later write that stopped before its record: the committed generation is kept.
        commit("one");
        let record1 = text(&store.path);
        blocked_write("lost");
        assert!(text(&marker).contains("\"pending\":{\"generation\":2,"));
        assert_eq!(text(&store.path), record1);
        recovered("value:one", &marker1);

        // A write that stopped after its record, before the marker commit: it is committed.
        commit("two");
        let record2 = text(&store.path);
        write(&marker, pending(&marker1, 2, &nonce_of(&record2)));
        recovered("value:two", &marker2);

        // A record that is not the announced candidate, or a marker behind its record: neither
        // language guesses, and neither changes a file.
        let foreign = pending(&marker1, 2, "AAAAAAAAAAAAAAAA");
        write(&marker, &foreign);
        recovered("error:STORE_WRITE_UNCERTAIN", &foreign);
        write(&marker, &marker1);
        recovered("error:STORE_WRITE_UNCERTAIN", &marker1);
        write(&store.path, &record1);
        write(&marker, &marker2);
        recovered("error:STORE_WRITE_UNCERTAIN", &marker2);
    }
}

#[test]
fn a_tampered_header_or_body_fails_closed_in_both_languages() {
    for writer in ["ts", "rust"] {
        let shared = Shared::new();
        let store = shared.options();
        create_secret_key(&store).unwrap();

        if writer == "ts" {
            assert_eq!(shared.ts("write", &[SECRET]), format!("value:{SECRET}"));
        } else {
            put(&store, SECRET).unwrap();
        }
        let original = text(&store.path);
        let (header, body) = original.trim_end().split_once('\n').unwrap();
        let swap = |text: &str, at: usize| {
            let other = if &text[at..=at] == "A" { "B" } else { "A" };
            format!("{}{other}{}", &text[..at], &text[at + 1..])
        };

        for tampered in [
            format!(
                "{}\n{body}\n",
                header.replace("\"generation\":1", "\"generation\":2")
            ),
            format!(
                "{}\n{body}\n",
                header.replace("\"schema\":1", "\"schema\":2")
            ),
            format!("{}\n{body}\n", header.replace("test-mcp", "evil-mcp")),
            format!(
                "{}\n{body}\n",
                header.replace("\"purpose\":\"session\"", "\"purpose\":\"journal\"")
            ),
            format!(
                "{}\n{body}\n",
                swap(header, header.find("\"nonce\":\"").unwrap() + 9)
            ),
            format!("{}\n{body}\n", header.replace("{\"v\":1,", "{ \"v\":1,")),
            format!("{header}\n{}\n", swap(body, 0)),
            format!("{header}\n{}\n", swap(body, body.len() - 2)),
            format!("{header}\n{}\n", &body[..body.len() - 4]),
            format!("{header}\n{body}A\n"),
            format!("{header}\n{body}=\n"),
            format!("{header}\n{body}\n\n"),
            format!("{header}\n{body}"),
            format!("{header}\n\n"),
        ] {
            write(&store.path, &tampered);
            assert_eq!(
                rust_read(&store),
                "error:STORE_ERROR",
                "{writer}: {tampered}"
            );
            assert_eq!(
                shared.ts("read", &[]),
                "error:STORE_ERROR",
                "{writer}: {tampered}"
            );
            // A refused record is never overwritten either.
            assert_eq!(
                shown(put(&store, "x")),
                "error:STORE_ERROR",
                "{writer}: {tampered}"
            );
            assert_eq!(
                shared.ts("write", &["x"]),
                "error:STORE_ERROR",
                "{writer}: {tampered}"
            );
            assert_eq!(text(&store.path), tampered);
        }

        // The other language's key file with different bytes is a wrong key for both.
        write(&store.path, &original);
        assert_eq!(rust_read(&store), format!("value:{SECRET}"));
        assert_eq!(shared.ts("read", &[]), format!("value:{SECRET}"));
        write(&shared.key, [8; 32]);
        assert_eq!(rust_read(&store), "error:STORE_ERROR");
        assert_eq!(shared.ts("read", &[]), "error:STORE_ERROR");
    }
}

const LAYOUT_OPERATION: &str = "FAMILY_STORE_TEST_OPERATION";

/// The default layout of `test-mcp` under a scratch HOME, as a server would find it: with the
/// store test seam (the Linux layout, in absolute XDG directories) or without it (the platform's
/// own layout: Application Support on macOS, with the real Time Machine exclusion).
struct Layout {
    home: Scratch,
    seam: bool,
}

impl Layout {
    fn environment(&self, command: &mut Command) {
        let home = &self.home.0;
        command
            .env("HOME", home)
            .env_remove(TEST_SEAM)
            .env_remove("XDG_CONFIG_HOME")
            .env_remove("XDG_DATA_HOME")
            .env_remove(family_store::TEST_TMUTIL)
            .env_remove(family_store::TEST_LS)
            .env("BUN_RUNTIME_TRANSPILER_CACHE_PATH", "0")
            .stdin(Stdio::null());

        if self.seam {
            command
                .env(TEST_SEAM, "1")
                .env("XDG_CONFIG_HOME", home.join("config"))
                .env("XDG_DATA_HOME", home.join("data"));
        }
    }

    /// Where the record and the key must be.
    fn files(&self) -> (PathBuf, PathBuf) {
        let home = &self.home.0;
        let (config, data) = if self.seam {
            (home.join("config"), home.join("data/family-mcp"))
        } else if cfg!(target_os = "macos") {
            let root = home.join("Library/Application Support/family-mcp");
            (root.clone(), root)
        } else {
            (home.join(".config"), home.join(".local/share/family-mcp"))
        };
        (
            config.join("test-mcp/session.enc"),
            data.join("keys/test-mcp.default.key"),
        )
    }

    fn ts(&self, mode: &str, arguments: &[&str]) -> String {
        let bun = std::env::var_os("FAMILY_MCP_BUN")
            .expect("FAMILY_MCP_BUN must name a Bun 1.4.2 executable; interop tests never skip");
        let mut command = Command::new(bun);
        command
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/ts/store.ts"))
            .args([mode, "default", "default"])
            .args(arguments);
        self.environment(&mut command);
        let output = command.output().unwrap();
        assert!(
            output.status.success(),
            "store.ts {mode} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout)
            .unwrap()
            .trim_end()
            .to_owned()
    }

    /// The same operation in a child of this test binary, whose environment is this layout's.
    fn rust(&self, operation: &str) -> String {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "default_layout_operation",
                "--ignored",
                "--nocapture",
            ])
            .env(LAYOUT_OPERATION, operation);
        self.environment(&mut command);
        let output = command.output().unwrap();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            output.status.success(),
            "{stdout}{}",
            String::from_utf8_lossy(&output.stderr)
        );
        stdout
            .lines()
            .find_map(|line| line.strip_prefix("result:"))
            .unwrap_or_else(|| panic!("no result: {stdout}"))
            .to_owned()
    }

    fn run(&self, side: &str, operation: &str) -> String {
        match (side, operation.split_once(' ')) {
            ("ts", Some((mode, value))) => self.ts(mode, &[value]),
            ("ts", None) => self.ts(operation, &[]),
            _ => self.rust(operation),
        }
    }
}

/// `create-key`, `read` or `write VALUE` on the default layout. Run by the layout tests.
#[test]
#[ignore = "run by the default layout interop tests"]
fn default_layout_operation() {
    let operation = std::env::var(LAYOUT_OPERATION).unwrap();
    let store = SecretRecordOptions::new(
        family_store::default_secret_record_path("test-mcp").unwrap(),
        "test-mcp",
        "default",
        "session",
        1,
        family_store::default_key_provider("test-mcp", "default").unwrap(),
        1024,
    );
    let result = match operation.split_once(' ') {
        Some(("write", value)) => put(&store, value),
        _ if operation == "create-key" => create_secret_key(&store).map(|()| None),
        _ => read_secret_record(&store).map(Some),
    };
    println!("result:{}", shown(result));
}

fn both_languages_share_the_default_layout(seam: bool) {
    for (creator, other) in [("ts", "rust"), ("rust", "ts")] {
        let layout = Layout {
            home: Scratch::new(),
            seam,
        };
        assert_eq!(layout.run(creator, "create-key"), "none");
        assert_eq!(layout.run(other, "create-key"), "error:STORE_ERROR");
        assert_eq!(
            layout.run(creator, &format!("write from-{creator}")),
            format!("value:from-{creator}")
        );
        assert_eq!(layout.run(other, "read"), format!("value:from-{creator}"));
        assert_eq!(
            layout.run(other, &format!("write from-{other}")),
            format!("value:from-{other}")
        );
        assert_eq!(layout.run(creator, "read"), format!("value:from-{other}"));

        let (record, key) = layout.files();
        assert_eq!(mode(&record), 0o600, "{creator}");
        assert_eq!(mode(&key), 0o600, "{creator}");
        assert_eq!(mode(record.parent().unwrap()), 0o700);
        assert_eq!(mode(key.parent().unwrap()), 0o700);

        // Without the seam on macOS both languages excluded the store folders from Time Machine.
        if !seam && cfg!(target_os = "macos") {
            let output = Command::new("/usr/bin/tmutil")
                .arg("isexcluded")
                .args([record.parent().unwrap(), key.parent().unwrap()])
                .output()
                .unwrap();
            let listed = String::from_utf8_lossy(&output.stdout);
            assert_eq!(
                listed
                    .lines()
                    .filter(|line| line.starts_with("[Excluded]"))
                    .count(),
                2,
                "{listed}"
            );
        }
    }
}

#[test]
fn both_languages_share_the_default_layout_with_the_test_seam() {
    both_languages_share_the_default_layout(true);
}

#[test]
fn both_languages_share_the_platforms_default_layout_under_a_scratch_home() {
    both_languages_share_the_default_layout(false);
}
