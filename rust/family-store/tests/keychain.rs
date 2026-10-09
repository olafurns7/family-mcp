//! packages/session-store/test/keychain.test.ts against a stand-in for security(1), plus the
//! default paths. Nothing here runs the real `/usr/bin/security`.

mod common;

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use common::*;
use family_store::{
    Cancel, Code, KeyProvider, KeychainAccessorKeyProvider, KeychainAccessorOptions,
    create_secret_key, default_secret_record_path, default_session_path, key_provider_for,
    read_secret_record,
};
use rustix::io::Errno;
use rustix::process::{Pid, test_kill_process};

// The fake keychain keeps its one item in `<directory>/item`, exactly as `-w` prints it.
const FIND: &str = r#"[ -f "$d/item" ] || exit 44; cat "$d/item""#;

const ADD: &str =
    r#"sed -n 's/^add-generic-password .* -w \([0-9a-f]*\) -T .*$/\1/p' "$d/stdin" > "$d/item""#;

const HANG: &str = r#"echo $$ > "$d/pid"; exec sleep 30"#;

// Tests that change the process environment take this.
static ENVIRONMENT: Mutex<()> = Mutex::new(());

struct Fake {
    scratch: Scratch,
    options: KeychainAccessorOptions,
}

impl Fake {
    /// A stand-in for security(1) that records its argv, environment and stdin.
    fn new(find: &str, add: &str) -> Self {
        let scratch = Scratch::new();
        let accessor = scratch.join("security");
        let script = format!(
            "#!/bin/sh\nd='{}'\nprintf '%s\\n' \"$*\" >> \"$d/argv\"\nenv > \"$d/env\"\nif [ \"$1\" = -i ]; then\n  cat >> \"$d/stdin\"\n  {add}\nelse\n  {find}\nfi\n",
            scratch.0.display()
        );
        // Written by a child: a descriptor open for writing in this process would leak into
        // another test's fork and make running the script fail with ETXTBSY.
        let mut writer = Command::new("/bin/sh")
            .args(["-c", r#"cat > "$1" && chmod 700 "$1""#, "sh"])
            .arg(&accessor)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        writer
            .stdin
            .take()
            .unwrap()
            .write_all(script.as_bytes())
            .unwrap();
        assert!(writer.wait().unwrap().success());
        let options = KeychainAccessorOptions {
            accessor,
            read_timeout: Duration::from_secs(5),
            ..KeychainAccessorOptions::default()
        };
        Self { scratch, options }
    }

    fn keys(&self) -> KeychainAccessorKeyProvider {
        self.keys_with(self.options.clone())
    }

    fn keys_with(&self, options: KeychainAccessorOptions) -> KeychainAccessorKeyProvider {
        KeychainAccessorKeyProvider::with_options("test-mcp", "default", options).unwrap()
    }

    fn read(&self, name: &str) -> String {
        text(&self.scratch.join(name))
    }

    fn assert_killed(&self) {
        let pid = Pid::from_raw(self.read("pid").trim().parse().unwrap()).unwrap();
        assert_eq!(test_kill_process(pid), Err(Errno::SRCH));
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn cancel_after(delay: Duration) -> Cancel {
    let cancel = Cancel::default();
    let trigger = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(delay);
        trigger.cancel();
    });
    cancel
}

fn cancelled() -> Cancel {
    let cancel = Cancel::default();
    cancel.cancel();
    cancel
}

#[test]
fn setup_writes_one_add_command_on_stdin_and_never_puts_the_key_in_argv() {
    let _environment = ENVIRONMENT.lock().unwrap();
    let fake = Fake::new(FIND, ADD);
    let keys = fake.keys();
    let none = Cancel::default();
    // The fake prints its environment, so a variable set before the spawn would show up there.
    let inherited = std::env::vars().find(|(name, _)| name != "PATH" && name != "HOME");

    keys.create_key(&none).unwrap();
    let key = hex(&keys.get_key(&none).unwrap());
    assert_eq!(key.len(), 64);
    assert_eq!(
        fake.read("stdin"),
        format!(
            "add-generic-password -s family-mcp.test-mcp -a default.data-key -w {key} -T /usr/bin/security\n"
        )
    );

    let argv = fake.read("argv");
    assert!(!argv.contains(&key));
    assert_eq!(
        argv.split('\n').collect::<Vec<_>>(),
        [
            "find-generic-password -s family-mcp.test-mcp -a default.data-key -w",
            "-i",
            "find-generic-password -s family-mcp.test-mcp -a default.data-key -w",
            "find-generic-password -s family-mcp.test-mcp -a default.data-key -w",
            "",
        ]
    );

    let env = fake.read("env");
    assert!(env.contains("PATH=/usr/bin:/bin\n"));
    let (name, _) = inherited.expect("the test process has more variables than PATH and HOME");
    assert!(
        !env.contains(&format!("{name}=")),
        "{name} reached the child"
    );

    // An existing item is never replaced: the second setup stops at its lookup.
    assert_eq!(code(keys.create_key(&none)), Some(Code::StoreError));
    assert_eq!(fake.read("stdin").split('\n').count(), 2);
}

#[test]
fn encrypted_records_round_trip_through_the_keychain_provider() {
    let fake = Fake::new(FIND, ADD);
    let store = options_with(&fake.scratch.0, Arc::new(fake.keys()), 1024);

    assert_eq!(
        code(read_secret_record(&store)),
        Some(Code::StoreUnavailable)
    );
    create_secret_key(&store).unwrap();
    put(&store, "refresh-token").unwrap();
    assert_eq!(read_secret_record(&store).unwrap(), "refresh-token");
    assert_eq!(
        text(&marker_path(&store)),
        "{\"backend\":\"encrypted-file\",\"keySource\":\"keychain-accessor\",\"keyId\":\"keychain\",\"profile\":\"default\",\"migrated\":true,\"generation\":1}\n"
    );
}

#[test]
fn reads_accept_exactly_64_lowercase_hex_characters_and_a_newline() {
    let key = "ab".repeat(32);

    for (output, expected) in [
        (format!("printf '{key}\\n'"), None),
        (format!("printf '{}\\n'", &key[2..]), Some(Code::StoreError)),
        (format!("printf '{key}0\\n'"), Some(Code::StoreError)),
        (
            format!("printf '{}\\n'", "g".repeat(64)),
            Some(Code::StoreError),
        ),
        (
            format!("printf '{}\\n'", key.to_uppercase()),
            Some(Code::StoreError),
        ),
        (format!("printf '{key}'"), Some(Code::StoreError)),
        (
            "head -c 100000 /dev/zero".to_owned(),
            Some(Code::StoreError),
        ),
    ] {
        let fake = Fake::new(&output, ADD);
        let read = fake.keys().get_key(&Cancel::default());

        match expected {
            None => assert_eq!(hex(&read.unwrap()), key),
            Some(_) => assert_eq!(code(read), expected, "{output}"),
        }
    }
}

#[test]
fn security_exit_statuses_map_to_fixed_store_codes() {
    let none = Cancel::default();

    for (find, expected) in [
        ("exit 44", Code::StoreUnavailable),
        ("exit 36", Code::StoreLocked),
        ("exit 29", Code::StoreLocked),
        ("exit 51", Code::StoreAccessDenied),
        ("exit 128", Code::StoreAccessDenied),
        ("exit 1", Code::StoreError),
        ("exit 2", Code::StoreError),
        ("kill -9 $$", Code::StoreError),
    ] {
        let fake = Fake::new(find, ADD);
        let keys = fake.keys();
        assert_eq!(code(keys.get_key(&none)), Some(expected), "{find}");

        // A failed lookup other than a missing item never leads to a new key.
        if expected != Code::StoreUnavailable {
            assert_eq!(code(keys.create_key(&none)), Some(expected), "{find}");
        }
    }

    let scratch = Scratch::new();
    let missing = KeychainAccessorOptions {
        accessor: scratch.join("missing"),
        ..KeychainAccessorOptions::default()
    };
    let keys = KeychainAccessorKeyProvider::with_options("test-mcp", "default", missing).unwrap();
    assert_eq!(code(keys.get_key(&none)), Some(Code::StoreError));
}

#[test]
fn a_read_that_overflows_stdout_is_killed_before_its_deadline() {
    let fake = Fake::new(
        r#"echo $$ > "$d/pid"; head -c 257 /dev/zero; exec sleep 30"#,
        ADD,
    );
    assert_eq!(
        code(fake.keys().get_key(&Cancel::default())),
        Some(Code::StoreError)
    );
    fake.assert_killed();
}

#[test]
fn a_hung_read_is_killed_at_its_deadline_or_on_cancel() {
    let fake = Fake::new(HANG, ADD);
    let brief = Duration::from_millis(200);
    let keys = fake.keys_with(KeychainAccessorOptions {
        read_timeout: brief,
        ..fake.options.clone()
    });

    assert_eq!(
        code(keys.get_key(&Cancel::default())),
        Some(Code::StoreTimeout)
    );
    fake.assert_killed();

    assert_eq!(
        code(fake.keys().get_key(&cancel_after(brief))),
        Some(Code::Cancelled)
    );
    fake.assert_killed();
    assert_eq!(code(keys.get_key(&cancelled())), Some(Code::Cancelled));
}

#[test]
fn a_setup_write_that_is_not_confirmed_is_uncertain_and_never_retried() {
    let none = Cancel::default();

    // Another key landed, -i exited 0 after a failed command, or the write failed outright.
    for add in [
        r#"printf '%064d\n' 0 > "$d/item""#.to_owned(),
        "true".to_owned(),
        format!("{ADD}; exit 45"),
    ] {
        let fake = Fake::new(FIND, &add);
        assert_eq!(
            code(fake.keys().create_key(&none)),
            Some(Code::StoreWriteUncertain),
            "{add}"
        );
        assert_eq!(
            fake.read("argv")
                .lines()
                .filter(|line| *line == "-i")
                .count(),
            1
        );
    }

    let fake = Fake::new(FIND, HANG);
    let brief = Duration::from_millis(200);
    let keys = fake.keys_with(KeychainAccessorOptions {
        create_timeout: brief,
        ..fake.options.clone()
    });

    assert_eq!(
        code(keys.create_key(&none)),
        Some(Code::StoreWriteUncertain)
    );
    fake.assert_killed();
    assert_eq!(
        code(fake.keys().create_key(&cancel_after(brief))),
        Some(Code::StoreWriteUncertain)
    );
    fake.assert_killed();
    assert_eq!(code(keys.create_key(&cancelled())), Some(Code::Cancelled));
}

#[test]
fn keychain_names_are_validated() {
    for (server, profile) in [
        ("test mcp", "default"),
        ("test-mcp", "-w"),
        ("test-mcp", ""),
    ] {
        let refused = KeychainAccessorKeyProvider::new(server, profile).map(|_| ());
        assert_eq!(code(refused), Some(Code::InvalidArgument));
    }
}

#[test]
fn default_key_providers_and_record_paths_follow_the_platform_and_xdg() {
    let _environment = ENVIRONMENT.lock().unwrap();
    let scratch = Scratch::new();
    let home = PathBuf::from(std::env::var_os("HOME").unwrap());
    let code_of = |os, server| code(key_provider_for(os, server, "default").map(|_| ()));

    // Paths only: nothing here may create a key under the real home directory. A provider's key
    // path shows in where its setup puts the key, so only the scratch-directory case is set up.
    let darwin = key_provider_for("macos", "test-mcp", "default").unwrap();
    assert_eq!(darwin.key_source(), "keychain-accessor");
    assert_eq!(code_of("windows", "test-mcp"), Some(Code::StoreUnavailable));
    assert_eq!(code_of("linux", "../x"), Some(Code::InvalidArgument));

    // `set_var` is unsafe in edition 2024, so the variables are set for a child process.
    let probe = |data: &str, config: &str| {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "print_default_paths", "--nocapture", "--ignored"])
            .env("XDG_DATA_HOME", data)
            .env("XDG_CONFIG_HOME", config)
            .output()
            .unwrap();
        String::from_utf8(output.stdout).unwrap()
    };

