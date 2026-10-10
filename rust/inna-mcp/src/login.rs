//! packages/inna-mcp/src/login.ts: a fresh electronic-ID sign-in through island.is, relayed to
//! Inna's student application. Only trusted hosts are contacted; the identity cookies, tickets and
//! the Inna access token stay in memory, and only the school's session cookies are returned.
//! Everything here blocks; requests wait on the runtime through `Net`.

use std::time::Duration;

use reqwest::header::{
    ACCEPT, AUTHORIZATION, CONTENT_TYPE, COOKIE, HeaderMap, HeaderName, HeaderValue, LOCATION,
    SET_COOKIE,
};
use serde_json::{Map, Value, json};
use url::Url;

use crate::client::header;
use crate::error::{Fail, Result};
use crate::html::post_logout_links;
use crate::jar::{self, Jar};
use crate::js;
use crate::signal::Signal;
use crate::upstream::Net;

const ISSUER: &str = "https://innskra.island.is";

const ISSUER_HOST: &str = "innskra.island.is";

const ALLOWED_HOSTS: [&str; 5] = [
    "r.inna.is",
    "heimdallur.inna.is",
    ISSUER_HOST,
    "inna.is",
    "nam.inna.is",
];

const SCHOOL_COOKIES: [&str; 3] = ["SESSION", "JSESSIONID", "XSRF-TOKEN"];

/// The whole sign-in's limit (`AbortSignal.timeout(180_000)`).
const TIMEOUT: Duration = Duration::from_secs(180);

/// Each request's own limit (`AbortSignal.timeout(30_000)`).
const REQUEST_DEADLINE: Duration = Duration::from_secs(30);

const MAX_BODY_BYTES: usize = 2 * 1024 * 1024;

const MAX_REDIRECTS: usize = 20;

const UNEXPECTED_DESTINATION: Fail =
    Fail::Safe("Inna login returned an unexpected destination. Sign in through the browser.");

const UNEXPECTED_RESPONSE: Fail = Fail::Safe("Inna login returned an unexpected response.");

/// Any failure without a reviewed message: login.ts's `catch` for an error not a `SafeError`.
const UNEXPECTED: Fail =
    Fail::Safe("Inna login returned an unexpected response. Complete sign-in in the browser.");

/// `trustedUrl(value, base)`: an HTTPS URL on one of the sign-in's hosts, without user info or
/// port; the school's own `http:` links are upgraded. A text that is no URL fails generically,
/// as `new URL` throws before any check.
fn trusted(value: &str, base: Option<&Url>) -> Result<Url> {
    let mut url = Url::options()
        .base_url(base)
        .parse(value)
        .map_err(|_| Fail::Unknown)?;

    if url.scheme() == "http" && url.host_str() == Some("nam.inna.is") {
        url.set_scheme("https").map_err(|()| Fail::Unknown)?;
    }
    let trusted = url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| ALLOWED_HOSTS.contains(&host))
        && url.username().is_empty()
        && url.password().is_none_or(str::is_empty)
        && url.port().is_none();

    match trusted {
        true => Ok(url),
        false => Err(UNEXPECTED_DESTINATION),
    }
}

/// `url.origin === 'https://<host>'` of a trusted URL, which is always HTTPS without a port.
fn on(url: &Url, host: &str) -> bool {
    url.host_str() == Some(host)
}

/// `z.number().int()`: zod 4 takes only safe integers.
fn int(value: Option<&Value>) -> Option<i64> {
    let number = value?.as_f64()?;
    (number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0).then_some(number as i64)
}

fn field<'v>(value: &'v Value, key: &str) -> Option<&'v Value> {
    value.as_object()?.get(key)
}

fn string_field(value: &Value, key: &str) -> Option<String> {
    field(value, key)?.as_str().map(str::to_owned)
}

fn bool_field(value: &Value, key: &str) -> Option<bool> {
    field(value, key)?.as_bool()
}

