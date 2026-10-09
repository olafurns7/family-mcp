use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};

use crate::errors::{Cancel, Code, Error, Result};
use crate::files::random;
use crate::keys::{KEY_BYTES, Key, KeyProvider, key_exists, key_unavailable, malformed_key};
use crate::secret::check_names;

const SECURITY: &str = "/usr/bin/security";

const PATH: &str = "/usr/bin:/bin";

// Larger output is never a key; the child is killed once it exceeds this.
const MAX_OUTPUT_BYTES: usize = 256;

const POLL: Duration = Duration::from_millis(10);

#[derive(Debug, Clone)]
pub struct KeychainAccessorOptions {
    /// Recorded in the marker. Default `keychain`.
    pub key_id: String,
    /// Longest key read before the child is killed with STORE_TIMEOUT. Default 10 s.
    pub read_timeout: Duration,
    /// Longest interactive key creation before the child is killed. Default 120 s.
    pub create_timeout: Duration,
    /// Test seam only: the accessor executable. Default `/usr/bin/security`.
    pub accessor: PathBuf,
}

impl Default for KeychainAccessorOptions {
    fn default() -> Self {
        Self {
            key_id: "keychain".to_owned(),
            read_timeout: Duration::from_secs(10),
            create_timeout: Duration::from_secs(120),
            accessor: SECURITY.into(),
        }
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Failure {
    Timeout,
    Aborted,
    Failed,
}

struct Run {
    status: Option<i32>,
    stdout: Vec<u8>,
    failure: Option<Failure>,
}

/// The data key in a default-keychain generic password (service `family-mcp.<server>`, account
/// `<profile>.data-key`) as 64 lowercase hex characters, whose ACL trusts Apple's
/// `/usr/bin/security`. Any same-user process can fetch it while the keychain is unlocked.
pub struct KeychainAccessorKeyProvider {
    service: String,
    account: String,
    options: KeychainAccessorOptions,
}

impl KeychainAccessorKeyProvider {
    pub fn new(server: &str, profile: &str) -> Result<Self> {
        Self::with_options(server, profile, KeychainAccessorOptions::default())
    }

    pub fn with_options(
        server: &str,
        profile: &str,
        options: KeychainAccessorOptions,
    ) -> Result<Self> {
        check_names(&[server, profile])?;
        Ok(Self {
            service: format!("family-mcp.{server}"),
            account: format!("{profile}.data-key"),
            options,
        })
    }

    fn run(&self, args: &[&str], input: Option<&str>, timeout: Duration, cancel: &Cancel) -> Run {
        let mut command = Command::new(&self.options.accessor);
        // A minimal environment: no inherited tokens or credentials reach the child.
        command.args(args).env_clear().env("PATH", PATH);

        if let Some(home) = std::env::var_os("HOME") {
            command.env("HOME", home);
        }
        command
            .stdin(if input.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let failed = Run {
            status: None,
            stdout: Vec::new(),
            failure: Some(Failure::Failed),
        };
        let Ok(mut child) = command.spawn() else {
            return failed;
        };

        if let (Some(mut stdin), Some(input)) = (child.stdin.take(), input) {
            // A child that never reads its input still fails by its status or its deadline.
            let _ = stdin.write_all(input.as_bytes());
        }
        let Some(pipe) = child.stdout.take() else {
            let _ = child.kill();
            let _ = child.wait();
            return failed;
        };
        let (sender, receiver) = mpsc::channel();

        std::thread::spawn(move || {
            let mut stdout = Vec::new();
            let _ = pipe
                .take(MAX_OUTPUT_BYTES as u64 + 1)
                .read_to_end(&mut stdout);
            let _ = sender.send(stdout);
        });
        let deadline = Instant::now() + timeout;
        let mut failure = None;

        // The reader ends at end of output or one byte past the limit, whichever comes first.
        let stdout = loop {
            if cancel.is_cancelled() {
                failure = Some(Failure::Aborted);
            } else if Instant::now() >= deadline {
                failure = Some(Failure::Timeout);
            }

            if failure.is_some() {
                break Vec::new();
            }

            match receiver.recv_timeout(POLL) {
                Ok(stdout) => {
                    if stdout.len() > MAX_OUTPUT_BYTES {
                        failure = Some(Failure::Failed);
                    }
                    break stdout;
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    failure = Some(Failure::Failed);
                    break Vec::new();
                }
            }
        };

        if failure.is_some() {
            let _ = child.kill();
        }

        // The wait follows both a normal exit and a kill, so no child outlives the call.
        Run {
            status: child.wait().ok().and_then(|status| status.code()),
            stdout,
            failure,
        }
    }
}

impl KeyProvider for KeychainAccessorKeyProvider {
    fn backend(&self) -> &str {
        "encrypted-file"
    }

    fn key_source(&self) -> &str {
        "keychain-accessor"
    }

    fn key_id(&self) -> &str {
        &self.options.key_id
    }

    fn get_key(&self, cancel: &Cancel) -> Result<Key> {
        cancel.check()?;
        let mut run = self.run(
            &[
                "find-generic-password",
                "-s",
                &self.service,
                "-a",
                &self.account,
                "-w",
            ],
            None,
            self.options.read_timeout,
            cancel,
        );
        let key = if run.failure == Some(Failure::Aborted) {
            cancel.check().and_then(|()| parse_key(&run))
        } else {
            parse_key(&run)
        };
        run.stdout.fill(0);
        key
    }

    fn create_key(&self, cancel: &Cancel) -> Result<()> {
        match self.get_key(cancel) {
            Ok(_) => return Err(key_exists()),
            Err(error) if error.code == Code::StoreUnavailable => {}
            Err(error) => return Err(error),
        }
        cancel.check()?;
        let key = random::<KEY_BYTES>()?;
        // No -U (never update an item) and no -A (no allow-all ACL); only the Apple tool is trusted.
        let mut command = format!(
            "add-generic-password -s {} -a {} -w {} -T {SECURITY}\n",
            self.service,
            self.account,
            hex(&key)
        );
        // `-i` reads the command from stdin, so the key never appears in any process's argv.
        let run = self.run(&["-i"], Some(&command), self.options.create_timeout, cancel);
        command.clear();

        if run.failure.is_some() || run.status != Some(0) {
            return Err(uncertain_key());
        }
        // `-i` exits with the last command's status; a zero status still needs the stored key to
        // equal the generated one.
        let written = self.get_key(cancel).map_err(|_| uncertain_key())?;
        let different = written
            .iter()
            .zip(&key)
            .fold(0, |sum, (left, right)| sum | (left ^ right));

        if different != 0 {
            return Err(uncertain_key());
        }
        Ok(())
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/*
 * security(1) exits with its command's OSStatus truncated to 8 bits, also after `-i` (the last
 * command's result). Apple Security-61901.80.25: SecurityTool/macOS/security.c main() and
 * execute_command(), keychain_find.c do_keychain_find_generic_password(); values from
 * base/SecBase.h.
 */
fn parse_key(run: &Run) -> Result<Key> {
    if run.failure == Some(Failure::Timeout) {
        return Err(Error::new(
            Code::StoreTimeout,
            "The keychain did not answer in time.",
        ));
    }
    let locked = || {
        Error::new(
            Code::StoreLocked,
            "The keychain is locked or cannot ask for access now. Unlock it and try again.",
        )
    };
    let denied = || {
        Error::new(
            Code::StoreAccessDenied,
            "Access to the store key was denied.",
        )
    };

    match (run.failure, run.status) {
        // `find-generic-password -w` prints a printable password as is, then a newline.
        (None, Some(0)) => run
            .stdout
            .strip_suffix(b"\n")
            .filter(|digits| digits.len() == KEY_BYTES * 2)
            .and_then(|digits| {
                let mut key = [0; KEY_BYTES];

                for (byte, pair) in key.iter_mut().zip(digits.chunks(2)) {
                    *byte = lower_hex(pair[0])? << 4 | lower_hex(pair[1])?;
                }
                Some(key)
            })
            .ok_or_else(malformed_key),
        (None, Some(44)) => Err(key_unavailable()), // errSecItemNotFound -25300
        // errSecInteractionNotAllowed -25308 (also a locked keychain without UI) and
        // errSecInteractionRequired -25315
        (None, Some(36 | 29)) => Err(locked()),
        (None, Some(51 | 128)) => Err(denied()), // errSecAuthFailed -25293, errSecUserCanceled -128
        _ => Err(Error::new(
            Code::StoreError,
            "The keychain could not read the store key.",
        )),
    }
}

fn lower_hex(digit: u8) -> Option<u8> {
    match digit {
        b'0'..=b'9' => Some(digit - b'0'),
        b'a'..=b'f' => Some(digit - b'a' + 10),
        _ => None,
    }
}

fn uncertain_key() -> Error {
    Error::new(
        Code::StoreWriteUncertain,
        "The new store key could not be confirmed. Check the keychain before setting up again.",
    )
}
