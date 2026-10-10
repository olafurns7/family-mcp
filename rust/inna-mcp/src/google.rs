//! `auth login --google`: the shared browser login (rust/browser-login) on Inna's Google sign-in,
//! with packages/inna-mcp/src/browser-login.ts's tab, cookies and messages. Blocks; the CLI calls
//! it from `spawn_blocking`.

use std::io::Write;
use std::time::Duration;

use browser_login::{Error, Signals, Site};
use serde_json::{Value, json};
use url::Url;

use crate::auth::{exported_cookies, session_jar};
use crate::client::ORIGIN;
use crate::error::{Fail, Result};
use crate::jar::Jar;
use crate::js;
use crate::session::COOKIE_NAMES;

const STUDENTS_PATH: &str = "/Components/Students/Students.html";

struct Inna;

impl Site for Inna {
    type Session = Jar;
    const PROFILE_PREFIX: &'static str = "inna-login-";
    const START_URL: &'static str = "https://r.inna.is/auth/google";
    const FOLLOW_TAB: bool = true;

    /// `isStudentsPage`: cookies alone do not prove sign-in; the student application must show.
    fn is_tab(&self, url: &str) -> bool {
        Url::parse(url).is_ok_and(|url| {
            url.scheme() == "https"
                && url.host_str() == Some("nam.inna.is")
                && url.port().is_none()
                && url.path() == STUDENTS_PATH
        })
    }

    fn cookie_urls(&self) -> Value {
        json!([format!("{ORIGIN}/")])
    }

    /// The browser also holds r.inna.is and Google cookies; only the saved-session set leaves it,
    /// and only once it has both SESSION and XSRF-TOKEN.
    fn session(&self, result: &Value) -> Option<Jar> {
        let mut kept = Vec::new();

        for cookie in result.get("cookies")?.as_array()? {
            let text = |key: &str| cookie.get(key).and_then(Value::as_str);
            let (name, domain, path) = (text("name")?, text("domain")?, text("path")?);

            if COOKIE_NAMES.contains(&name)
                && domain.strip_prefix('.').unwrap_or(domain) == "nam.inna.is"
                && path == "/"
            {
                kept.push(cookie.clone());
            }
        }
        let mut jar = session_jar(exported_cookies(&Value::Array(kept))?).ok()?;
        let origin = Url::parse(&format!("{ORIGIN}/")).ok()?;
        let cookies = jar.get(&origin);
        let has = |key: &str| cookies.iter().any(|cookie| cookie.key() == key);
        (has("SESSION") && has("XSRF-TOKEN")).then_some(jar)
    }

    fn launching(&self) {
        let _ = writeln!(
            std::io::stderr(),
            "A browser window is opening. Sign in to Inna with your Google account there; this window closes by itself when you are done."
        );
    }
}

pub const CANCELLED: Fail = Fail::Safe("Inna login cancelled.");

fn message(error: Error) -> Fail {
    match error {
        Error::Cancelled => CANCELLED,
        Error::NoBrowser => Fail::Safe(
            "Google sign-in requires Google Chrome or Chromium, and none was found. Install one, or give its executable with --browser or INNA_BROWSER. Electronic ID (`inna-mcp auth login`) needs no browser.",
        ),
        Error::NoPipe => Fail::Safe(
            "Could not establish a private Chrome debugging pipe. Select Google Chrome or Chromium with `--browser`, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.",
        ),
        Error::Closed => {
            Fail::Safe("The browser was closed before Inna sign-in finished. Nothing was saved.")
        }
        Error::TimedOut => Fail::Safe(
            "Inna sign-in was not finished in time, and nothing was saved. Run the command again, or use electronic ID (`inna-mcp auth login`) or `inna-mcp auth import`.",
        ),
        Error::StillRunning => {
            Fail::Safe("A browser process may still be running; its temporary profile was removed.")
        }
        Error::ProfileNotRemoved => Fail::Safe("Could not remove the temporary browser profile."),
        Error::Unknown => Fail::Unknown,
    }
}

/// `parseTimeout`: whole seconds, 300 when not given.
pub fn parse_timeout(value: Option<&str>) -> Result<Duration> {
    let Some(value) = value else {
        return Ok(Duration::from_secs(300));
    };
    let seconds = js::number_of(value);

    if seconds.fract() != 0.0 || !(1.0..=9_007_199_254_740_991.0).contains(&seconds) {
        return Err(Fail::Safe("Provide a positive whole number for --timeout."));
    }
    Ok(Duration::from_secs(seconds as u64))
}

/// `requireDisplay`: on Linux, a browser window needs X11 or Wayland.
fn require_display_on(platform: &str, variable: &dyn Fn(&str) -> Option<String>) -> Result<()> {
    let set = |name: &str| variable(name).is_some_and(|value| !value.is_empty());

    match platform == "linux" && !set("DISPLAY") && !set("WAYLAND_DISPLAY") {
        true => Err(Fail::Safe(
            "Google sign-in opens a browser window and needs a desktop session, which this machine does not have. Electronic ID (`inna-mcp auth login`) works without one.",
        )),
        false => Ok(()),
    }
}

