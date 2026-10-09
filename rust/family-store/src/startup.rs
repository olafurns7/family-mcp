use std::path::{Path, PathBuf};

use crate::errors::{Code, Error, Result};
use crate::secret::{SecretRecordOptions, StoreCheck, check_secret_store};

/// A server CLI's preflight before it serves or runs a store command: [`check_secret_store`],
/// then `<server>: cannot start. <message>` with the quoted path and the command that fixes it on
/// their own lines, and `false`, when the store is unsafe; or a notice with the exact cleanup
/// commands when an earlier build's store is still on disk. `server` is the command name, such
/// as `abler-mcp`, and `sign_in` the command that signs in again. `store` builds the store's
/// options inside the check, so an unknown home is reported too. `write` takes the lines; give it
/// stderr, never stdout, which carries the MCP transport. An INVALID_ARGUMENT error is a bug, not
/// a store refusal, and is returned instead of hidden.
pub fn startup_check(
    server: &str,
    sign_in: &str,
    store: impl FnOnce() -> Result<SecretRecordOptions>,
    write: &mut dyn FnMut(&str),
) -> Result<bool> {
    let result = match store().and_then(|options| check_secret_store(&options)) {
        Ok(result) => result,
        Err(error) if error.code == Code::InvalidArgument => return Err(error),
        Err(error) => {
            write(&refusal(server, &error));
            return Ok(false);
        }
    };

    if !result.retired.is_empty() {
        write(&retired_notice(server, sign_in, &result));
    }
    Ok(true)
}

fn refusal(server: &str, error: &Error) -> String {
    let mut lines = vec![format!("{server}: cannot start. {}", error.message)];

    if let Some(path) = error.path().filter(|path| !path.as_os_str().is_empty()) {
        lines.push(format!("  Path: {}", quote(path)));

        if let Some(fix) = error.fix() {
            lines.push(format!("  Fix:  {fix} {}", quote(path)));
        }
    }
    lines.push(String::new());
    lines.join("\n")
}

fn retired_notice(server: &str, sign_in: &str, result: &StoreCheck) -> String {
    let is_lock = |path: &&PathBuf| path.as_os_str().as_encoded_bytes().ends_with(b".lock");
    let files: Vec<&PathBuf> = result
        .retired
        .iter()
        .filter(|path| !is_lock(path))
        .collect();
    let locks: Vec<&PathBuf> = result.retired.iter().filter(is_lock).collect();
    let has_key_file = files.iter().any(|path| {
        path.file_name()
            .is_some_and(|name| name.to_string_lossy().ends_with(".key"))
    });
    let mut lines = vec![format!(
        "{server}: an earlier test build left an old session store. Nothing uses it:"
    )];
    lines.extend(
        result
            .retired
            .iter()
            .map(|path| format!("  {}", path.display())),
    );

    if !result.exists {
        lines.push(format!("Sign in again: {sign_in}"));
    }
    lines.push(format!(
        "After the new sign-in works, quit your MCP host (for example Claude Desktop) so no {server} is running, then remove the old files:"
    ));

    if !files.is_empty() {
        let quoted: Vec<String> = files.iter().map(|path| quote(path)).collect();
        lines.push(format!("  rm {}", quoted.join(" ")));
    }
    lines.extend(locks.iter().map(|path| format!("  rm -r {}", quote(path))));

    if !has_key_file {
        lines.push(
            "If that build kept its key in the macOS Keychain, remove that too (macOS may ask for your login password):"
                .to_owned(),
        );
        lines.push(format!(
            "  security delete-generic-password -s family-mcp.{server} -a default.data-key"
        ));
    }
    lines.push(
        "Time Machine backups made before today may still hold copies of those files.".to_owned(),
    );
    lines.push(String::new());
    lines.join("\n")
}

/// A single-quoted shell word, so a path with spaces or quotes still pastes.
fn quote(path: &Path) -> String {
    format!("'{}'", path.to_string_lossy().replace('\'', r"'\''"))
}
