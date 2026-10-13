//! inna-mcp: the command line of packages/inna-mcp/src/cli.ts.

mod absence;
mod auth;
mod client;
mod dates;
mod error;
mod google;
mod html;
mod input;
mod jar;
mod js;
mod keep_alive;
mod login;
mod server;
mod session;
mod shapes;
mod sign_in;
mod signal;
mod store;
mod terminal;
mod upstream;

use std::io::Write;
use std::process::ExitCode;
use std::sync::Arc;

use crate::error::{Fail, Result};

const HELP: &str = "inna-mcp — unofficial Inna school MCP (preview)

  inna-mcp [serve]                    Start the read-only stdio MCP server
  inna-mcp serve --allow-absence-writes Also expose confirmed whole-day illness/leave requests
  inna-mcp serve --no-keep-alive      Disable optional 10-minute touches; mandatory renewal still runs before 30 minutes
  inna-mcp auth login                 Electronic ID: hidden phone prompt; approve on your phone
  inna-mcp auth login --google        Google: sign in in the browser window that opens
  inna-mcp auth import FILE           Fallback without a desktop: save a private cookie export
  inna-mcp auth status                Verify the saved session and say how it is saved
  inna-mcp auth renew                 Renew the saved session once, for a timer; prints nothing on success
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
    Renew,
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
        Some("renew") => Ok(Command::Renew),
        Some("migrate") => Ok(Command::Migrate),
        Some("logout") => Ok(Command::Logout),
        _ => Err(INVALID_COMMAND),
    }
}

/// Serve until stdin ends, the connection breaks (a failed stdout write or an input line over
/// 10 MiB), or SIGINT or SIGTERM arrives, then stop the keep-alive and wait for operations in
/// flight. The session path is checked first, as the keep-alive's client is built before serving;
/// TypeScript without the keep-alive would only refuse each request.
async fn serve(allow_absence_writes: bool, keep_alive: bool) -> Result<()> {
    let client = client::Client::from_environment(allow_absence_writes)?;
    mcp_runtime::serve_stdio(server::Inna::new(client, keep_alive))
        .await
        .map_err(|_| Fail::Unknown)
}

/// `reportSaved`.
fn report_saved(saved: &auth::SavedSession) {
    if saved.replaced {
        println!("The old Inna session store could not be read without its key and was replaced.");
    }
    println!("Signed in. {}", saved.storage);
}

/// The session commands other than sign-in: no signal is handled, so SIGINT and SIGTERM end the
/// process as they end the TypeScript CLI.
async fn session_command(command: Command) -> Result<()> {
    let client = Arc::new(client::Client::from_environment(false)?);
    let never = signal::Signal::default();

    match command {
        Command::Import {
            source,
            allow_account_change,
        } => report_saved(
            &client
                .run(never, move |client, signal, cancel| {
                    client.import_session(&source, allow_account_change, signal, cancel)
                })
                .await?,
        ),
        Command::Status => {
            let status = client
                .run(never, |client, signal, cancel| {
                    client.status(signal, cancel, None)
                })
                .await?;

            let stored_phone = client
                .run(signal::Signal::default(), |client, _, cancel| {
                    session::locked(client.path(), cancel, |held| {
                        Ok(held.read()?.is_some_and(|saved| {
                            saved.sign_in.is_some_and(|guard| guard.phone.is_some())
                        }))
                    })
                })
                .await?;
            if stored_phone {
                println!("An electronic-ID phone number is stored.");
            }
            match status.get("storage").and_then(|storage| storage.as_str()) {
                Some(storage) => println!("Inna session is authenticated. {storage}"),
                None => println!("No saved Inna session."),
            }
        }
        Command::Migrate => println!(
            "{}",
            match client
                .run(never, |client, _, cancel| client.migrate(cancel))
                .await?
            {
                auth::Migrated::Moved => {
                    "Inna session moved to the encrypted store; the plaintext file was removed."
                }
                auth::Migrated::Already => "Already migrated.",
                auth::Migrated::AlreadyRemovedLegacy => {
                    "Already migrated. Removed the leftover plaintext session file."
                }
            }
        ),
        Command::Logout => {
            client
                .run(never, |client, _, cancel| client.logout(cancel))
                .await?;
            println!("Local Inna session removed. Absence operation evidence retained.");
        }
        Command::Serve { .. } | Command::Login { .. } | Command::Renew => {
            return Err(Fail::Unknown);
        }
    }
    Ok(())
}

