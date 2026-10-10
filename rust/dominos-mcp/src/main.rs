mod catalog;
mod client;
mod error;
mod input;
mod js;
mod origin;
mod server;
mod shapes;
mod store;

use crate::error::{Fail, Result};
use std::process::ExitCode;

const HELP: &str = "dominos-mcp — unofficial Domino’s Iceland MCP\n\n  dominos-mcp [serve]       Start the stdio MCP server\n  dominos-mcp auth login    Sign in with a phone number and SMS code (hidden input)\n  dominos-mcp auth migrate  Move a session saved by an older version out of its plaintext file\n  dominos-mcp auth status   Show how the session is saved and verify it\n  dominos-mcp auth logout   Remove the local login\n  dominos-mcp --version     Print the installed version\n\nThe session is saved encrypted. DOMINOS_SESSION_FILE names an older version's plaintext\nsession file; quotes and checkouts stay beside it.\nPayments require an explicit pay_saved_card confirmation for the quoted amount.\n";
const FAILED: &str = "Domino’s MCP failed. Check the local configuration.";

#[derive(Debug, Default, PartialEq)]
struct Args {
    help: bool,
    version: bool,
    positionals: Vec<String>,
}

/// `parseArgs({ allowPositionals: true, options: { help: -h, version: -v } })` as Bun 1.4.2
/// runs it: strict, both options boolean, `--` ends the options. `Err` uses the generic CLI failure, as TS catches parseArgs.
fn parse_args(args: impl IntoIterator<Item = String>) -> std::result::Result<Args, ()> {
    let mut parsed = Args::default();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        // Lengths in UTF-16 units, as JavaScript counts them.
        let units = arg.encode_utf16().count();

        if arg == "--" {
            parsed.positionals.extend(args.by_ref());
        } else if let Some(long) = arg.strip_prefix("--") {
            // `--name=value` needs a name: the `=` must come after the third character.
            let (name, inline) = match long.split_once('=') {
                Some((name, _)) if !name.is_empty() => (name, true),
                _ => (long, false),
            };
            let flag = match name {
                "help" => &mut parsed.help,
                "version" => &mut parsed.version,
                _ => return Err(()),
            };

            if inline {
                return Err(());
            }
            *flag = true;
        } else if arg.starts_with('-') && units == 2 {
            match &arg[1..] {
                "h" => parsed.help = true,
                "v" => parsed.version = true,
                _ => return Err(()),
            }
        } else if arg.starts_with('-') && units > 2 {
            // A short option group names each unknown letter without its dash.
            for short in arg[1..].chars() {
                match short {
                    'h' => parsed.help = true,
                    'v' => parsed.version = true,
                    _ => return Err(()),
                }
            }
        } else {
            parsed.positionals.push(arg);
        }
    }
    Ok(parsed)
}

async fn main_async(args: Args) -> Result<ExitCode> {
    if args.help {
        print!("{HELP}");
        return Ok(ExitCode::SUCCESS);
    }
    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return Ok(ExitCode::SUCCESS);
    }
    if !tokio::task::spawn_blocking(store::check_store_at_startup)
        .await
        .map_err(|_| Fail::Unknown)??
    {
        return Ok(ExitCode::FAILURE);
    }
    let positionals: Vec<&str> = args.positionals.iter().map(String::as_str).collect();
    if positionals.is_empty() || positionals == ["serve"] {
        let server = server::Dominos::new()?;
        mcp_runtime::serve_stdio(server)
            .await
            .map_err(|_| Fail::Unknown)?;
    } else if positionals.len() == 2
        && positionals[0] == "auth"
        && ["login", "migrate", "logout", "status"].contains(&positionals[1])
    {
        return Err(Fail::Unknown);
    } else {
        eprint!("{HELP}");
        return Ok(ExitCode::FAILURE);
    }
    Ok(ExitCode::SUCCESS)
}

fn main() -> ExitCode {
    let args = match parse_args(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned()),
    ) {
        Ok(args) => args,
        // TS catches parseArgs errors as the generic CLI failure.
        Err(_) => {
            eprintln!("{FAILED}");
            return ExitCode::FAILURE;
        }
    };
    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|_| Fail::Unknown)
        .and_then(|runtime| {
            let outcome = runtime.block_on(main_async(args));
            runtime.shutdown_background();
            outcome
        });
    match outcome {
        Ok(code) => code,
        Err(fail) => {
            eprintln!("{}", mcp_runtime::cli_text(fail, FAILED));
            ExitCode::FAILURE
        }
    }
}
