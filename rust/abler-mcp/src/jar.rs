//! The part of tough-cookie 6's `CookieJar` the TypeScript server uses, for one host: setting
//! parsed `Set-Cookie` headers and imported cookies, the `Cookie` header, expiry, time to live,
//! and the stored session format. Only `id_token` and `refreshToken` ever enter a jar.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value, json};

use crate::js;

pub const HOST: &str = "www.abler.io";

const PARENT: &str = "abler.io";

/// The authentication cookies; every other cookie is ignored.
pub const AUTH_COOKIES: [&str; 2] = ["id_token", "refreshToken"];

/// tough-cookie's `Cookie.cookiesCreated`: orders cookies created in the same millisecond.
static CREATED: AtomicU64 = AtomicU64::new(0);

fn next_index() -> u64 {
    CREATED.fetch_add(1, Ordering::Relaxed) + 1
}

#[derive(Debug, Clone)]
pub struct Cookie {
    pub key: String,
    pub value: String,
    /// As set: a cookie whose domain only canonicalizes to Abler's is kept but never sent.
    domain: String,
    host_only: bool,
    pub path: String,
    /// Epoch milliseconds; `None` is tough-cookie's `"Infinity"`.
    expires: Option<f64>,
    /// Seconds; an infinite value is tough-cookie's string form, which counts as expired.
    max_age: Option<f64>,
    creation: f64,
    creation_index: u64,
    last_accessed: f64,
}

impl Cookie {
    fn new(key: &str, value: &str) -> Self {
        let now = js::now_ms();
        Self {
            key: key.to_owned(),
            value: value.to_owned(),
            domain: String::new(),
            host_only: false,
            path: String::new(),
            expires: None,
            max_age: None,
            creation: now,
            creation_index: next_index(),
            last_accessed: now,
        }
    }

    /// `Cookie.TTL()`.
    pub fn ttl(&self, now: f64) -> f64 {
        match self.max_age {
            Some(age) if age.is_finite() => {
                if age <= 0.0 {
                    0.0
                } else {
                    age * 1000.0
                }
            }
            _ => self.expires.map_or(f64::INFINITY, |at| at - now),
        }
    }

    /// `Cookie.expiryTime()`, relative to the last access for `Max-Age`.
    fn expiry_time(&self) -> f64 {
        match self.max_age {
            Some(age) if age.is_finite() && age > 0.0 => self.last_accessed + age * 1000.0,
            Some(_) => f64::NEG_INFINITY,
            None => self.expires.unwrap_or(f64::INFINITY),
        }
    }

    fn visible(&self) -> bool {
        self.domain == HOST || (!self.host_only && self.domain == PARENT)
    }
}

/// RFC 6265 path-match, as tough-cookie implements it.
fn path_match(request: &str, cookie: &str) -> bool {
    request == cookie
        || (request.starts_with(cookie)
            && (cookie.ends_with('/') || request[cookie.len()..].starts_with('/')))
}

/// The default path for a request path.
fn default_path(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(_) if !path.starts_with('/') => "/".to_owned(),
        Some(slash) => path[..slash].to_owned(),
    }
}

/// `Cookie.parse` of one `Set-Cookie` value (strict mode). `None` when tough-cookie returns
/// `undefined`.
pub fn parse_set_cookie(header: &str) -> Option<Cookie> {
    let header = js::trim(header);
    let (pair, attributes) = match header.find(';') {
        Some(semi) => (&header[..semi], Some(&header[semi + 1..])),
        None => (header, None),
    };
    // trimTerminator: the pair ends at its first line feed, carriage return or NUL.
    let pair = pair.split(['\n', '\r', '\0']).next().unwrap_or_default();
    let equals = pair.find('=').filter(|&at| at > 0)?;
    let (name, value) = (js::trim(&pair[..equals]), js::trim(&pair[equals + 1..]));

    if name.chars().chain(value.chars()).any(|c| c <= '\u{1f}') {
        return None;
    }
    let mut cookie = Cookie::new(name, value);

    for attribute in attributes.map(js::trim).unwrap_or_default().split(';') {
        let attribute = js::trim(attribute);

        if attribute.is_empty() {
            continue;
        }
        let (key, value) = match attribute.find('=') {
            Some(at) => (&attribute[..at], Some(js::trim(&attribute[at + 1..]))),
            None => (attribute, None),
        };
        let value = value.filter(|value| !value.is_empty());

        match js::trim(key).to_lowercase().as_str() {
            "expires" => {
                if let Some(at) = value.and_then(parse_date) {
                    cookie.expires = Some(at);
                }
            }
            "max-age" => {
                if let Some(value) = value.filter(|value| is_integer(value)) {
                    cookie.max_age = Some(value.parse::<f64>().unwrap_or(f64::NAN));
                }
            }
            "domain" => {
                if let Some(value) = value {
                    let domain = js::trim(value);
                    let domain = domain.strip_prefix('.').unwrap_or(domain);

                    if !domain.is_empty() {
                        cookie.domain = domain.to_lowercase();
                    }
                }
            }
            "path" => {
                cookie.path = value
                    .filter(|value| value.starts_with('/'))
                    .unwrap_or_default()
                    .to_owned();
            }
            _ => {}
        }
    }
    Some(cookie)
}