/// `{ identityProviderRestrictions: z.array(z.string()) }`.
fn context_shape(value: &Value) -> Option<()> {
    field(value, "identityProviderRestrictions")?
        .as_array()?
        .iter()
        .all(Value::is_string)
        .then_some(())
}

/// `{ displayCode: /^\d{4}$/, verificationProperties: z.string() }`.
fn bootstrap_shape(value: &Value) -> Option<(String, String)> {
    let code = string_field(value, "displayCode")
        .filter(|code| code.len() == 4 && code.bytes().all(|byte| byte.is_ascii_digit()))?;
    Some((code, string_field(value, "verificationProperties")?))
}

/// `{ isTwoFactorRequired, isNewLoginRestricted }`: whether either is set.
fn device_shape(value: &Value) -> Option<bool> {
    Some(bool_field(value, "isTwoFactorRequired")? | bool_field(value, "isNewLoginRestricted")?)
}

/// `{ confirmed: z.boolean() }`.
fn terms_shape(value: &Value) -> Option<bool> {
    bool_field(value, "confirmed")
}

/// `pollSchema`'s output: its fields in its order, other keys dropped. The sign-in sends it back
/// as the next poll's body.
fn poll_shape(value: &Value) -> Option<Map<String, Value>> {
    let object = value.as_object()?;
    let mut session = Map::new();

    for key in [
        "isSuccess",
        "retryWaitTime",
        "retries",
        "nexusUrl",
        "data",
        "timeoutErrorMessage",
        "isFirstPoll",
        "scriptId",
        "sessionId",
        "deviceLinkUrl",
    ] {
        let item = object.get(key)?;
        let valid = match key {
            "isSuccess" | "isFirstPoll" => item.is_boolean(),
            "retryWaitTime" => item
                .as_f64()
                .is_some_and(|wait| (0.0..=30_000.0).contains(&wait)),
            "retries" => item.is_number(),
            "data" | "timeoutErrorMessage" => item.is_string(),
            _ => item.is_string() || item.is_null(),
        };

        if !valid {
            return None;
        }
        session.insert(key.to_owned(), item.clone());
    }
    Some(session)
}

/// One `accessSchema` entry.
struct Access {
    system: i64,
    user_id: i64,
    status: i64,
    is_access: bool,
}

fn access_shape(value: &Value) -> Option<Vec<Access>> {
    value
        .as_array()?
        .iter()
        .map(|entry| {
            let object = entry.as_object()?;
            Some(Access {
                system: int(object.get("system"))?,
                user_id: int(object.get("user_id"))?,
                status: int(object.get("status"))?,
                is_access: object.get("is_access")?.as_bool()?,
            })
        })
        .collect()
}

/// The distinct matches of `/(["'])(eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\1/g`,
/// in order. No class byte is a dot or a quote, so each run is taken whole, as the regex's
/// backtracking would end the same way; a match resumes after its closing quote.
fn access_tokens(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let class = |byte: u8| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-';
    let run = |from: usize| {
        from + bytes[from..]
            .iter()
            .take_while(|&&byte| class(byte))
            .count()
    };
    let mut tokens: Vec<String> = Vec::new();
    let mut at = 0;

    while at < bytes.len() {
        let quote = bytes[at];

        if quote == b'"' || quote == b'\'' {
            let start = at + 1;
            let first = run(start);
            let second = (first < bytes.len() && bytes[first] == b'.').then(|| run(first + 1));
            let third = second
                .filter(|&second| second < bytes.len() && bytes[second] == b'.')
                .map(|second| run(second + 1));

            if let (Some(second), Some(third)) = (second, third)
                && bytes[start..].starts_with(b"eyJ")
                && first - start >= 15
                && second - first > 20
                && third - second > 20
                && bytes.get(third) == Some(&quote)
            {
                let token = &text[start..third];

                if !tokens.iter().any(|known| known == token) {
                    tokens.push(token.to_owned());
                }
                at = third + 1;
                continue;
            }
        }
        at += 1;
    }
    tokens
}

