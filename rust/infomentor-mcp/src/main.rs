//! infomentor-mcp: the command line of packages/infomentor-mcp/src/cli.ts.

mod error;
mod js;
mod server;
mod store;
mod upstream;

use std::process::ExitCode;

use crate::error::{Fail, Result};

const HELP: &str = "Usage: infomentor-mcp [auth] [command] [options]

Commands:
  login              Sign in over HTTPS using privately injected secrets or a credentials file;
                     the session and that sign-in are saved in the encrypted store
  status             Verify the saved session and show how it is stored
  migrate            Move a session saved by an older version out of its plaintext file;
                     with --credentials, also store that sign-in for automatic renewal
  logout             Delete the local session and stored sign-in (does not revoke it on
                     InfoMentor)
  serve              Start the stdio MCP server (default)

Options:
  --session FILE     Older plaintext session file, read until auth migrate or the next
                     login or import; collection cursors stay beside it (default:
                     ~/.config/infomentor-mcp/session.json, or
                     ~/.infomentor-mcp/session.json when that legacy file exists)
  --credentials FILE Private JSON file with username/password (login, migrate, and renewal
                     when no sign-in is stored)
  --import FILE      login: validate and import a session on a headless machine
  --timeout SECONDS  login: maximum wait (default: 300)
  --allow-account-change
                     login: replace a saved session that belongs to another account
  --allow-setup-tools
                     serve: also register the login, setup-status, cancel, and logout tools
  -h, --help         Show help
  -v, --version      Show version

Environment: INFOMENTOR_SESSION_PATH, INFOMENTOR_CREDENTIALS_FILE,
             INFOMENTOR_USERNAME (kennitala or username), INFOMENTOR_PASSWORD

The session and the stored sign-in are saved encrypted, with the key in a separate private
file: ~/Library/Application Support/family-mcp on macOS; ~/.config/infomentor-mcp with the key
in ~/.local/share/family-mcp/keys on Linux.";

/// What the CLI prints for a failure without a reviewed message.
const FAILED: &str =
    "InfoMentor operation failed. Check the network and session-store permissions.";

const NOT_YET: Fail = Fail::Safe("This InfoMentor command is not available in this build yet.");

#[derive(Default)]
struct Args {
    session: Option<String>,
    credentials: Option<String>,
    import: Option<String>,
    timeout: Option<String>,
    allow_account_change: bool,
    allow_setup_tools: bool,
    help: bool,
    version: bool,
    positionals: Vec<String>,
}

/// node:util `parseArgs` in strict mode with these options and positionals allowed; `None` where
/// it throws.
fn parse_args(args: impl IntoIterator<Item = String>) -> Option<Args> {
    let mut parsed = Args::default();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        if arg == "--" {
            parsed.positionals.extend(args.by_ref());
        } else if let Some(long) = arg.strip_prefix("--") {
            let (name, inline) = match long.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (long, None),
            };
            let flag = match name {
                "help" => &mut parsed.help,
                "version" => &mut parsed.version,
                "allow-account-change" => &mut parsed.allow_account_change,
                "allow-setup-tools" => &mut parsed.allow_setup_tools,
                "session" | "credentials" | "import" | "timeout" => {
                    // The next argument is the value, unless it looks like another option.
                    let value = match inline {
                        Some(value) => value,
                        None => args
                            .next()
                            .filter(|value| !(value.len() > 1 && value.starts_with('-')))?,
                    };
                    *match name {
                        "session" => &mut parsed.session,
                        "credentials" => &mut parsed.credentials,
                        "import" => &mut parsed.import,
                        _ => &mut parsed.timeout,
                    } = Some(value);
                    continue;
                }
                _ => return None,
            };

            if inline.is_some() {
                return None;
            }
            *flag = true;
        } else if let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) {
            for short in shorts.chars() {
                match short {
                    'h' => parsed.help = true,
                    'v' => parsed.version = true,
                    _ => return None,
                }
            }
        } else {
            parsed.positionals.push(arg);
        }
    }
    Some(parsed)
}

/// `z.coerce.number().int().positive().max(3600)` of the `--timeout` text, in seconds.
fn parse_timeout(value: Option<&str>) -> Result<f64> {
    let seconds = js::number(value.unwrap_or("300"));

    if seconds.fract() != 0.0 || !(1.0..=3600.0).contains(&seconds) {
        return Err(Fail::Safe(
            "Timeout must be between 0 and 3600 seconds, excluding 0.",
        ));
    }
    Ok(seconds)
}

/// JavaScript truthiness of a string option: an empty value counts as none.
fn given(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|value| !value.is_empty())
}

/// Serve until stdin ends or SIGINT or SIGTERM arrives, then cancel and wait for operations.
async fn serve(allow_setup_tools: bool) -> Result<()> {
    mcp_runtime::serve_stdio(server::InfoMentor::new(allow_setup_tools))
        .await
        .map_err(|_| Fail::Unknown)
}