fn is_integer(value: &str) -> bool {
    let digits = value.strip_prefix('-').unwrap_or(value);
    !digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
}

/// tough-cookie's `parseDate` (RFC 6265 section 5.1.1): epoch milliseconds.
fn parse_date(text: &str) -> Option<f64> {
    let delimiter = |c: char| matches!(c, '\t' | '\u{20}'..='\u{2f}' | '\u{3b}'..='\u{40}' | '\u{5b}'..='\u{60}' | '\u{7b}'..='\u{7e}');
    let (mut time, mut day, mut month, mut year) = (None, None, None, None);
    // A token's leading digits, then either its end or a non-digit followed by anything.
    let leading = |token: &str, min: usize, max: usize| -> Option<u32> {
        let digits = token.bytes().take_while(u8::is_ascii_digit).count();
        (min..=max)
            .contains(&digits)
            .then(|| token[..digits].parse().ok())
            .flatten()
    };

    for token in text.split(delimiter).filter(|token| !token.is_empty()) {
        if time.is_none() {
            let parts: Vec<&str> = token.splitn(3, ':').collect();

            if let [hours, minutes, rest] = parts[..] {
                let all = |part: &str| {
                    (1..=2).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit())
                };

                if all(hours)
                    && all(minutes)
                    && let Some(seconds) = leading(rest, 1, 2)
                {
                    time = Some((
                        hours.parse::<u32>().ok()?,
                        minutes.parse::<u32>().ok()?,
                        seconds,
                    ));
                    continue;
                }
            }
        }

        if day.is_none()
            && let Some(value) = leading(token, 1, 2)
        {
            day = Some(value);
            continue;
        }

        if month.is_none() && token.len() >= 3 && token.is_char_boundary(3) {
            let months = [
                "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
            ];

            if let Some(index) = months
                .iter()
                .position(|name| token[..3].eq_ignore_ascii_case(name))
            {
                month = Some(index as u32);
                continue;
            }
        }

        if year.is_none()
            && let Some(value) = leading(token, 2, 4)
        {
            year = Some(value);
            continue;
        }
    }
    let ((hours, minutes, seconds), day, month, mut year) = (time?, day?, month?, year?);

    if (70..=99).contains(&year) {
        year += 1900;
    } else if year <= 69 {
        year += 2000;
    }

    if !(1..=31).contains(&day) || year < 1601 || hours > 23 || minutes > 59 || seconds > 59 {
        return None;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];

    if day > days_in_month[month as usize] {
        return None;
    }
    let days = days_from_civil(i64::from(year), month + 1, day);
    let seconds = days * 86_400 + i64::from(hours * 3600 + minutes * 60 + seconds);
    Some(seconds as f64 * 1000.0)
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let month = i64::from(month);
    let of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_era_days - 719_468
}

#[derive(Debug, Clone, Default)]
pub struct Jar {
    cookies: Vec<Cookie>,
}

/// A cookie tough-cookie refused; its message may hold untrusted header text, so it has none.
#[derive(Debug)]
pub struct Refused;

/// Why `importCookies` failed. Capture reports the last two; every other caller has one message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportError {
    /// Not cookie JSON, or a cookie the jar refused: not a `SafeError` in TypeScript.
    Input,
    /// `Invalid Abler authentication cookie.`
    Cookie,
    /// `No unexpired Abler refreshToken cookie found. ...`
    NoRefresh,
}

impl Jar {
    /// `setCookie(cookie, https://www.abler.io<path>)`.
    pub fn set(&mut self, mut cookie: Cookie, request_path: &str) -> Result<(), Refused> {
        if cookie.domain.is_empty() {
            cookie.host_only = true;
            cookie.domain = HOST.to_owned();
        } else {
            // canonicalDomain, then domainMatch against the host. Domains outside ASCII are refused
            // here; tough-cookie maps a few through IDNA first.
            let canonical = js::trim(&cookie.domain);
            let canonical = canonical.strip_prefix('.').unwrap_or(canonical);

            if !canonical.is_ascii()
                || ![HOST, PARENT].contains(&canonical.to_ascii_lowercase().as_str())
            {
                return Err(Refused);
            }
            cookie.host_only = false;
        }

        if !cookie.path.starts_with('/') {
            cookie.path = default_path(request_path);
        }
        let now = js::now_ms();
        let existing = self.cookies.iter().position(|old| {
            old.domain == cookie.domain && old.path == cookie.path && old.key == cookie.key
        });

        cookie.last_accessed = now;

        match existing {
            Some(at) => {
                cookie.creation = self.cookies[at].creation;
                cookie.creation_index = self.cookies[at].creation_index;
                self.cookies[at] = cookie;
            }
            None => {
                cookie.creation = now;
                self.cookies.push(cookie);
            }
        }
        Ok(())
    }

