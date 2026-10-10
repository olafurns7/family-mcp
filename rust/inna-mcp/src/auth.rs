//! The sign-in and session changes of packages/inna-mcp/src/client.ts: a private cookie export
//! (`cookieExportSchema`, `sessionJar`, `importSession`), a verified save (`saveVerifiedSession`),
//! and `checkStore`, `defaultUserId`, `migrate` and `logout`. Everything here blocks.

use std::path::Path;

use family_store::{Cancel, read_private_bytes};
use serde_json::Value;
use url::Url;

use crate::client::{Client, Connection, ORIGIN, matches_entry, student_entries};
use crate::error::{Fail, Result};
use crate::jar::{Cookie, Jar};
use crate::js;
use crate::session::{
    COOKIE_NAMES, Held, STORAGE, Saved, encode, key_lost, locked, read_saved, remove_legacy,
    store_error,
};
use crate::signal::Signal;
use crate::store::MAX_SESSION_BYTES;

const NO_SESSION: Fail = Fail::Safe(
    "No Inna session. Run inna-mcp auth login or auth import with a private cookie export.",
);

/// What a verified save reports: where the session is, and whether a store whose key was lost
/// was replaced.
#[derive(Debug, PartialEq)]
pub struct SavedSession {
    pub storage: &'static str,
    pub replaced: bool,
}

/// `MigrateResult`.
#[derive(Debug, PartialEq)]
pub enum Migrated {
    Moved,
    Already,
    AlreadyRemovedLegacy,
}

/// One `exportedCookieSchema` entry, as `sessionJar` reads it.
pub struct Exported {
    name: String,
    value: String,
    domain: String,
    path: String,
    http_only: bool,
    expiry: Option<f64>,
    same_site: Option<String>,
}

impl Exported {
    /// `exportedCookieSchema.parse`: unknown keys are ignored; an optional key may be absent but
    /// not null.
    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let text = |key: &str| object.get(key)?.as_str().map(str::to_owned);
        let optional = |key: &str, check: fn(&Value) -> bool| match object.get(key) {
            None => Some(None),
            Some(value) => check(value).then_some(Some(value)),
        };
        let value_text = text("value")?;
        (1..=65_536)
            .contains(&js::length(&value_text))
            .then_some(())?;
        let path =
            optional("path", Value::is_string)?.map_or("/", |path| path.as_str().unwrap_or("/"));
        optional("secure", Value::is_boolean)?;
        let http_only =
            optional("httpOnly", Value::is_boolean)?.and_then(Value::as_bool) == Some(true);
        let expires = optional("expires", Value::is_number)?.and_then(Value::as_f64);
        let expiration = optional("expirationDate", Value::is_number)?.and_then(Value::as_f64);
        let same_site = optional("sameSite", Value::is_string)?.and_then(Value::as_str);
        Some(Self {
            name: text("name")?,
            value: value_text,
            domain: text("domain")?,
            path: path.to_owned(),
            http_only,
            expiry: expires.or(expiration),
            same_site: same_site.map(str::to_owned),
        })
    }
}

/// `cookieExportSchema.parse`: an array of cookies, or an object holding one as `cookies`.
pub fn exported_cookies(value: &Value) -> Option<Vec<Exported>> {
    let list = match value {
        Value::Array(list) => list,
        Value::Object(object) => object.get("cookies")?.as_array()?,
        _ => return None,
    };
    list.iter().map(Exported::parse).collect()
}

/// `sessionJar`: the only cookies a saved session holds, the three nam.inna.is session cookies at
/// path `/`.
pub fn session_jar(cookies: Vec<Exported>) -> Result<Jar> {
    let origin = Url::parse(ORIGIN).map_err(|_| Fail::Unknown)?;
    let mut jar = Jar::default();

    for entry in cookies {
        if !COOKIE_NAMES.contains(&entry.name.as_str()) {
            continue;
        }
        let domain = entry.domain.strip_prefix('.').unwrap_or(&entry.domain);

        if domain != "nam.inna.is" || entry.path != "/" {
            return Err(Fail::Safe(
                "Import only the verified nam.inna.is session cookies.",
            ));
        }
        let same_site = entry
            .same_site
            .map(|same_site| same_site.to_lowercase())
            .filter(|same_site| ["strict", "lax", "none"].contains(&same_site.as_str()));
        let cookie = Cookie::exported(
            &entry.name,
            &entry.value,
            entry.http_only,
            entry.expiry.filter(|expiry| *expiry > 0.0),
            same_site.as_deref(),
        );
        jar.set(cookie, &origin).map_err(|()| Fail::Unknown)?;
    }
    Ok(jar)
}