pub fn require_display() -> Result<()> {
    require_display_on(std::env::consts::OS, &|name| {
        std::env::var_os(name).map(|value| value.to_string_lossy().into_owned())
    })
}

/// `loginInBrowser`: open a temporary browser on Inna's Google sign-in, wait until the student
/// application shows with its session cookies, and return them. The browser is closed and its
/// profile removed before this returns. `signals` cancels the wait.
pub fn login_in_browser(
    signals: &Signals,
    browser: Option<&str>,
    timeout: Duration,
) -> Result<Jar> {
    browser_login::login_in_browser(&Inna, signals, browser, timeout, false).map_err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_student_application_proves_sign_in() {
        for (url, expected) in [
            (
                "https://nam.inna.is/Components/Students/Students.html",
                true,
            ),
            (
                "https://nam.inna.is:443/Components/Students/Students.html?x#y",
                true,
            ),
            (
                "https://nam.inna.is/Components/Students/Students.html/",
                false,
            ),
            (
                "http://nam.inna.is/Components/Students/Students.html",
                false,
            ),
            (
                "https://nam.inna.is:8443/Components/Students/Students.html",
                false,
            ),
            ("https://r.inna.is/Components/Students/Students.html", false),
            ("https://accounts.google.com/", false),
            ("not a url", false),
        ] {
            assert_eq!(Inna.is_tab(url), expected, "{url}");
        }
    }

    #[test]
    fn only_a_complete_school_session_is_taken() {
        let cookie = |name: &str, domain: &str, path: &str| json!({ "name": name, "value": "v", "domain": domain, "path": path, "httpOnly": true });
        let session = cookie("SESSION", ".nam.inna.is", "/");
        let xsrf = cookie("XSRF-TOKEN", "nam.inna.is", "/");
        let others = [
            cookie("SESSION", "r.inna.is", "/"),
            cookie("XSRF-TOKEN", "nam.inna.is", "/api"),
            cookie("SID", ".google.com", "/"),
        ];

        let mut all = vec![session.clone(), xsrf.clone()];
        all.extend(others.iter().cloned());
        let mut jar = Inna.session(&json!({ "cookies": all })).unwrap();
        let origin = Url::parse("https://nam.inna.is/").unwrap();
        let mut keys: Vec<String> = jar
            .get(&origin)
            .iter()
            .map(|c| c.key().to_owned())
            .collect();
        keys.sort();
        assert_eq!(keys, ["SESSION", "XSRF-TOKEN"]);
        assert_eq!(jar.serialize().unwrap().matches("\"key\"").count(), 2);

        for incomplete in [
            json!({ "cookies": [session] }),
            json!({ "cookies": [xsrf, others[0]] }),
            json!({ "cookies": [session, xsrf, { "name": "SESSION" }] }),
            json!({ "cookies": [session, { "name": "XSRF-TOKEN", "value": 1, "domain": "nam.inna.is", "path": "/" }] }),
            json!({}),
        ] {
            assert!(Inna.session(&incomplete).is_none(), "{incomplete}");
        }
    }

    #[test]
    fn timeouts_are_positive_whole_seconds() {
        assert_eq!(parse_timeout(None).unwrap(), Duration::from_secs(300));

        for (text, seconds) in [
            ("5", 5),
            (" 0x10 ", 16),
            ("1e3", 1000),
            ("5.0", 5),
            ("+7", 7),
        ] {
            assert_eq!(
                parse_timeout(Some(text)).unwrap(),
                Duration::from_secs(seconds),
                "{text}"
            );
        }

        for text in [
            "",
            "0",
            "-5",
            "1.5",
            "x",
            "Infinity",
            "9007199254740992",
            "0x",
            "0x+1",
            "-0x1",
        ] {
            assert!(parse_timeout(Some(text)).is_err(), "{text}");
        }
    }

    #[test]
    fn a_missing_display_on_linux_fails_first() {
        let variables = |set: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                set.iter()
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| (*value).to_owned())
            }
        };
        let missing = require_display_on("linux", &variables(&[])).unwrap_err();
        let Fail::Safe(text) = missing else { panic!() };
        assert!(text.contains("desktop session"));
        assert!(text.contains("`inna-mcp auth login`) works without one"));
        assert!(
            require_display_on(
                "linux",
                &variables(&[("DISPLAY", ""), ("WAYLAND_DISPLAY", "")])
            )
            .is_err()
        );
        assert!(require_display_on("linux", &variables(&[("DISPLAY", ":0")])).is_ok());
        assert!(
            require_display_on("linux", &variables(&[("WAYLAND_DISPLAY", "wayland-0")])).is_ok()
        );
        assert!(require_display_on("macos", &variables(&[])).is_ok());
    }

    #[test]
    fn browser_messages_name_the_browser_and_both_options() {
        let Fail::Safe(text) = message(Error::NoBrowser) else {
            panic!()
        };
        assert!(text.contains("requires Google Chrome or Chromium"));
        assert!(text.contains("--browser or INNA_BROWSER"));
        assert!(text.contains("`inna-mcp auth login`"));
    }
}