/// One response, its body read.
struct Reply {
    url: Url,
    status: u16,
    headers: HeaderMap,
    text: String,
}

impl Reply {
    fn ok(&self) -> bool {
        (200..=299).contains(&self.status)
    }
}

struct Login<'a> {
    net: &'a Net,
    /// The caller's signal with the sign-in's own limit.
    signal: &'a Signal,
    jar: Jar,
    phone: &'a str,
}

/// A header value as `Headers` accepts it; one it refuses fails generically.
fn value(text: &str) -> Result<HeaderValue> {
    HeaderValue::from_str(text).map_err(|_| Fail::Unknown)
}

impl Login<'_> {
    /// `request`: every cookie the jar holds for the URL, the bearer only to inna.is, the CSRF
    /// header to the issuer; each Set-Cookie kept, and an error status refused.
    fn request(
        &mut self,
        target: &str,
        body: Option<&Value>,
        bearer: Option<&str>,
    ) -> Result<Reply> {
        let url = trusted(target, None)?;
        let mut headers = HeaderMap::new();
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/json,text/html"),
        );
        headers.insert(COOKIE, value(&self.jar.header(&url))?);

        if let Some(bearer) = bearer {
            if !on(&url, "inna.is") {
                return Err(Fail::Safe(
                    "The Inna access token cannot be sent to another origin.",
                ));
            }
            headers.insert(AUTHORIZATION, value(&format!("Bearer {bearer}"))?);
        }

        if on(&url, ISSUER_HOST)
            && let Some(csrf) = self
                .jar
                .get(&url)
                .into_iter()
                .find(|cookie| cookie.key() == "CSRF-TOKEN-IDS")
        {
            let decoded = js::decode_uri_component(csrf.value()).ok_or(Fail::Unknown)?;
            headers.insert(
                HeaderName::from_static("x-csrf-token-ids"),
                value(&decoded)?,
            );
        }

        if body.is_some() {
            headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        }
        let deadline = self.signal.any(&Signal::timeout(REQUEST_DEADLINE));
        let response = self
            .net
            .send(&deadline, &url, headers, body.map(Value::to_string))
            .flatten()
            .ok_or(Fail::Unknown)?;

        for cookie in response.headers.get_all(SET_COOKIE) {
            let text: String = cookie
                .as_bytes()
                .iter()
                .map(|&byte| char::from(byte))
                .collect();
            let cookie = jar::parse(&text).ok_or(Fail::Unknown)?;
            self.jar.set(cookie, &url).map_err(|()| Fail::Unknown)?;
        }

        if response.status >= 400 {
            return Err(Fail::Safe(
                "Inna electronic-ID login failed or expired. Check your phone and start a fresh explicit login.",
            ));
        }
        let (status, headers) = (response.status, response.headers.clone());
        let body = self
            .net
            .read(&deadline, response, MAX_BODY_BYTES)
            .ok_or(Fail::Unknown)?
            .map_err(|_| Fail::Unknown)?;
        Ok(Reply {
            url,
            status,
            headers,
            text: String::from_utf8_lossy(&body).into_owned(),
        })
    }

    /// `follow`: GETs through at most 20 trusted redirects to a successful page.
    fn follow(&mut self, target: &str) -> Result<Reply> {
        let mut next = trusted(target, None)?;

        for _ in 0..MAX_REDIRECTS {
            let reply = self.request(next.as_str(), None, None)?;

            if (300..=399).contains(&reply.status)
                && let Some(location) =
                    header(&reply.headers, LOCATION).filter(|location| !location.is_empty())
            {
                next = trusted(&location, Some(&next))?;
                continue;
            }

            if !reply.ok() {
                return Err(Fail::Safe("Inna login returned an incomplete redirect."));
            }
            return Ok(reply);
        }
        Err(Fail::Safe("Inna login exceeded its redirect limit."))
    }

    /// `json`: a successful JSON response, parsed; the content type is matched case-sensitively.
    fn json(&mut self, target: &str, body: Option<&Value>, bearer: Option<&str>) -> Result<Value> {
        let reply = self.request(target, body, bearer)?;
        let json = header(&reply.headers, CONTENT_TYPE)
            .is_some_and(|kind| kind.contains("application/json"));

        if !reply.ok() || !json {
            return Err(UNEXPECTED_RESPONSE);
        }
        js::parse(reply.text.as_bytes()).ok_or(Fail::Unknown)
    }

    /// The poll's wait: `delay(milliseconds, { signal })`. A test build with INNA_TEST_WAITS
    /// appends each wait to that file instead, as login.test.ts's `wait` records them.
    fn wait(&self, milliseconds: f64) -> Result<()> {
        #[cfg(feature = "test-origin")]
        if let Some(file) = std::env::var_os("INNA_TEST_WAITS") {
            use std::io::Write;

            let mut waits = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(file)
                .expect("INNA_TEST_WAITS must name a writable file.");
            writeln!(waits, "{}", js::number(milliseconds)).expect("the wait is recorded");
            return match self.signal.aborted() {
                true => Err(Fail::Unknown),
                false => Ok(()),
            };
        }
        let sleep = tokio::time::sleep(Duration::from_secs_f64(milliseconds / 1000.0));
        self.net.wait(self.signal, sleep).ok_or(Fail::Unknown)
    }

    fn run(&mut self, on_code: impl FnOnce(&str), preferred_user_id: Option<i64>) -> Result<Jar> {
        if self.signal.aborted() {
            return Err(Fail::Unknown);
        }
        let start = self.follow("https://r.inna.is/auth/island")?;
        let return_url = start
            .url
            .query_pairs()
            .find(|(name, _)| name == "ReturnUrl")
            .map(|(_, value)| value.into_owned())
            .filter(|value| !value.is_empty());

        let Some(return_url) =
            return_url.filter(|_| on(&start.url, ISSUER_HOST) && start.url.path() == "/app/login")
        else {
            return Err(Fail::Safe(
                "Inna electronic-ID login did not reach the expected phone prompt.",
            ));
        };
        let encoded_return = js::encode_uri_component(&return_url);
        let context = self.json(
            &format!("{ISSUER}/login/context?returnUrl={encoded_return}"),
            None,
            None,
        )?;
        context_shape(&context).ok_or(Fail::Unknown)?;

        let bootstrap = self.json(
            &format!("{ISSUER}/login/phone?returnUrl={encoded_return}"),
            None,
            None,
        )?;
        let (code, verification) = bootstrap_shape(&bootstrap).ok_or(Fail::Unknown)?;

        let device = self.json(
            &format!("{ISSUER}/login/phone/check-device"),
            Some(&json!({ "returnUrl": encoded_return, "userIdentifier": self.phone })),
            None,
        )?;

        if device_shape(&device).ok_or(Fail::Unknown)? {
            return Err(Fail::Safe(
                "This device needs additional verification. Complete sign-in in the browser.",
            ));
        }
        on_code(&code);

        let authentication = self.json(
            &format!("{ISSUER}/login/phone/authenticate"),
            Some(&json!({
                "returnUrl": encoded_return,
                "verificationProperties": verification,
                "userIdentifier": self.phone,
            })),
            None,
        )?;
        let mut session = authentication
            .as_object()
            .and_then(|authentication| authentication.get("session"))
            .and_then(poll_shape)
            .ok_or(Fail::Unknown)?;

        while session.get("isSuccess") != Some(&Value::Bool(true)) {
            let retry = session
                .get("retryWaitTime")
                .and_then(Value::as_f64)
                .unwrap_or_default();
            self.wait(retry.max(1000.0))?;

            if self.signal.aborted() {
                return Err(Fail::Unknown);
            }
            let next = self.json(
                &format!("{ISSUER}/login/phone/poll"),
                Some(&Value::Object(session)),
                None,
            )?;
            session = poll_shape(&next).ok_or(Fail::Unknown)?;
        }

        let signin = self.json(
            &format!("{ISSUER}/login/phone/signin"),
            Some(&json!({ "session": session })),
            None,
        )?;
        let valid_return = string_field(&signin, "validReturnUrl").ok_or(Fail::Unknown)?;
        let issuer = Url::parse(ISSUER).map_err(|_| Fail::Unknown)?;
        let callback = trusted(&valid_return, Some(&issuer))?;

        if !on(&callback, ISSUER_HOST) || callback.path() != "/connect/authorize/callback" {
            return Err(Fail::Safe(
                "Electronic-ID login returned an unexpected callback.",
            ));
        }
        let logout = self.follow(callback.as_str())?;

        if !on(&logout.url, ISSUER_HOST) || logout.url.path() != "/logout" {
            return Err(Fail::Safe(
                "Inna login did not reach the expected identity-provider logout.",
            ));
        }
        let [link] = &post_logout_links(&logout.text)[..] else {
            return Err(Fail::Safe(
                "Inna identity-provider logout callback is missing.",
            ));
        };
        let logout_callback = trusted(link, Some(&logout.url))?;

        if !on(&logout_callback, "heimdallur.inna.is")
            || logout_callback.path() != "/auth/island/logout-callback"
        {
            return Err(Fail::Safe(
                "Inna identity-provider logout returned an unexpected callback.",
            ));
        }
        let bridge = self.follow(logout_callback.as_str())?;

        if !on(&bridge.url, "inna.is") || bridge.url.path() != "/auth/island/callback" {
            return Err(Fail::Safe(
                "Inna electronic-ID login did not reach the expected access page.",
            ));
        }

        // The trusted callback embeds its Inna JWT; never execute upstream JavaScript or decode
        // identity claims.
        let [token] = &access_tokens(&bridge.text)[..] else {
            return Err(Fail::Safe(
                "Inna login returned an unsupported access-token shape.",
            ));
        };
        let token = token.clone();
        let access = self.json("https://inna.is/auth/access", None, Some(&token))?;
        let access = access_shape(&access).ok_or(Fail::Unknown)?;
        let terms = self.json(
            "https://inna.is/auth/user-terms-confirmed",
            None,
            Some(&token),
        )?;

        if !terms_shape(&terms).ok_or(Fail::Unknown)? {
            return Err(Fail::Safe(
                "Review and accept Inna terms yourself in the browser, then sign in again.",
            ));
        }

        // Student contexts keep their position in the full list: the handoff addresses an entry
        // by index.
        let candidates: Vec<(usize, &Access)> = access
            .iter()
            .enumerate()
            .filter(|(_, entry)| entry.is_access && entry.system == 1)
            .collect();
        let chosen = candidates
            .iter()
            .find(|(_, entry)| Some(entry.user_id) == preferred_user_id)
            .or(candidates.first());

        let Some((index, entry)) = chosen else {
            return Err(Fail::Safe(
                "Select the intended school in the browser and import its private session.",
            ));
        };
        let query = [
            ("i", index.to_string()),
            ("system", entry.system.to_string()),
            ("user_id", entry.user_id.to_string()),
            ("status", entry.status.to_string()),
        ]
        .iter()
        .map(|(name, value)| format!("{name}={}", js::encode_query(value)))
        .collect::<Vec<_>>()
        .join("&");
        let school = self.json(
            &format!("https://inna.is/auth/system?{query}"),
            Some(&json!({})),
            Some(&token),
        )?;
        let school_url = trusted(&string_field(&school, "url").ok_or(Fail::Unknown)?, None)?;

        if !on(&school_url, "nam.inna.is") || school_url.path() != "/auth/token" {
            return Err(Fail::Safe(
                "Inna did not return the expected school-session handoff.",
            ));
        }
        let finished = self.follow(school_url.as_str())?;

        if !on(&finished.url, "nam.inna.is")
            || finished.url.path() != "/Components/Students/Students.html"
        {
            return Err(Fail::Safe(
                "Inna login did not finish in the supported student application.",
            ));
        }
        let root = Url::parse("https://nam.inna.is/").map_err(|_| Fail::Unknown)?;
        let mut school_jar = Jar::default();

        for mut cookie in self.jar.get(&root) {
            if SCHOOL_COOKIES.contains(&cookie.key()) {
                cookie.make_secure();
                school_jar.set(cookie, &root).map_err(|()| Fail::Unknown)?;
            }
        }
        Ok(school_jar)
    }
}