    /// `getCookies(https://www.abler.io<path>)`: drops the expired cookies it matches, marks the
    /// rest accessed, and orders them by path length, then creation.
    pub fn get(&mut self, request_path: &str) -> Vec<Cookie> {
        let now = js::now_ms();
        let matches = |cookie: &Cookie| cookie.visible() && path_match(request_path, &cookie.path);
        self.cookies
            .retain(|cookie| !(matches(cookie) && cookie.expiry_time() <= now));
        let mut found: Vec<&mut Cookie> = self.cookies.iter_mut().filter(|c| matches(c)).collect();
        found.sort_by(|a, b| {
            b.path
                .len()
                .cmp(&a.path.len())
                .then(a.creation.total_cmp(&b.creation))
                .then(a.creation_index.cmp(&b.creation_index))
        });
        let accessed = js::now_ms();
        found
            .into_iter()
            .map(|cookie| {
                cookie.last_accessed = accessed;
                cookie.clone()
            })
            .collect()
    }

    /// `getCookieString`.
    pub fn header(&mut self, request_path: &str) -> String {
        self.get(request_path)
            .iter()
            .map(|cookie| format!("{}={}", cookie.key, cookie.value))
            .collect::<Vec<_>>()
            .join("; ")
    }

    pub fn has(&mut self, request_path: &str, key: &str) -> bool {
        self.get(request_path)
            .iter()
            .any(|cookie| cookie.key == key)
    }

    /// The session as saved: `{version: 1, cookies}`, only the authentication cookies, pinned to
    /// Abler's HTTPS host, in creation order.
    pub fn serialize(&self) -> Value {
        let mut cookies: Vec<&Cookie> = self
            .cookies
            .iter()
            .filter(|cookie| AUTH_COOKIES.contains(&cookie.key.as_str()))
            .collect();
        cookies.sort_by_key(|cookie| cookie.creation_index);
        let cookies: Vec<Value> = cookies
            .into_iter()
            .map(|cookie| {
                let expires = cookie.expiry_time();
                let expires = if expires == f64::NEG_INFINITY {
                    0.0
                } else if expires.is_finite() {
                    expires / 1000.0
                } else {
                    -1.0
                };
                json!({
                    "name": cookie.key,
                    "value": cookie.value,
                    "domain": HOST,
                    "path": cookie.path,
                    "expires": js::number(expires),
                    "httpOnly": true,
                    "secure": true,
                })
            })
            .collect();
        json!({ "version": 1, "cookies": cookies })
    }

    /// `importCookies`: browser cookie JSON (an array, or `{cookies: [...]}`), reduced to the
    /// authentication cookies for Abler, which must include an unexpired `refreshToken`.
    pub fn import(input: &Value) -> Result<Jar, ImportError> {
        let list = match input {
            Value::Array(list) => list,
            Value::Object(object) => match object.get("cookies") {
                Some(Value::Array(list)) => list,
                _ => return Err(ImportError::Input),
            },
            _ => return Err(ImportError::Input),
        };
        let mut jar = Jar::default();

        for item in list {
            let Some(item) = item.as_object() else {
                continue;
            };
            let (Some(Value::String(name)), Some(Value::String(domain))) =
                (item.get("name"), item.get("domain"))
            else {
                continue;
            };

            // Ignore unrelated browser cookies, including analytics and other sites.
            if !AUTH_COOKIES.contains(&name.as_str())
                || ![HOST, PARENT].contains(&domain.strip_prefix('.').unwrap_or(domain))
            {
                continue;
            }
            let (value, path, expires) = browser_cookie(item).ok_or(ImportError::Cookie)?;
            let mut cookie = Cookie::new(name, value);
            cookie.path = path.to_owned();
            // `new Date(seconds * 1000)` keeps whole milliseconds.
            cookie.expires = (expires >= 0.0).then(|| (expires * 1000.0).trunc() + 0.0);
            jar.set(cookie, "/").map_err(|_| ImportError::Input)?;
        }

        if !jar.has("/oauth/token", "refreshToken") {
            return Err(ImportError::NoRefresh);
        }
        Ok(jar)
    }
}