    let data = scratch.join("data");
    let absolute = probe(data.to_str().unwrap(), "/config/../config");
    assert!(
        absolute.contains("record=/config/test-mcp/session.enc\n"),
        "{absolute}"
    );
    assert!(
        absolute.contains("session=/config/test-mcp/session.json\n"),
        "{absolute}"
    );
    assert!(absolute.contains("created=true\n"), "{absolute}");
    let key = data
        .join("family-mcp")
        .join("keys")
        .join("test-mcp.work.key");
    assert_eq!(fs::read(&key).unwrap().len(), 32);
    assert_eq!(mode(&key), 0o600);

    let relative = probe("relative/data", "relative/config");
    let expected = home.join(".config").join("test-mcp").join("session.enc");
    assert!(
        relative.contains(&format!("record={}\n", expected.display())),
        "{relative}"
    );
    assert!(relative.contains("created=false\n"), "{relative}");
}

/// Run by the test above in a child process whose XDG variables it chose.
#[test]
#[ignore = "helper for default_key_providers_and_record_paths_follow_the_platform_and_xdg"]
fn print_default_paths() {
    println!(
        "record={}",
        default_secret_record_path("test-mcp").unwrap().display()
    );
    println!(
        "session={}",
        default_session_path("test-mcp", None).unwrap().display()
    );
    assert_eq!(
        code(default_secret_record_path("../escape")),
        Some(Code::InvalidArgument)
    );
    // Only an absolute XDG_DATA_HOME, which the parent points at its scratch directory, is set up.
    let scratch_data = std::env::var("XDG_DATA_HOME").is_ok_and(|data| data.starts_with('/'));
    let keys = key_provider_for("linux", "test-mcp", "work").unwrap();
    let created = scratch_data && keys.create_key(&Cancel::default()).is_ok();
    println!("created={created}");
}
