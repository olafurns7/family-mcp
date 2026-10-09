//! `auth login`: the shared browser login (rust/browser-login) on Abler's sign-in page, with
//! packages/abler-mcp/src/browser-login.ts's tab, cookies and messages. Blocks; the CLI calls it
//! from `spawn_blocking`.

use std::io::Write;
use std::time::Duration;

use browser_login::{Cancellation, Error, Signals, Site};
use serde_json::{Value, json};

use crate::api::ORIGIN;
use crate::error::{Fail, Result};
use crate::jar::Jar;

struct Abler;

impl Site for Abler {
    type Session = Jar;
    const PROFILE_PREFIX: &'static str = "abler-login-";
    const START_URL: &'static str = "https://www.abler.io/sign-on/login";
    const FOLLOW_TAB: bool = false;

    fn is_tab(&self, url: &str) -> bool {
        url.starts_with(&format!("{ORIGIN}/"))
    }

    fn cookie_urls(&self) -> Value {
        json!([format!("{ORIGIN}/oauth/token"), format!("{ORIGIN}/graphql")])
    }

    /// The authentication cookies, once both the refresh and the access token are present.
    fn session(&self, result: &Value) -> Option<Jar> {
        let mut jar =
            Jar::import(&Value::Array(result.get("cookies")?.as_array()?.clone())).ok()?;

        (jar.has("/oauth/token", "refreshToken") && jar.has("/graphql", "id_token")).then_some(jar)
    }

    fn debugging(&self) {
        let _ = writeln!(
            std::io::stdout(),
            "Sign in to Abler in the browser window that opened."
        );
    }

    fn kept(&self) {
        let _ = writeln!(
            std::io::stderr(),
            "Keeping the browser open; its temporary profile contains live Abler credentials and no debugging endpoint is left open."
        );
    }
}

fn message(error: Error) -> Fail {
    Fail::Safe(match error {
        Error::Cancelled => "Abler login cancelled.",
        Error::NoBrowser => {
            "No Chromium-family browser found. Install Chrome, Chromium, Brave, or Edge, or set ABLER_BROWSER/--browser to its executable. Use 'abler-mcp auth capture <URL>' or 'abler-mcp auth import <file>'."
        }
        Error::NoPipe => {
            "Could not establish a private Chrome debugging pipe. Use `abler-mcp auth capture` or `abler-mcp auth import`, or select a Chromium browser with `--browser`."
        }
        Error::Closed => "The browser closed before Abler sign-in completed.",
        Error::TimedOut => "Abler login timed out. Try again or increase --timeout.",
        Error::StillRunning => {
            "A browser process may still be running; its temporary profile was removed."
        }
        Error::ProfileNotRemoved => "Could not remove the temporary browser profile.",
        Error::Unknown => return Fail::Unknown,
    })
}

/// Open a temporary browser, wait for the user to sign in to Abler, and return its session
/// cookies. The browser is closed and its profile removed before this returns, unless
/// `keep_browser` leaves both to the user.
pub fn login_in_browser(
    browser: Option<&str>,
    timeout_seconds: f64,
    keep_browser: bool,
) -> Result<Jar> {
    let timeout = Duration::try_from_secs_f64(timeout_seconds).unwrap_or(Duration::MAX);
    let signals = Signals::install(Cancellation::InterruptOrTerminate).map_err(message)?;
    let outcome = browser_login::login_in_browser(&Abler, &signals, browser, timeout, keep_browser);
    signals.stop();
    outcome.map_err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_failure_has_the_typescript_message() {
        let missing = message(Error::NoBrowser).safe().unwrap();
        assert!(missing.contains("ABLER_BROWSER/--browser"));
        assert!(missing.contains("auth capture <URL>' or 'abler-mcp auth import <file>"));
        assert_eq!(message(Error::Unknown), Fail::Unknown);
        assert!(Abler.is_tab("https://www.abler.io/coach"));
        assert!(!Abler.is_tab("https://www.abler.io.evil/"));
    }
}