/// The `browserCookie` schema and the value and path checks: value, path and expiry seconds.
fn browser_cookie(item: &Map<String, Value>) -> Option<(&str, &str, f64)> {
    let value = item.get("value")?.as_str()?;

    if !(1..=32_768).contains(&js::length(value))
        || !value
            .bytes()
            .all(|b| (0x21..=0x7e).contains(&b) && b != b';')
    {
        return None;
    }
    let path = match item.get("path") {
        None => "/",
        Some(path) => path.as_str()?,
    };
    let seconds = |key: &str| -> Option<Option<f64>> {
        match item.get(key) {
            None => Some(None),
            Some(value) => value
                .as_f64()
                .filter(|seconds| (-1.0..=253_402_300_799.0).contains(seconds))
                .map(Some),
        }
    };
    let (expires, expiration) = (seconds("expires")?, seconds("expirationDate")?);

    if item.get("httpOnly").is_some_and(|flag| !flag.is_boolean()) {
        return None;
    }

    if !path.starts_with('/') || path.contains([';', '\r', '\n']) {
        return None;
    }
    Some((value, path, expires.or(expiration).unwrap_or(-1.0)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_cookie_parsing_follows_tough_cookie() {
        let cookie =
            parse_set_cookie(" id_token = a b ; Path=/x; Max-Age=600; HttpOnly\nignored").unwrap();
        assert_eq!(
            (cookie.key.as_str(), cookie.value.as_str()),
            ("id_token", "a b")
        );
        assert_eq!((cookie.path.as_str(), cookie.max_age), ("/x", Some(600.0)));
        assert!(parse_set_cookie("=x").is_none());
        assert!(parse_set_cookie("novalue").is_none());
        assert!(parse_set_cookie("a=\u{1}").is_none());
        assert_eq!(parse_set_cookie("a=b\rc; Path=/p").unwrap().value, "b");
        assert_eq!(parse_set_cookie("a=b; Path=relative").unwrap().path, "");
        assert_eq!(parse_set_cookie("a=b; Max-Age=1.5").unwrap().max_age, None);
        assert_eq!(
            parse_set_cookie("a=b; Domain=.WWW.Abler.IO")
                .unwrap()
                .domain,
            "www.abler.io"
        );
        let dated = |text: &str| {
            parse_set_cookie(&format!("a=b; Expires={text}"))
                .unwrap()
                .expires
        };
        assert_eq!(
            dated("Wed, 21 Oct 2015 07:28:00 GMT"),
            Some(1_445_412_480_000.0)
        );
        assert_eq!(dated("21-Oct-15 07:28:00"), Some(1_445_412_480_000.0));
        assert_eq!(dated("Thu, 01 Jan 1970 00:00:00 GMT"), Some(0.0));
        assert_eq!(dated("Fri, 30 Feb 2015 07:28:00 GMT"), None);
        assert_eq!(dated("Wed, 21 Oct 1600 07:28:00 GMT"), None);
        assert_eq!(dated("Wed, 21 Oct 2015 24:28:00 GMT"), None);
    }

    #[test]
    fn jar_matches_paths_domains_and_expiry() {
        let mut jar = Jar::default();
        for header in [
            "refreshToken=r; Path=/",
            "id_token=deep; Path=/graphql",
            "id_token=root; Path=/",
            "id_token=old; Path=/; Max-Age=0",
        ] {
            jar.set(parse_set_cookie(header).unwrap(), "/oauth/token")
                .unwrap();
        }
        // The expired cookie replaced the root one and is dropped on access.
        assert_eq!(jar.header("/graphql"), "id_token=deep; refreshToken=r");
        assert_eq!(jar.header("/graphqlx"), "refreshToken=r");
        jar.set(
            parse_set_cookie("refreshToken=d; Domain=abler.io").unwrap(),
            "/oauth/token",
        )
        .unwrap();
        assert_eq!(jar.header("/oauth/x"), "refreshToken=d; refreshToken=r");
        for refused in [
            "a=b; Domain=example.com",
            "a=b; Domain=io",
            "a=b; Domain=w.abler.io",
        ] {
            assert!(jar.set(parse_set_cookie(refused).unwrap(), "/").is_err());
        }
        // Kept but never sent, as tough-cookie keeps a domain that only canonicalizes to Abler's.
        jar.set(
            parse_set_cookie("id_token=hidden; Domain=..abler.io").unwrap(),
            "/",
        )
        .unwrap();
        assert!(!jar.header("/").contains("hidden"));
        assert!(jar.serialize().to_string().contains("hidden"));
    }
}
