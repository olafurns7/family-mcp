mod alerts;
mod forecast;
mod http;
mod input;
mod observations;
mod output;
mod server;
mod stations;
mod text;
mod watch;

use std::process::ExitCode;

const HELP: &str = "vedur-mcp — Icelandic weather from Veðurstofa Íslands (IMO), read only\n\n  vedur-mcp [serve]     Start the stdio MCP server\n  vedur-mcp --version   Print the installed version\n  vedur-mcp --help      Show this help\n\nNo account, key or saved session is needed. Data: Veðurstofa Íslands, CC BY 4.0 where declared.\n";

const FAILED: &str = "vedur-mcp failed. Check the MCP host configuration.";

#[derive(Debug, Default, PartialEq)]
struct Args {
    help: bool,
    version: bool,
    positionals: Vec<String>,
}

/// The other servers' strict `parseArgs`: `--help`/`-h` and `--version`/`-v` only, `--` ends the
/// options, anything else is an error.
fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Args, ()> {
    let mut parsed = Args::default();
    let mut args = args.into_iter();

    while let Some(arg) = args.next() {
        if arg == "--" {
            parsed.positionals.extend(args.by_ref());
        } else if let Some(long) = arg.strip_prefix("--") {
            match long {
                "help" => parsed.help = true,
                "version" => parsed.version = true,
                _ => return Err(()),
            }
        } else if let Some(shorts) = arg.strip_prefix('-').filter(|shorts| !shorts.is_empty()) {
            for short in shorts.chars() {
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

fn main() -> ExitCode {
    let Ok(args) = parse_args(
        std::env::args_os()
            .skip(1)
            .map(|arg| arg.to_string_lossy().into_owned()),
    ) else {
        eprintln!("{FAILED}");
        return ExitCode::FAILURE;
    };

    if args.help {
        print!("{HELP}");
        return ExitCode::SUCCESS;
    }

    if args.version {
        println!("{}", env!("CARGO_PKG_VERSION"));
        return ExitCode::SUCCESS;
    }

    if !(args.positionals.is_empty() || args.positionals == ["serve"]) {
        eprint!("{HELP}");
        return ExitCode::FAILURE;
    }

    let outcome = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .and_then(|runtime| {
            let outcome = server::Vedur::new()
                .map_err(|_| std::io::Error::other("client"))
                .map(|server| runtime.block_on(mcp_runtime::serve_stdio(server)));
            // close has finished; only the stdin reader may still block, so do not wait for it.
            runtime.shutdown_background();
            outcome.and_then(|served| served)
        });

    match outcome {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("{FAILED}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Args, ()> {
        parse_args(args.iter().map(|arg| (*arg).to_owned()))
    }

    #[test]
    fn only_help_version_and_serve_are_accepted() {
        assert_eq!(parse(&[]), Ok(Args::default()));
        assert!(parse(&["--version"]).unwrap().version);
        assert!(parse(&["-hv"]).unwrap().help);
        assert_eq!(parse(&["serve"]).unwrap().positionals, ["serve"]);
        assert_eq!(parse(&["--", "-x"]).unwrap().positionals, ["-x"]);

        for bad in [&["--verbose"][..], &["-x"], &["--version=1"]] {
            assert_eq!(parse(bad), Err(()), "{bad:?}");
        }
    }

    #[test]
    fn the_help_names_the_stdio_server() {
        assert!(HELP.contains("stdio MCP server"));
    }
}
