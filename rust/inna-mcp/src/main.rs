//! inna-mcp: the command line of packages/inna-mcp/src/cli.ts.

mod absence;
mod client;
mod dates;
mod error;
mod html;
mod input;
mod jar;
mod js;
mod keep_alive;
mod server;
mod session;
mod shapes;
mod signal;
mod store;
mod upstream;

use std::io::Write;
use std::process::ExitCode;

use crate::error::{Fail, Result};

const HELP: &str = "inna-mcp — unofficial Inna school MCP (preview)

  inna-mcp [serve]                    Start the read-only stdio MCP server
  inna-mcp serve --allow-absence-writes Also expose confirmed whole-day illness/leave requests
  inna-mcp serve --no-keep-alive      Do not touch the saved session every 10 minutes while serving
  inna-mcp auth login                 Electronic ID: hidden phone prompt; approve on your phone
  inna-mcp auth login --google        Google: sign in in the browser window that opens
  inna-mcp auth import FILE           Fallback without a desktop: save a private cookie export
  inna-mcp auth status                Verify the saved session and say how it is saved
  inna-mcp auth migrate               Move an older version's plaintext session into the encrypted store
  inna-mcp auth logout                Remove the local session; retain absence evidence
  inna-mcp --version                  Print the executable version

auth login --google opens Google Chrome or Chromium on Inna's Google sign-in, saves the
session when you finish, and closes the window. The Google account must be linked in Inna.
It needs a desktop; nothing is copied or pasted. Options: --timeout <seconds> (default 300),
--browser <path> or INNA_BROWSER to choose the browser.
auth import is for a machine without a desktop: export only nam.inna.is cookies to an
owner-only local JSON file. Never paste cookies or passwords in chat.
The session is saved encrypted. INNA_SESSION_FILE names an older version's absolute plaintext
session path; the private absence record stays in a plaintext file beside that path.
Login/import refuse a changed account/student/school unless --allow-account-change is given.
";

/// What the CLI prints for a failure without a reviewed message, `parseArgs` errors included.
const FAILED: &str =
    "Inna MCP failed. Check input format, file permissions, and local configuration.";

const INVALID_COMMAND: Fail = Fail::Safe("Invalid command. Run inna-mcp --help.");

#[derive(Debug, Default)]
struct Args {
    help: bool,
    version: bool,
    allow_absence_writes: bool,
    allow_account_change: bool,
    no_keep_alive: bool,
    google: bool,
    timeout: Option<String>,
    browser: Option<String>,
    positionals: Vec<String>,
}

/// node:util `parseArgs` in strict mode with these options and positionals allowed. Its errors
/// are not `SafeError`s, so each one prints the CLI's generic failure.
fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Args> {
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
                "allow-absence-writes" => &mut parsed.allow_absence_writes,
                "allow-account-change" => &mut parsed.allow_account_change,
                "no-keep-alive" => &mut parsed.no_keep_alive,
                "google" => &mut parsed.google,
                "timeout" | "browser" => {
                    // The next argument is the value, unless it looks like another option.
                    let value = match inline {
                        Some(value) => value,
                        None => args
                            .next()
                            .filter(|value| !(value.len() > 1 && value.starts_with('-')))
                            .ok_or(Fail::Unknown)?,
                    };
                    *match name {
                        "timeout" => &mut parsed.timeout,
                        _ => &mut parsed.browser,
                    } = Some(value);
                    continue;
                }
                _ => return Err(Fail::Unknown),
            };

            if inline.is_some() {
                return Err(Fail::Unknown);
            }
            *flag = true;
        } else if let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) {
            for short in shorts.chars() {
                match short {
                    'h' => parsed.help = true,
                    'v' => parsed.version = true,
                    _ => return Err(Fail::Unknown),
                }
            }
        } else {
            parsed.positionals.push(arg);
        }
    }
    Ok(parsed)
}

/// What a valid command line asks for, after help and version.
#[derive(Debug, PartialEq)]
enum Command {
    Serve {
        allow_absence_writes: bool,
        keep_alive: bool,
    },
    Login {
        google: bool,
        allow_account_change: bool,
        timeout: Option<String>,
        browser: Option<String>,
    },
    Import {
        source: String,
        allow_account_change: bool,
    },
    Status,
    Migrate,
    Logout,
}

/// cli.ts's routing, in its order.
fn route(args: Args) -> Result<Command> {
    let positionals: Vec<&str> = args.positionals.iter().map(String::as_str).collect();
    let command = positionals.first().copied().unwrap_or("serve");
    let (action, source) = (positionals.get(1).copied(), positionals.get(2).copied());
    let browser_options = args.timeout.is_some() || args.browser.is_some();

    if (args.google || browser_options)
        && !(args.google && command == "auth" && action == Some("login") && positionals.len() == 2)
    {
        return Err(INVALID_COMMAND);
    }

    if command == "serve" && positionals.len() <= 1 && !args.allow_account_change {
        return Ok(Command::Serve {
            allow_absence_writes: args.allow_absence_writes,
            keep_alive: !args.no_keep_alive,
        });
    }

    if command != "auth" || args.allow_absence_writes || args.no_keep_alive {
        return Err(INVALID_COMMAND);
    }

    if action == Some("login") && positionals.len() == 2 {
        return Ok(Command::Login {
            google: args.google,
            allow_account_change: args.allow_account_change,
            timeout: args.timeout,
            browser: args.browser,
        });
    }

    // JavaScript's `source &&`: an empty source counts as none.
    if let Some(source) = source.filter(|source| !source.is_empty())
        && action == Some("import")
        && positionals.len() == 3
    {
        return Ok(Command::Import {
            source: source.to_owned(),
            allow_account_change: args.allow_account_change,
        });
    }

    if positionals.len() != 2 || args.allow_account_change {
        return Err(INVALID_COMMAND);
    }

    match action {
        Some("status") => Ok(Command::Status),
        Some("migrate") => Ok(Command::Migrate),
        Some("logout") => Ok(Command::Logout),
        _ => Err(INVALID_COMMAND),
    }
}