impl Client {
    /// `importSession`: a private cookie export, verified and saved. Only the path's own
    /// refusal is a reviewed message; a file that cannot be read or parsed fails generically.
    pub fn import_session(
        &self,
        source: &str,
        allow_account_change: bool,
        signal: &Signal,
        cancel: &Cancel,
    ) -> Result<SavedSession> {
        if !Path::new(source).is_absolute() {
            return Err(Fail::Safe("The cookie export path must be absolute."));
        }
        let bytes =
            read_private_bytes(Path::new(source), MAX_SESSION_BYTES).map_err(|_| Fail::Unknown)?;
        let cookies = js::parse(&bytes)
            .as_ref()
            .and_then(exported_cookies)
            .ok_or(Fail::Unknown)?;
        self.save_verified_session(session_jar(cookies)?, allow_account_change, signal, cancel)
    }

    /// `saveVerifiedSession`: the jar is saved only once Inna accepts it for one selected
    /// student that matches it, and only onto the same account unless `allow_account_change`.
    pub fn save_verified_session(
        &self,
        jar: Jar,
        allow_account_change: bool,
        signal: &Signal,
        cancel: &Cancel,
    ) -> Result<SavedSession> {
        locked(self.path(), cancel, |held| {
            // Only this explicit sign-in or import may replace a store whose key is lost.
            let lost = key_lost(held.store)?;
            let mut prior = match lost && held.decides {
                true => None,
                false => held.read()?,
            };
            let pause_until = prior.as_ref().map_or(0.0, |prior| prior.pause_until);
            let mut connection = Connection::new(jar, pause_until, self.net(), signal);

            let user = match connection.user() {
                Ok(user) => user,
                Err(fail) => {
                    if let Some(prior) = prior.as_mut()
                        && connection.pause_until > prior.pause_until
                    {
                        prior.pause_until = connection.pause_until;
                        held.write(prior)?;
                    }
                    return Err(fail);
                }
            };
            let binding = user.binding();
            let kept = match &prior {
                Some(prior) if prior.account == binding => prior.students.clone(),
                _ => Vec::new(),
            };

            if let Some(prior) = &prior
                && prior.account != binding
                && !allow_account_change
            {
                if prior
                    .students
                    .iter()
                    .any(|(_, student)| student.binding == binding)
                {
                    return Err(Fail::Safe(
                        "This session has another saved student selected. Select the default student in the Inna browser session first, or use --allow-account-change deliberately.",
                    ));
                }
                return Err(Fail::Safe(
                    "This export changes the account, student, or school. Use --allow-account-change deliberately.",
                ));
            }
            let mut candidate = Saved {
                jar: connection.jar.serialize().ok_or(Fail::Unknown)?,
                account: binding,
                students: kept,
                pause_until: connection.pause_until,
            };

            if student_entries(&user).is_some_and(|entries| !entries.is_empty()) {
                let key = user.binding().user_id.to_string();

                if !matches_entry(&user, &key) {
                    return Err(Fail::Safe(
                        "Inna did not report one selected student matching this session. Select the intended student in Inna and sign in again.",
                    ));
                }
                let learned = user.learned();

                match candidate
                    .students
                    .iter_mut()
                    .find(|(known, _)| *known == key)
                {
                    Some((_, student)) => *student = learned,
                    None => candidate.students.push((key, learned)),
                }
            }
            commit(held, &candidate, lost, signal)
        })
    }

    /// `checkStore`: refuses an unusable session store before the owner signs in, instead of
    /// after. A lost key is not a refusal: the sign-in replaces that store.
    pub fn check_store(&self, cancel: &Cancel) -> Result<()> {
        locked(self.path(), cancel, |held| {
            if held.decides && !key_lost(held.store)? {
                held.stored()?;
            }
            Ok(())
        })
    }

