//! packages/infomentor-mcp/src/session.ts: InfoMentor's URLs, the saved session format and the
//! plaintext session file older versions wrote.

use std::path::{Path, PathBuf};

use family_store::{Cancel, Code as StoreCode, read_private_file, write_private_file};
use serde_json::{Map, Value, json};
use url::Url;

use crate::error::{CANCELLED, Code, Fail, LOGIN_REQUIRED, Result};
use crate::jar::Jar;
use crate::js;
use crate::shapes::{self, S};
use crate::store::SESSION_MAX_BYTES;

pub const LOGIN_URL: &str = "https://im1.infomentor.is/production/mentor/";

pub const PARENT_URL: &str = "https://minn.infomentor.is/";

/// A persisted rate-limit pause is honoured for at most this long, whatever the file says.
pub const MAX_RATE_LIMIT_MS: f64 = 3_600_000.0;

fn is_infomentor_host(host: &str) -> bool {
    host == "infomentor.is" || host.ends_with(".infomentor.is")
}

/// `trustedUrl`: an HTTPS URL on an InfoMentor host, without a port or user info.
pub fn trusted_url(value: &str) -> Result<Url> {
    let url = Url::parse(value).map_err(|_| Fail::config("Invalid InfoMentor URL."))?;

    if url.scheme() != "https"
        || !url.host_str().is_some_and(is_infomentor_host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(Fail::config(
            "Only HTTPS hosts under infomentor.is are supported.",
        ));
    }
    Ok(url)
}

/// `URL.origin` of an HTTPS URL without a port.
pub fn origin(url: &Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or_default())
}

/// `sessionPath(path)`: the given path, else INFOMENTOR_SESSION_PATH, else the XDG location (an
/// existing legacy file keeps its path). It must be absolute.
pub fn session_path(path: Option<&Path>) -> Result<PathBuf> {
    let path = match (path, std::env::var_os("INFOMENTOR_SESSION_PATH")) {
        (Some(path), _) => path.to_owned(),
        (None, Some(variable)) => PathBuf::from(variable),
        (None, None) => {
            let legacy = family_store::StoreEnvironment::current()
                .home_directory()
                .map(|home| home.join(".infomentor-mcp").join("session.json"))
                .ok();
            family_store::default_session_path("infomentor-mcp", legacy.as_deref())
                .map_err(|_| Fail::Unknown)?
        }
    };

    if !path.is_absolute() {
        return Err(Fail::config("The session file path must be absolute."));
    }
    Ok(path)
}

const SAME_SITE: S = S::Enum(&["strict", "lax", "none"]);

/// `cookieSchema`: the parsed cookie in schema order, or `None`.
fn cookie(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let mut parsed = Map::new();
    let text = |name: &str| object.get(name).and_then(Value::as_str);
    let mut optional = |name: &str, shape: &S| -> Option<()> {
        if let Some(value) = object.get(name) {
            parsed.insert(name.to_owned(), shapes::parse(shape, value)?);
        }
        Some(())
    };
    let key = text("key").filter(|key| !key.is_empty())?;
    let value = text("value")?;
    let domain = text("domain")
        .filter(|domain| is_infomentor_host(domain.strip_prefix('.').unwrap_or(domain)))?;
    let path = text("path").filter(|path| path.starts_with('/'))?;
    optional("expires", &S::Str)?;

    match object.get("maxAge") {
        None | Some(Value::Number(_)) => {}
        Some(Value::String(text)) if text == "Infinity" || text == "-Infinity" => {}
        Some(_) => return None,
    }
    optional("secure", &S::Bool)?;
    optional("httpOnly", &S::Bool)?;
    optional("hostOnly", &S::Bool)?;
    optional("sameSite", &SAME_SITE)?;
    optional("creation", &S::Str)?;
    optional("lastAccessed", &S::Str)?;

    let mut ordered = Map::new();
    ordered.insert("key".to_owned(), json!(key));
    ordered.insert("value".to_owned(), json!(value));
    ordered.insert("domain".to_owned(), json!(domain));
    ordered.insert("path".to_owned(), json!(path));

    for name in [
        "expires",
        "maxAge",
        "secure",
        "httpOnly",
        "hostOnly",
        "sameSite",
        "creation",
        "lastAccessed",
    ] {
        let value = match name {
            "maxAge" => object.get(name).cloned(),
            _ => parsed.remove(name),
        };

        if let Some(value) = value {
            ordered.insert(name.to_owned(), value);
        }
    }
    Some(Value::Object(ordered))
}