/// Serve until stdin ends or SIGINT or SIGTERM arrives, then stop the keep-alive and wait for
/// operations in flight. The session path is checked first, as the keep-alive's client is
/// built before serving; TypeScript without the keep-alive would only refuse each request.
async fn serve(allow_absence_writes: bool, keep_alive: bool) -> Result<()> {
    let client = client::Client::from_environment(allow_absence_writes)?;
    mcp_runtime::serve_stdio(server::Inna::new(client, keep_alive))
        .await
        .map_err(|_| Fail::Unknown)
}

async fn main_async() -> Result<ExitCode> {
    let args = parse_args(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned()),
    )?;

    if args.help {
        let _ = std::io::stdout().write_all(HELP.as_bytes());
        return Ok(ExitCode::SUCCESS);
    }

    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(ExitCode::SUCCESS);
    }

    // The store is checked before anything serves or touches it; help and version never do.
    if !tokio::task::spawn_blocking(store::check_store_at_startup)
        .await
        .unwrap_or(Err(Fail::Unknown))?
    {
        return Ok(ExitCode::FAILURE);
    }

    match route(args)? {
        Command::Serve {
            allow_absence_writes,
            keep_alive,
        } => serve(allow_absence_writes, keep_alive).await?,
        // The sign-in and session commands arrive with the client and its store; until then
        // each fails closed.
        Command::Login { .. }
        | Command::Import { .. }
        | Command::Status
        | Command::Migrate
        | Command::Logout => return Err(Fail::Unknown),
    }
    Ok(ExitCode::SUCCESS)
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

    fn args(list: &[&str]) -> Result<Args> {
        parse_args(list.iter().map(|arg| (*arg).to_owned()))
    }

    fn routed(list: &[&str]) -> Result<Command> {
        args(list).and_then(route)
    }

    #[test]
    fn options_parse_like_node_parse_args() {
        let parsed = args(&[
            "auth",
            "-hv",
            "--timeout",
            "-",
            "--browser=--x",
            "--no-keep-alive",
            "--",
            "--help",
        ])
        .unwrap();
        assert!(parsed.help && parsed.version && parsed.no_keep_alive && !parsed.google);
        assert_eq!(parsed.timeout.as_deref(), Some("-"));
        assert_eq!(parsed.browser.as_deref(), Some("--x"));
        assert_eq!(parsed.positionals, ["auth", "--help"]);

        for invalid in [
            &["--timeout"][..],
            &["--timeout", "-5"],
            &["--help=1"],
            &["--google=1"],
            &["--keep-alive"],
            &["--nope"],
            &["-x"],
            &["-h=1"],
        ] {
            assert_eq!(args(invalid).unwrap_err(), Fail::Unknown, "{invalid:?}");
        }
        assert_eq!(args(&["-"]).unwrap().positionals, ["-"]);
    }

    #[test]
    fn commands_route_as_in_cli_ts() {
        let serve = |allow_absence_writes, keep_alive| Command::Serve {
            allow_absence_writes,
            keep_alive,
        };
        let login = |google, allow_account_change, timeout: Option<&str>| Command::Login {
            google,
            allow_account_change,
            timeout: timeout.map(str::to_owned),
            browser: None,
        };
        let import = |allow_account_change| Command::Import {
            source: "f.json".to_owned(),
            allow_account_change,
        };

        for (line, command) in [
            (&[][..], serve(false, true)),
            (&["serve"], serve(false, true)),
            (
                &["serve", "--allow-absence-writes", "--no-keep-alive"],
                serve(true, false),
            ),
            (&["auth", "login"], login(false, false, None)),
            (
                &["auth", "login", "--allow-account-change"],
                login(false, true, None),
            ),
            (
                &["auth", "login", "--google", "--timeout", "0"],
                login(true, false, Some("0")),
            ),
            (&["auth", "import", "f.json"], import(false)),
            (
                &["auth", "import", "f.json", "--allow-account-change"],
                import(true),
            ),
            (&["auth", "status"], Command::Status),
            (&["auth", "migrate"], Command::Migrate),
            (&["auth", "logout"], Command::Logout),
        ] {
            assert_eq!(routed(line).unwrap(), command, "{line:?}");
        }

        for line in [
            &["auth"][..],
            &["x"],
            &[""],
            &["serve", "x"],
            &["serve", "--allow-account-change"],
            &["serve", "--google"],
            &["--timeout", "5"],
            &["auth", "login", "--timeout", "5"],
            &["auth", "login", "--browser", "b"],
            &["auth", "login", "x", "--google"],
            &["auth", "status", "--google"],
            &["auth", "login", "--allow-absence-writes"],
            &["auth", "logout", "--no-keep-alive"],
            &["auth", "import"],
            &["auth", "import", ""],
            &["auth", "import", "a", "b"],
            &["auth", "status", "x"],
            &["auth", "status", "--allow-account-change"],
            &["auth", "bogus"],
            &["auth", "", "x"],
        ] {
            assert_eq!(routed(line).unwrap_err(), INVALID_COMMAND, "{line:?}");
        }
    }

    #[test]
    fn help_is_cli_ts_text() {
        assert!(HELP.ends_with("unless --allow-account-change is given.\n"));
        assert!(!HELP.ends_with("\n\n"));
    }
}