    /// `defaultUserId`: the saved default student's user id, read locally; a fresh sign-in
    /// prefers it.
    pub fn default_user_id(&self, cancel: &Cancel) -> Result<Option<i64>> {
        locked(self.path(), cancel, |held| {
            if held.decides && key_lost(held.store)? {
                return Ok(None);
            }
            Ok(held.read()?.map(|saved| saved.account.user_id))
        })
    }

    /// `migrate`: move the legacy session into the store, which reads it back before it
    /// commits; only then does the plaintext file go. Never resets a store, never touches the
    /// absence record.
    pub fn migrate(&self, cancel: &Cancel) -> Result<Migrated> {
        locked(self.path(), cancel, |held| {
            if held.decides && held.stored()?.is_some() {
                return Ok(match remove_legacy(self.path())? {
                    true => Migrated::AlreadyRemovedLegacy,
                    false => Migrated::Already,
                });
            }
            let legacy = read_saved(self.path())?.ok_or(NO_SESSION)?;
            let text = encode(Some(&legacy))?;

            // A store that decides was just read, so a missing key here belongs to a store never
            // used.
            if key_lost(held.store)? {
                held.store
                    .create_key()
                    .map_err(|error| store_error(&error))?;
            }
            held.store
                .write(&text)
                .map_err(|error| store_error(&error))?;
            remove_legacy(self.path())?;
            Ok(Migrated::Moved)
        })
    }

    /// `logout`: a logged-out record keeps the store deciding, so a planted legacy file is never
    /// read. A logout cannot discard evidence of a possibly submitted absence.
    pub fn logout(&self, cancel: &Cancel) -> Result<()> {
        locked(self.path(), cancel, |held| {
            if held.decides {
                held.store
                    .write(&encode(None)?)
                    .map_err(|error| store_error(&error))?;
            }
            remove_legacy(self.path())?;
            Ok(())
        })
    }
}