/// `auth renew`'s exit codes besides 0 (renewed) and 1 (an invalid command, a refused store or
/// another failure before the renewal), as packages/inna-mcp/README.md documents them.
const NO_SESSION: u8 = 3;
const SIGN_IN_REQUIRED: u8 = 4;
const NOT_RENEWED: u8 = 5;
const PAUSED: u8 = 6;

// A renewal's failures reach a scheduler's log, so none is passed on: some store messages name
// paths. Only these fixed texts are printed. A store write that did not complete, on this renewal
// (which then removes rotated cookies) or an earlier one, leaves no usable session.
const RENEWAL_FAILED: &str = "Inna renewal failed, and Inna did not ask for sign-in. Run inna-mcp auth status in a terminal for details; a later run may succeed.";

const SESSION_UNUSABLE: &str = "The saved Inna session cannot be used, because a write to the session store did not complete. Run inna-mcp auth status in a terminal; it says what to remove before you sign in again.";

/// The exit code and fixed message for a renewal that did not renew.
fn renewal_outcome(renewal: client::Renewal) -> Option<(u8, &'static str)> {
    use client::Renewal;

    Some(match renewal {
        Renewal::Kept => return None,
        Renewal::NoSession => (
            NO_SESSION,
            mcp_runtime::cli_text(client::NO_SESSION, FAILED),
        ),
        // A fresh process has refused no credentials, so `Refused` only completes the match.
        Renewal::SignInRequired(_) | Renewal::Refused => {
            (SIGN_IN_REQUIRED, client::SIGN_IN_REQUIRED)
        }
        Renewal::Failed(fail) if fail == session::UNCERTAIN => (NOT_RENEWED, SESSION_UNUSABLE),
        // The pause Inna asked for is saved with the session.
        Renewal::Failed(fail) if fail == client::RATE_LIMITED => {
            (NOT_RENEWED, mcp_runtime::cli_text(fail, RENEWAL_FAILED))
        }
        Renewal::Failed(_) => (NOT_RENEWED, RENEWAL_FAILED),
        Renewal::Paused { .. } => (PAUSED, client::PAUSED),
    })
}

/// `auth renew`: one renewal, the one `serve`'s keep-alive timer makes, for a system timer to run.
/// It reads no school data and never switches or learns a student; success prints nothing.
async fn renew() -> Result<ExitCode> {
    let client = Arc::new(client::Client::from_environment(false)?);
    let renewal = client
        .run(signal::Signal::default(), |client, signal, cancel| {
            Ok(client.renew(signal, cancel, None))
        })
        .await?;

    Ok(match renewal_outcome(renewal) {
        None => ExitCode::SUCCESS,
        Some((code, message)) => {
            eprintln!("{message}");
            ExitCode::from(code)
        }
    })
}

const LOGIN_CANCELLED: Fail = Fail::Safe("Inna login cancelled.");

/// `signIn` from the phone prompt on: the prompt, the saved default student, the electronic-ID
/// sign-in, and the verified save, all under `signal`.
async fn sign_in_steps(
    client: Arc<client::Client>,
    allow_account_change: bool,
    signal: signal::Signal,
) -> Result<()> {
    let phone = tokio::task::spawn_blocking(|| {
        terminal::read_phone("Icelandic phone number (input hidden): ")
    })
    .await
    .unwrap_or(Err(Fail::Unknown))?;
    eprintln!();

    let Some(phone) = phone.filter(|_| !signal.aborted()) else {
        return Err(LOGIN_CANCELLED);
    };

    // A fresh login keeps the saved default student unless the owner asked to replace it.
    let preferred_user_id = match allow_account_change {
        true => None,
        false => {
            client
                .run(signal::Signal::default(), |client, _, cancel| {
                    client.default_user_id(cancel)
                })
                .await?
        }
    };
    let saved_phone = js::trim(&phone).to_owned();
    let (net, login_signal) = (client.net().clone(), signal.clone());
    let jar = tokio::task::spawn_blocking(move || {
        login::login_with_electronic_id(
            &net,
            js::trim(&phone),
            |code| {
                eprintln!(
                    "Security code {code}: verify the match and approve on your phone. Enter your PIN only on your phone."
                );
            },
            &login_signal,
            preferred_user_id,
        )
    })
    .await
    .unwrap_or(Err(Fail::Unknown))?;

    report_saved(
        &client
            .run(signal, move |client, signal, cancel| {
                client.save_sign_in(jar, allow_account_change, Some(saved_phone), signal, cancel)
            })
            .await?,
    );
    Ok(())
}