/// `SavedSession`, as `savedSessionSchema` parses it.
#[derive(Debug, Clone, PartialEq)]
pub struct SavedSession {
    pub saved_at: String,
    pub cookies: Vec<Value>,
    pub account_id: Option<String>,
    pub selected_child_id: Option<String>,
    pub rate_limited_until: Option<String>,
}

impl SavedSession {
    /// `savedSessionSchema.safeParse(value)`.
    pub fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        (object.get("version")?.as_f64()? == 2.0).then_some(())?;
        let saved_at = object.get("savedAt")?.as_str()?;
        js::iso_datetime(saved_at)?;
        let cookies = object
            .get("cookies")?
            .as_array()?
            .iter()
            .map(cookie)
            .collect::<Option<Vec<_>>>()?;
        let filled = |name: &str| -> Option<Option<String>> {
            match object.get(name) {
                None => Some(None),
                Some(Value::String(text)) if !text.is_empty() => Some(Some(text.clone())),
                Some(_) => None,
            }
        };
        let rate_limited_until = match object.get("rateLimitedUntil") {
            None => None,
            Some(Value::String(text)) if js::iso_datetime(text).is_some() => Some(text.clone()),
            Some(_) => return None,
        };
        Some(Self {
            saved_at: saved_at.to_owned(),
            cookies,
            account_id: filled("accountId")?,
            selected_child_id: filled("selectedChildId")?,
            rate_limited_until,
        })
    }

    /// The session as JSON, in schema order.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("version".to_owned(), json!(2));
        object.insert("savedAt".to_owned(), json!(self.saved_at));
        object.insert("cookies".to_owned(), json!(self.cookies));

        for (name, value) in [
            ("accountId", &self.account_id),
            ("selectedChildId", &self.selected_child_id),
            ("rateLimitedUntil", &self.rate_limited_until),
        ] {
            if let Some(value) = value {
                object.insert(name.to_owned(), json!(value));
            }
        }
        Value::Object(object)
    }

    /// `comparableSession`: what a save would change, ignoring when cookies were last used.
    pub fn comparable(&self) -> String {
        let cookies: Vec<Value> = self
            .cookies
            .iter()
            .map(|cookie| {
                let mut cookie = cookie.clone();

                if let Some(object) = cookie.as_object_mut() {
                    object.shift_remove("lastAccessed");
                }
                cookie
            })
            .collect();
        let mut object = Map::new();

        for (name, value) in [
            ("accountId", &self.account_id),
            ("selectedChildId", &self.selected_child_id),
            ("rateLimitedUntil", &self.rate_limited_until),
        ] {
            if let Some(value) = value {
                object.insert(name.to_owned(), json!(value));
            }
        }
        object.insert("cookies".to_owned(), Value::Array(cookies));
        Value::Object(object).to_string()
    }

    /// `rateLimitCooldown`: epoch milliseconds until which every process sharing this session
    /// must pause; 0 when none.
    pub fn cooldown(&self) -> f64 {
        let Some(until) = self
            .rate_limited_until
            .as_deref()
            .and_then(js::iso_datetime)
        else {
            return 0.0;
        };
        let now = js::now_ms();

        if until <= now {
            return 0.0;
        }
        until.min(js::now_ms() + MAX_RATE_LIMIT_MS)
    }

    /// `restoreCookies`.
    pub fn jar(&self) -> Jar {
        Jar::import(&self.cookies)
    }
}

/// `captureSession`: the jar's cookies with a value, as the session schema keeps them.
pub fn capture(jar: &Jar) -> Result<SavedSession> {
    // tough-cookie throws on a date it cannot write; that is not an InfoMentorError.
    let cookies = jar.serialize().ok_or(Fail::Unknown)?;
    let cookies = cookies
        .iter()
        // tough-cookie omits value for empty cookies, including authentication deletion cookies.
        .filter(|cookie| {
            cookie
                .get("value")
                .and_then(Value::as_str)
                .is_some_and(|value| !value.is_empty())
        })
        .map(|value| cookie(value).ok_or(Fail::Invalid))
        .collect::<Result<Vec<_>>>()?;
    Ok(SavedSession {
        saved_at: js::iso_string(js::now_ms()),
        cookies,
        account_id: None,
        selected_child_id: None,
        rate_limited_until: None,
    })
}