/// The end of `saveVerifiedSession`: nothing is written, and no lost key replaced, once `signal`
/// has aborted.
fn commit(held: &mut Held, candidate: &Saved, lost: bool, signal: &Signal) -> Result<SavedSession> {
    let text = encode(Some(candidate))?;

    if signal.aborted() {
        return Err(Fail::Unknown);
    }

    if lost {
        if held.decides {
            held.store.reset().map_err(|error| store_error(&error))?;
        }
        held.store
            .create_key()
            .map_err(|error| store_error(&error))?;
    }
    held.store
        .write(&text)
        .map_err(|error| store_error(&error))?;
    // The store decides from here on, so a plaintext file would never be read again.
    remove_legacy(held.legacy)?;
    Ok(SavedSession {
        storage: STORAGE,
        replaced: lost && held.decides,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    use crate::session::Binding;
    use crate::signal::Controller;
    use crate::store::tests::scratch;

    /// A client on a scratch store, with the Tokio runtime its HTTP client needs.
    fn scratch_client(name: &str) -> (tokio::runtime::Runtime, Client, std::path::PathBuf) {
        let root = scratch(name);
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let client = {
            let _entered = runtime.enter();
            Client::new(root.join("legacy").join("session.json"), false).unwrap()
        };
        (runtime, client, root)
    }

    fn saved(user_id: i64) -> Saved {
        Saved {
            jar: Jar::default().serialize().unwrap(),
            account: Binding {
                user_id,
                student_id: "2".to_owned(),
                school_id: "3".to_owned(),
            },
            students: Vec::new(),
            pause_until: 0.0,
        }
    }

    /// `commit` as the sign-in calls it: `lost` when the key is missing, as on a fresh store,
    /// unless `lost` says otherwise.
    fn save(
        client: &Client,
        session: &Saved,
        lost: Option<bool>,
        signal: &Signal,
    ) -> Result<SavedSession> {
        locked(client.path(), &Cancel::default(), |held| {
            let lost = match lost {
                Some(lost) => lost,
                None => key_lost(held.store)?,
            };
            commit(held, session, lost, signal)
        })
    }

    #[test]
    fn a_save_after_the_sign_in_was_cancelled_leaves_the_store_unchanged() {
        let (_runtime, client, root) = scratch_client("aborted-save");
        let cancel = Cancel::default();
        save(&client, &saved(7), None, &Signal::default()).unwrap();
        let controller = Controller::default();
        controller.abort();

        for lost in [false, true] {
            assert!(matches!(
                save(&client, &saved(8), Some(lost), &controller.signal()),
                Err(Fail::Unknown)
            ));
            assert_eq!(client.default_user_id(&cancel).unwrap(), Some(7));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn no_student_is_preferred_once_the_key_is_lost_or_after_logout() {
        let (_runtime, client, root) = scratch_client("default-user");
        let cancel = Cancel::default();
        assert_eq!(client.default_user_id(&cancel).unwrap(), None);
        save(&client, &saved(7), None, &Signal::default()).unwrap();
        assert_eq!(client.default_user_id(&cancel).unwrap(), Some(7));
        client.logout(&cancel).unwrap();
        assert_eq!(client.default_user_id(&cancel).unwrap(), None);

        save(&client, &saved(9), None, &Signal::default()).unwrap();
        assert_eq!(client.default_user_id(&cancel).unwrap(), Some(9));
        std::fs::remove_file(root.join("data/family-mcp/keys/inna-mcp.default.key")).unwrap();
        assert_eq!(client.default_user_id(&cancel).unwrap(), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn cookies(value: Value) -> Option<Vec<Exported>> {
        exported_cookies(&value)
    }

    #[test]
    fn cookie_exports_parse_as_the_typescript_schema() {
        let entry = json!({"name": "SESSION", "value": "v", "domain": ".nam.inna.is"});
        let parsed = cookies(json!([entry.clone()])).unwrap();
        assert_eq!(parsed[0].path, "/");
        assert!(!parsed[0].http_only);
        assert!(cookies(json!({"cookies": [entry.clone()], "other": 1})).is_some());
        assert!(cookies(json!([])).unwrap().is_empty());

        for invalid in [
            json!({"name": "SESSION", "value": "", "domain": "nam.inna.is"}),
            json!({"name": "SESSION", "value": "v".repeat(65_537), "domain": "nam.inna.is"}),
            json!({"name": "SESSION", "value": "v", "domain": "nam.inna.is", "path": null}),
            json!({"name": "SESSION", "value": "v", "domain": "nam.inna.is", "secure": 1}),
            json!({"name": "SESSION", "value": "v", "domain": "nam.inna.is", "expires": "1"}),
            json!({"name": 1, "value": "v", "domain": "nam.inna.is"}),
            json!({"value": "v", "domain": "nam.inna.is"}),
        ] {
            assert!(cookies(json!([invalid])).is_none(), "{invalid}");
        }
        assert!(cookies(json!({"cookies": {}})).is_none());
        assert!(cookies(json!("x")).is_none());
    }

    #[test]
    fn only_the_three_session_cookies_at_the_root_of_nam_inna_is_are_kept() {
        let jar = session_jar(
            cookies(json!([
                {"name": "SESSION", "value": "s", "domain": "nam.inna.is", "httpOnly": true,
                 "expirationDate": 2_208_988_800.5, "sameSite": "Lax"},
                {"name": "XSRF-TOKEN", "value": "x", "domain": ".nam.inna.is", "sameSite": "other"},
                {"name": "other", "value": "o", "domain": "example.invalid", "path": "/x"},
            ]))
            .unwrap(),
        )
        .unwrap();
        let text = jar.serialize().unwrap();
        assert!(text.contains(r#""key":"SESSION","value":"s","expires":"2040-01-01T00:00:00.500Z","domain":"nam.inna.is","path":"/","secure":true,"httpOnly":true,"hostOnly":true"#), "{text}");
        assert!(text.contains(r#""sameSite":"lax""#), "{text}");
        assert!(!text.contains("other"), "{text}");

        for refused in [
            json!([{"name": "SESSION", "value": "s", "domain": "inna.is"}]),
            json!([{"name": "JSESSIONID", "value": "s", "domain": "nam.inna.is", "path": "/x"}]),
        ] {
            assert_eq!(
                session_jar(cookies(refused).unwrap()).err(),
                Some(Fail::Safe(
                    "Import only the verified nam.inna.is session cookies."
                ))
            );
        }
    }
}