/// `signIn`. The first SIGINT cancels the sign-in, as cli.ts's `process.once('SIGINT')` does,
/// and a second ends the process. SIGTERM keeps its default action unless the phone prompt may
/// have changed the terminal's mode; then it gives the mode back first. Both then end with the
/// shell's status for the signal, by `exit` rather than by the signal itself.
async fn sign_in(client: Arc<client::Client>, allow_account_change: bool) -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};

    const SIGINT: i32 = 2;
    const SIGTERM: i32 = 15;
    let terminal = terminal::Saved::current();
    let exit = |signal: i32| -> ! {
        if let Some(terminal) = &terminal {
            terminal.restore();
        }
        std::process::exit(128 + signal)
    };
    let controller = signal::Controller::default();
    let cancelled = controller.signal();
    let mut interrupt = signal(SignalKind::interrupt()).map_err(|_| Fail::Unknown)?;
    let mut terminate = match terminal {
        Some(_) => Some(signal(SignalKind::terminate()).map_err(|_| Fail::Unknown)?),
        None => None,
    };
    let terminated = async {
        match terminate.as_mut() {
            Some(terminate) => terminate.recv().await,
            None => std::future::pending().await,
        }
    };
    let work = sign_in_steps(client, allow_account_change, cancelled.clone());
    tokio::pin!(work, terminated);
    let mut interrupted = false;

    let outcome = loop {
        tokio::select! {
            outcome = &mut work => break outcome,
            _ = interrupt.recv() => match interrupted {
                true => exit(SIGINT),
                false => {
                    interrupted = true;
                    controller.abort();
                }
            },
            _ = &mut terminated => exit(SIGTERM),
        }
    };

    match outcome {
        Err(_) if cancelled.aborted() => Err(LOGIN_CANCELLED),
        outcome => outcome,
    }
}

/// `signInWithGoogle`: the browser is closed and its profile removed before the session is
/// verified and saved. SIGINT and SIGTERM cancel from before the browser starts until the save
/// ends, as often as they arrive (`process.on`); the save polls for them.
async fn sign_in_with_google(
    client: Arc<client::Client>,
    allow_account_change: bool,
    timeout: Option<String>,
    browser: Option<String>,
) -> Result<()> {
    use browser_login::{Cancellation, Signals};

    let timeout = google::parse_timeout(timeout.as_deref())?;
    google::require_display()?;
    let signals =
        Arc::new(Signals::install(Cancellation::InterruptOrTerminate).map_err(|_| Fail::Unknown)?);
    // An option that is given, even empty, replaces INNA_BROWSER.
    let browser = browser.or_else(|| {
        std::env::var_os("INNA_BROWSER").map(|path| path.to_string_lossy().into_owned())
    });
    let watching = signals.clone();
    let login = tokio::task::spawn_blocking(move || {
        google::login_in_browser(&watching, browser.as_deref(), timeout)
    })
    .await
    .unwrap_or(Err(Fail::Unknown));

    let saved = match login {
        Ok(jar) => {
            let controller = signal::Controller::default();
            let cancelled = controller.signal();
            let save = client.run(controller.signal(), move |client, signal, cancel| {
                client.save_verified_session(jar, allow_account_change, signal, cancel)
            });
            tokio::pin!(save);

            let saved = loop {
                tokio::select! {
                    saved = &mut save => break saved,
                    () = tokio::time::sleep(std::time::Duration::from_millis(50)) => {
                        if signals.cancelled() {
                            controller.abort();
                        }
                    }
                }
            };

            match saved {
                Err(_) if cancelled.aborted() => Err(google::CANCELLED),
                saved => saved,
            }
        }
        Err(fail) => Err(fail),
    };
    signals.stop();
    report_saved(&saved?);
    Ok(())
}