/// `readSession`: only a regular, owner-only file owned by this user is accepted.
pub fn read_session(path: &Path) -> Result<SavedSession> {
    let text = read_private_file(path, SESSION_MAX_BYTES).map_err(|error| match error.code {
        StoreCode::NotFound => LOGIN_REQUIRED,
        StoreCode::UnsafeFile => Fail::new(
            Code::InvalidSession,
            "Cannot use the session file: it must be a regular file owned by you with owner-only permissions (chmod 600), not a symlink.",
        ),
        _ => Fail::new(
            Code::InvalidSession,
            "Cannot read the session file. Check its path and permissions.",
        ),
    })?;
    js::parse(&text)
        .as_ref()
        .and_then(SavedSession::parse)
        .ok_or(Fail::new(
            Code::InvalidSession,
            "Invalid or older browser session file. Run login again to create an HTTP session.",
        ))
}

/// `writeSession`: the atomic rename is the commit point.
pub fn write_session(session: &SavedSession, path: &Path, cancel: &Cancel) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(CANCELLED);
    }
    let text = session.to_json().to_string();

    write_private_file(path, text.as_bytes(), cancel).map_err(|_| match cancel.is_cancelled() {
        true => CANCELLED,
        false => {
            Fail::config("Cannot save the session file. Check the session directory permissions.")
        }
    })
}

#[cfg(test)]
mod tests {
    use mcp_runtime::Failure;

    use super::*;

    #[test]
    fn trusted_urls_are_https_infomentor_hosts_only() {
        assert_eq!(
            trusted_url("https://MINN.infomentor.is:443/a/../b?x#y")
                .unwrap()
                .as_str(),
            "https://minn.infomentor.is/b?x#y"
        );

        for refused in [
            "http://minn.infomentor.is/",
            "https://minn.infomentor.is:444/",
            "https://u@minn.infomentor.is/",
            "https://evilinfomentor.is/",
            "https://infomentor.is.evil/",
        ] {
            assert_eq!(
                trusted_url(refused).unwrap_err().safe(),
                Some("Only HTTPS hosts under infomentor.is are supported."),
                "{refused}"
            );
        }
        assert_eq!(
            trusted_url("not a url").unwrap_err().safe(),
            Some("Invalid InfoMentor URL.")
        );
    }

    #[test]
    fn saved_sessions_parse_and_write_in_schema_order() {
        let value = json!({
            "rateLimitedUntil": "2030-01-01T00:00:00.000Z",
            "cookies": [{
                "lastAccessed": "2026-01-01T00:00:00.000Z",
                "path": "/", "domain": ".infomentor.is", "value": "v", "key": "k",
                "maxAge": 5, "hostOnly": false, "pathIsDefault": true, "extensions": ["x"],
            }],
            "savedAt": "2026-01-01T00:00:00Z",
            "version": 2,
            "selectedChildId": "c",
            "extra": 1,
        });
        let session = SavedSession::parse(&value).unwrap();
        assert_eq!(
            session.to_json().to_string(),
            r#"{"version":2,"savedAt":"2026-01-01T00:00:00Z","cookies":[{"key":"k","value":"v","domain":".infomentor.is","path":"/","maxAge":5,"hostOnly":false,"lastAccessed":"2026-01-01T00:00:00.000Z"}],"selectedChildId":"c","rateLimitedUntil":"2030-01-01T00:00:00.000Z"}"#
        );
        assert_eq!(
            session.comparable(),
            r#"{"selectedChildId":"c","rateLimitedUntil":"2030-01-01T00:00:00.000Z","cookies":[{"key":"k","value":"v","domain":".infomentor.is","path":"/","maxAge":5,"hostOnly":false}]}"#
        );
        assert!(session.cooldown() <= js::now_ms() + MAX_RATE_LIMIT_MS);

        for (field, invalid) in [
            ("version", json!(1)),
            ("savedAt", json!("2026-01-01")),
            ("accountId", json!("")),
            ("rateLimitedUntil", json!(null)),
            (
                "cookies",
                json!([{"key": "k", "value": "v", "domain": "example.com", "path": "/"}]),
            ),
            (
                "cookies",
                json!([{"key": "", "value": "v", "domain": "infomentor.is", "path": "/"}]),
            ),
            (
                "cookies",
                json!([{"key": "k", "value": "v", "domain": "infomentor.is", "path": "x"}]),
            ),
            (
                "cookies",
                json!([{"key": "k", "value": "v", "domain": "infomentor.is", "path": "/", "maxAge": "1"}]),
            ),
            (
                "cookies",
                json!([{"key": "k", "value": "v", "domain": "infomentor.is", "path": "/", "sameSite": "Lax"}]),
            ),
        ] {
            let mut changed = value.clone();
            changed[field] = invalid;
            assert!(SavedSession::parse(&changed).is_none(), "{field}");
        }
    }
}