/// The session commands. Blocks.
fn command(command: &str, args: &Args) -> Result<()> {
    match command {
        "login" => {
            if given(&args.import) {
                return Err(NOT_YET);
            }
            parse_timeout(args.timeout.as_deref())?;
            Err(NOT_YET)
        }
        "migrate" | "status" | "logout" => Err(NOT_YET),
        _ => Err(Fail::Safe("Unknown command. Run infomentor-mcp --help.")),
    }
}

async fn main_async() -> Result<ExitCode> {
    let raw: Vec<String> = std::env::args_os()
        .skip(1)
        .map(|arg| arg.to_string_lossy().into_owned())
        .collect();
    let Some(args) = parse_args(raw.iter().cloned()) else {
        // Retired: a stale password form can submit to a replacement loopback listener.
        let local_form = raw
            .iter()
            .any(|arg| arg == "--local-form" || arg.starts_with("--local-form="));
        return Err(Fail::Safe(match local_form {
            true => {
                "--local-form has been removed. Use --credentials with a private JSON file or privately inject INFOMENTOR_USERNAME and INFOMENTOR_PASSWORD."
            }
            false => "Invalid arguments. Run infomentor-mcp --help.",
        }));
    };

    if args.help {
        println!("{HELP}");
        return Ok(ExitCode::SUCCESS);
    }

    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(ExitCode::SUCCESS);
    }

    // A test build refuses to start without a local fake upstream.
    #[cfg(feature = "test-origin")]
    upstream::test_origin();

    // The store is checked before anything serves or touches it; help and version never do.
    if !tokio::task::spawn_blocking(store::check_store_at_startup)
        .await
        .unwrap_or(Err(Fail::Unknown))?
    {
        return Ok(ExitCode::FAILURE);
    }

    // `auth login` and `login` are the same command.
    let auth = args
        .positionals
        .first()
        .is_some_and(|first| first == "auth");
    let words = &args.positionals[usize::from(auth)..];

    if words.len() > 1 || (auth && words.is_empty()) {
        return Err(Fail::Safe(
            "Unexpected arguments. Run infomentor-mcp --help.",
        ));
    }
    let name = words.first().map_or("serve", String::as_str).to_owned();

    if name != "login" && (given(&args.import) || given(&args.timeout) || args.allow_account_change)
    {
        return Err(Fail::Safe("Login options only apply to login."));
    }

    if name != "serve" && args.allow_setup_tools {
        return Err(Fail::Safe("Server options only apply to serve."));
    }

    if given(&args.import) && given(&args.credentials) {
        return Err(Fail::Safe("Choose session import or login, not both."));
    }

    if name == "serve" {
        return serve(args.allow_setup_tools)
            .await
            .map(|()| ExitCode::SUCCESS);
    }
    tokio::task::spawn_blocking(move || command(&name, &args))
        .await
        .unwrap_or(Err(Fail::Unknown))
        .map(|()| ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    // current_thread: one stdio client and I/O-bound work. Store work runs on blocking threads,
    // which wait for requests while this thread drives them.
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Fail::Unknown)
        .and_then(|runtime| {
            let outcome = runtime.block_on(main_async());
            // Every operation has ended; only the stdin reader may still block, so do not wait.
            runtime.shutdown_background();
            outcome
        });

    match outcome {
        Ok(code) => code,
        Err(fail) => {
            // Only reviewed diagnostics cross the terminal boundary; library messages may hold secrets.
            eprintln!("{}", mcp_runtime::cli_text(fail, FAILED));
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Option<Args> {
        parse_args(list.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn options_parse_like_node_parse_args() {
        let parsed = args(&[
            "auth",
            "-hv",
            "--timeout",
            "-",
            "--import=--x",
            "--credentials",
            "",
            "--allow-setup-tools",
            "--",
            "--help",
        ])
        .unwrap();
        assert!(parsed.help && parsed.version && parsed.allow_setup_tools);
        assert!(!parsed.allow_account_change);
        assert_eq!(parsed.timeout.as_deref(), Some("-"));
        assert_eq!(parsed.import.as_deref(), Some("--x"));
        assert_eq!(parsed.credentials.as_deref(), Some(""));
        assert_eq!(parsed.positionals, ["auth", "--help"]);

        for invalid in [
            &["--timeout"][..],
            &["--session", "-5"],
            &["--help=1"],
            &["--allow-setup-tools="],
            &["--local-form"],
            &["-x"],
            &["-h=1"],
        ] {
            assert!(args(invalid).is_none(), "{invalid:?}");
        }
        assert_eq!(args(&["-"]).unwrap().positionals, ["-"]);
    }

    #[test]
    fn timeouts_read_like_zod_coerced_numbers() {
        for (text, seconds) in [
            ("  5 ", 5.0),
            ("0x10", 16.0),
            ("3.6e3", 3600.0),
            ("+7", 7.0),
        ] {
            assert_eq!(parse_timeout(Some(text)).unwrap(), seconds, "{text}");
        }

        for text in ["", "0", "1.5", "-3", "3601", "inf", "Infinity", "nan", "0x"] {
            assert!(parse_timeout(Some(text)).is_err(), "{text}");
        }
        assert_eq!(parse_timeout(None).unwrap(), 300.0);
    }
}