/// `auth login`: the store is checked before the owner is asked for anything.
async fn login(
    google: bool,
    allow_account_change: bool,
    timeout: Option<String>,
    browser: Option<String>,
) -> Result<()> {
    let client = Arc::new(client::Client::from_environment(false)?);
    client
        .run(signal::Signal::default(), |client, _, cancel| {
            client.check_store(cancel)
        })
        .await?;

    match google {
        true => sign_in_with_google(client, allow_account_change, timeout, browser).await,
        false => sign_in(client, allow_account_change).await,
    }
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

    // The store is checked before anything serves or touches it; help and version never do. An
    // invalid command is refused after the check, as before `auth renew` existed.
    let command = route(args);
    let quiet = command == Ok(Command::Renew);
    if !tokio::task::spawn_blocking(move || store::check_store_at_startup(quiet))
        .await
        .unwrap_or(Err(Fail::Unknown))?
    {
        return Ok(ExitCode::FAILURE);
    }

    match command? {
        Command::Serve {
            allow_absence_writes,
            keep_alive,
        } => serve(allow_absence_writes, keep_alive).await?,
        Command::Login {
            google,
            allow_account_change,
            timeout,
            browser,
        } => login(google, allow_account_change, timeout, browser).await?,
        Command::Renew => return renew().await,
        command => session_command(command).await?,
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
            (&["auth", "renew"], Command::Renew),
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
            &["auth", "renew", "x"],
            &["auth", "renew", "--google"],
            &["auth", "renew", "--allow-account-change"],
            &["auth", "renew", "--no-keep-alive"],
            &["auth", "renew", "--allow-absence-writes"],
            &["renew"],
        ] {
            assert_eq!(routed(line).unwrap_err(), INVALID_COMMAND, "{line:?}");
        }
    }

    #[test]
    fn each_renewal_outcome_has_its_own_exit_code_and_a_fixed_message() {
        use client::Renewal;

        assert_eq!(renewal_outcome(Renewal::Kept), None);
        let outcomes = [
            Renewal::NoSession,
            Renewal::SignInRequired(Some("credentials".to_owned())),
            Renewal::Refused,
            Renewal::Failed(Fail::Unknown),
            Renewal::Failed(Fail::Invalid),
            Renewal::Failed(Fail::Safe(
                "Inna returned an unavailable or unexpected response.",
            )),
            Renewal::Failed(client::RATE_LIMITED),
            Renewal::Failed(session::UNCERTAIN),
            Renewal::Paused { overdue: true },
            Renewal::Paused { overdue: false },
        ]
        .map(|renewal| renewal_outcome(renewal).unwrap());
        assert_eq!(
            outcomes.map(|(code, _)| code),
            [3, 4, 4, 5, 5, 5, 5, 5, 6, 6],
            "codes"
        );
        assert_eq!(
            outcomes.map(|(_, message)| message),
            [
                "No Inna session. Run inna-mcp auth login or auth import with a private cookie export.",
                "Inna sign-in is required. Run auth login or import a fresh private cookie export.",
                "Inna sign-in is required. Run auth login or import a fresh private cookie export.",
                RENEWAL_FAILED,
                RENEWAL_FAILED,
                RENEWAL_FAILED,
                "Inna rate limited this session. Wait before trying again.",
                SESSION_UNUSABLE,
                "Inna requested a pause. Wait before making another request.",
                "Inna requested a pause. Wait before making another request.",
            ]
        );
    }

    /// Store messages may name paths (the write-uncertain and retired-store ones do); none reaches
    /// a renewal's output.
    #[test]
    fn no_renewal_failure_prints_a_path() {
        use family_store::{Code, Error};

        let mut failures = vec![session::UNCERTAIN, client::RATE_LIMITED, Fail::Unknown];
        for code in [
            Code::StoreBackendRetired,
            Code::StoreWriteUncertain,
            Code::UnsafeFile,
            Code::StoreUnavailable,
            Code::StoreError,
            Code::Busy,
            Code::Io,
        ] {
            failures.push(session::store_error(&Error::new(code, "Synthetic.")));
        }
        assert!(failures.iter().any(|fail| match fail {
            Fail::Safe(message) => message.contains('/'),
            _ => false,
        }));

        for fail in failures {
            let (code, message) = renewal_outcome(client::Renewal::Failed(fail)).unwrap();
            assert_eq!(code, NOT_RENEWED);
            assert!(
                !message.contains('/') && !message.contains('~'),
                "{message}"
            );
        }
    }

    #[test]
    fn help_is_cli_ts_text() {
        assert!(HELP.ends_with("unless --allow-account-change is given.\n"));
        assert!(!HELP.ends_with("\n\n"));
    }
}