/// `loginWithElectronicId(phone, onCode, { signal, preferredUserId })`. `on_code` shows the
/// security code before the phone is asked to approve. Every failure is a reviewed message.
pub fn login_with_electronic_id(
    net: &Net,
    phone: &str,
    on_code: impl FnOnce(&str),
    signal: &Signal,
    preferred_user_id: Option<i64>,
) -> Result<Jar> {
    if !(phone.len() == 7 && phone.bytes().all(|byte| byte.is_ascii_digit())) {
        return Err(Fail::Safe("Enter a seven-digit Icelandic phone number."));
    }
    let signal = signal.any(&Signal::timeout(TIMEOUT));
    let mut login = Login {
        net,
        signal: &signal,
        jar: Jar::default(),
        phone,
    };

    match login.run(on_code, preferred_user_id) {
        Ok(jar) => Ok(jar),
        Err(_) if signal.aborted() => Err(Fail::Safe("Inna login cancelled or timed out.")),
        Err(fail @ Fail::Safe(_)) => Err(fail),
        Err(_) => Err(UNEXPECTED),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `trustedUrl`'s href, its refusal, or `throws`, as Bun reports them.
    fn checked(value: &str, base: Option<&str>) -> String {
        let base = base.map(|base| Url::parse(base).unwrap());

        match trusted(value, base.as_ref()) {
            Ok(url) => url.into(),
            Err(fail) if fail == UNEXPECTED_DESTINATION => "unexpected destination".to_owned(),
            Err(_) => "throws".to_owned(),
        }
    }

    #[test]
    fn only_trusted_https_destinations_are_followed() {
        for (value, base, expected) in [
            (
                "http://nam.inna.is/x?y#z",
                None,
                "https://nam.inna.is/x?y#z",
            ),
            ("http://nam.inna.is:443/x", None, "https://nam.inna.is/x"),
            ("http://nam.inna.is:80/x", None, "https://nam.inna.is/x"),
            ("https://inna.is:443/", None, "https://inna.is/"),
            ("https://inna.is:8443/", None, "unexpected destination"),
            ("https://user@inna.is/", None, "unexpected destination"),
            ("https://:@inna.is/", None, "https://inna.is/"),
            ("https://:p@inna.is/", None, "unexpected destination"),
            ("https://INNA.IS/a", None, "https://inna.is/a"),
            ("https://inna.is./", None, "unexpected destination"),
            (
                "//heimdallur.inna.is/a",
                Some("https://innskra.island.is/logout"),
                "https://heimdallur.inna.is/a",
            ),
            (
                "/b?c",
                Some("https://innskra.island.is/logout?x"),
                "https://innskra.island.is/b?c",
            ),
            ("http://inna.is/", None, "unexpected destination"),
            (
                "https://example.invalid/credential-trap",
                None,
                "unexpected destination",
            ),
            ("javascript:alert(1)", None, "unexpected destination"),
            ("not a url", None, "throws"),
            ("https://in\tna.is/", None, "https://inna.is/"),
            ("https://nam.inna.is\\x/y", None, "https://nam.inna.is/x/y"),
            (
                "HTTP://NAM.INNA.IS/Components/Students/Students.html",
                None,
                "https://nam.inna.is/Components/Students/Students.html",
            ),
            ("https://r.inna.is/%2e%2e/a", None, "https://r.inna.is/a"),
        ] {
            assert_eq!(checked(value, base), expected, "{value}");
        }
    }

    #[test]
    fn access_tokens_are_the_regex_matches() {
        let (a, b, c) = (
            format!("eyJ{}", "a".repeat(12)),
            "b".repeat(20),
            "c".repeat(20),
        );
        let t = format!("{a}.{b}.{c}");
        let short = |text: &str| text[..text.len() - 1].to_owned();

        for (text, expected) in [
            (format!("\"{t}\""), vec![t.clone()]),
            (format!("'{t}'"), vec![t.clone()]),
            (format!("\"{t}'"), vec![]),
            (format!("x\"{t}\"y\"{t}\""), vec![t.clone()]),
            (format!("\"{}.{b}.{c}\"", short(&a)), vec![]),
            (format!("\"{a}.{}.{c}\"", short(&b)), vec![]),
            (format!("\"{a}.{b}.{}\"", short(&c)), vec![]),
            (format!("\"{t}.x\""), vec![]),
            (format!("\"\"{t}\""), vec![t.clone()]),
            (format!("\"'{t}'\""), vec![t.clone()]),
            (format!("\"{t}\"\"{t}2\""), vec![t.clone(), format!("{t}2")]),
            (format!("\"eyj{}\"", &t[3..]), vec![]),
            (format!("\"{t}\"{t}\""), vec![t.clone()]),
            (
                format!("\"{a}-_.{b}.{c}-\""),
                vec![format!("{a}-_.{b}.{c}-")],
            ),
        ] {
            assert_eq!(access_tokens(&text), expected, "{text}");
        }
    }

    #[test]
    fn shapes_are_the_zod_schemas() {
        let poll = json!({
            "deviceLinkUrl": null, "extra": 1, "isSuccess": false, "retryWaitTime": 2000,
            "retries": 1.5, "nexusUrl": "n", "data": "d", "timeoutErrorMessage": "t",
            "isFirstPoll": true, "scriptId": null, "sessionId": "s",
        });
        assert_eq!(
            Value::Object(poll_shape(&poll).unwrap()).to_string(),
            r#"{"isSuccess":false,"retryWaitTime":2000,"retries":1.5,"nexusUrl":"n","data":"d","timeoutErrorMessage":"t","isFirstPoll":true,"scriptId":null,"sessionId":"s","deviceLinkUrl":null}"#
        );

        for (key, invalid) in [
            ("retryWaitTime", json!(30_001)),
            ("retryWaitTime", json!(-1)),
            ("nexusUrl", json!(1)),
            ("data", Value::Null),
            ("isSuccess", json!("true")),
        ] {
            let mut poll = poll.clone();
            poll[key] = invalid;
            assert!(poll_shape(&poll).is_none(), "{key}");
        }
        let mut missing = poll.clone();
        missing.as_object_mut().unwrap().remove("sessionId");
        assert!(poll_shape(&missing).is_none());

        assert_eq!(
            bootstrap_shape(&json!({ "displayCode": "0123", "verificationProperties": "v" })),
            Some(("0123".to_owned(), "v".to_owned()))
        );

        for code in ["123", "12345", "١٢٣٤", "12a4"] {
            assert!(
                bootstrap_shape(&json!({ "displayCode": code, "verificationProperties": "v" }))
                    .is_none()
            );
        }
        let entry = json!({ "system": 1, "user_id": 2, "status": 3, "is_access": true });
        assert_eq!(access_shape(&json!([entry])).unwrap()[0].user_id, 2);

        for (key, invalid) in [
            ("system", json!(1.5)),
            ("user_id", json!(9_007_199_254_740_992_u64)),
            ("status", json!("3")),
            ("is_access", json!(1)),
        ] {
            let mut entry = entry.clone();
            entry[key] = invalid;
            assert!(access_shape(&json!([entry])).is_none(), "{key}");
        }
        assert!(context_shape(&json!({ "identityProviderRestrictions": ["a"] })).is_some());
        assert!(context_shape(&json!({ "identityProviderRestrictions": [1] })).is_none());
        assert_eq!(
            device_shape(&json!({ "isTwoFactorRequired": false, "isNewLoginRestricted": true })),
            Some(true)
        );
    }
}
