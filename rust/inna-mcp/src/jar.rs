//! The part of tough-cookie 6.0.2's `CookieJar` (with its `MemoryCookieStore`) the TypeScript
//! client uses for nam.inna.is and the electronic-ID sign-in uses for its hosts under inna.is and
//! island.is: `Cookie.parse`, `setCookie(cookie, url)`, `getCookies(url)`,
//! `getCookieString(url)`, and the saved jar as `JSON.stringify(await jar.serialize())` and
//! `CookieJar.deserialize(text)`, so a session saved by either language reads in the other.
//! Adapted from rust/infomentor-mcp/src/jar.rs, which its parity suite checks against Bun; here
//! a refused cookie is an error, as `setCookie` rejects without `ignoreError`.

use std::cmp::Ordering;
use std::sync::atomic::{AtomicU64, Ordering as Atomic};

use serde_json::{Map, Value, json};
use url::Url;

use crate::js;

/// tough-cookie's `Cookie.cookiesCreated`: orders cookies created in the same millisecond.
static CREATED: AtomicU64 = AtomicU64::new(0);

fn next_index() -> u64 {
    CREATED.fetch_add(1, Atomic::Relaxed) + 1
}

/// A `Date` property, or tough-cookie's `"Infinity"`. A date may be invalid (NaN), as
/// `new Date(text)` makes one from text it cannot read.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Time {
    Infinity,
    At(f64),
}

impl Time {
    /// `fromJSON`'s `val == "Infinity" ? "Infinity" : new Date(val)`.
    fn read(text: &str) -> Self {
        match text {
            "Infinity" => Time::Infinity,
            _ => Time::At(js::parse_date(text)),
        }
    }

    /// `toJSON`'s form; `None` where `toISOString` throws on an invalid date.
    fn write(self) -> Option<Value> {
        match self {
            Time::Infinity => Some(json!("Infinity")),
            Time::At(ms) => js::iso_string(ms).map(Value::String),
        }
    }
}

/// `maxAge`: seconds, or the string an infinite `setMaxAge` stores.
#[derive(Debug, Clone, Copy, PartialEq)]
enum MaxAge {
    Seconds(f64),
    Infinity,
    NegInfinity,
}

#[derive(Debug, Clone)]
pub struct Cookie {
    key: String,
    value: String,
    expires: Time,
    max_age: Option<MaxAge>,
    domain: Option<String>,
    path: Option<String>,
    secure: bool,
    http_only: bool,
    extensions: Option<Vec<String>>,
    host_only: Option<bool>,
    path_is_default: Option<bool>,
    creation: Time,
    last_accessed: Option<Time>,
    same_site: Option<String>,
    index: u64,
}

impl Default for Cookie {
    /// `new Cookie()`: `cookieDefaults`, created now.
    fn default() -> Self {
        Self {
            key: String::new(),
            value: String::new(),
            expires: Time::Infinity,
            max_age: None,
            domain: None,
            path: None,
            secure: false,
            http_only: false,
            extensions: None,
            host_only: None,
            path_is_default: None,
            creation: Time::At(js::now_ms()),
            last_accessed: None,
            same_site: None,
            index: next_index(),
        }
    }
}

impl Cookie {
    /// `new Cookie({ key, value, path: '/', secure: true, httpOnly })` with an export's expiry
    /// in seconds (`new Date(seconds * 1000)`) and SameSite: a cookie `sessionJar` imports.
    pub fn exported(
        key: &str,
        value: &str,
        http_only: bool,
        expires: Option<f64>,
        same_site: Option<&str>,
    ) -> Self {
        Self {
            key: key.to_owned(),
            value: value.to_owned(),
            // TimeClip: whole milliseconds, and an invalid date beyond 8.64e15.
            expires: expires.map_or(Time::Infinity, |seconds| {
                let at = seconds * 1000.0;
                Time::At(match at.abs() <= 8.64e15 {
                    true => at.trunc() + 0.0,
                    false => f64::NAN,
                })
            }),
            path: Some("/".to_owned()),
            secure: true,
            http_only,
            same_site: same_site.map(str::to_owned),
            ..Self::default()
        }
    }

    pub fn key(&self) -> &str {
        &self.key
    }

    pub fn value(&self) -> &str {
        &self.value
    }

    /// `cookie.secure = true`, as the electronic-ID sign-in marks each school cookie it keeps.
    pub fn make_secure(&mut self) {
        self.secure = true;
    }

    /// `expiryTime()`: `Max-Age` counts from the last access; NaN for an invalid date.
    fn expiry_time(&self, now: f64) -> f64 {
        match self.max_age {
            Some(max_age) => {
                let age = match max_age {
                    MaxAge::Seconds(seconds) if seconds > 0.0 => seconds * 1000.0,
                    MaxAge::Seconds(seconds) if seconds.is_nan() => f64::NAN,
                    _ => f64::NEG_INFINITY,
                };
                match self.last_accessed.unwrap_or(Time::At(now)) {
                    Time::Infinity => f64::INFINITY,
                    Time::At(at) => at + age,
                }
            }
            None => match self.expires {
                Time::Infinity => f64::INFINITY,
                Time::At(at) => at,
            },
        }
    }

    /// `cookieString()`.
    fn pair(&self) -> String {
        match self.key.is_empty() {
            true => self.value.clone(),
            false => format!("{}={}", self.key, self.value),
        }
    }

    /// `toJSON()`: the properties that differ from `cookieDefaults`, in tough-cookie's order.
    fn to_json(&self) -> Option<Value> {
        let mut object = Map::new();
        let mut put = |name: &str, value: Value| object.insert(name.to_owned(), value);

        if !self.key.is_empty() {
            put("key", json!(self.key));
        }

        if !self.value.is_empty() {
            put("value", json!(self.value));
        }

        if self.expires != Time::Infinity {
            put("expires", self.expires.write()?);
        }

        if let Some(max_age) = self.max_age {
            put(
                "maxAge",
                match max_age {
                    MaxAge::Seconds(seconds) => js::number(seconds),
                    MaxAge::Infinity => json!("Infinity"),
                    MaxAge::NegInfinity => json!("-Infinity"),
                },
            );
        }

        if let Some(domain) = &self.domain {
            put("domain", json!(domain));
        }

        if let Some(path) = &self.path {
            put("path", json!(path));
        }

        if self.secure {
            put("secure", json!(true));
        }

        if self.http_only {
            put("httpOnly", json!(true));
        }

        if let Some(extensions) = &self.extensions {
            put("extensions", json!(extensions));
        }

        if let Some(host_only) = self.host_only {
            put("hostOnly", json!(host_only));
        }

        if let Some(path_is_default) = self.path_is_default {
            put("pathIsDefault", json!(path_is_default));
        }
        put("creation", self.creation.write()?);

        if let Some(last_accessed) = self.last_accessed {
            put("lastAccessed", last_accessed.write()?);
        }

        if let Some(same_site) = &self.same_site {
            put("sameSite", json!(same_site));
        }
        Some(Value::Object(object))
    }

    /// `Cookie.fromJSON` of an object: each known property of the right type that differs from
    /// its default.
    fn from_json(object: &Map<String, Value>) -> Self {
        let mut cookie = Cookie::default();
        let text = |name: &str| object.get(name).and_then(Value::as_str);
        let flag = |name: &str| object.get(name).and_then(Value::as_bool);

        if let Some(key) = text("key") {
            cookie.key = key.to_owned();
        }

        if let Some(value) = text("value") {
            cookie.value = value.to_owned();
        }

        let time = |name: &str| -> Option<Option<Time>> {
            match object.get(name)? {
                Value::String(text) => Some(Some(Time::read(text))),
                Value::Number(number) => Some(Some(Time::At(
                    number.as_f64().map_or(f64::NAN, |ms| ms.trunc() + 0.0),
                ))),
                Value::Null => Some(None),
                _ => None,
            }
        };

        // A null `expires` stays null: no expiry, as tough-cookie reads it.
        if let Some(expires) = time("expires") {
            cookie.expires = expires.unwrap_or(Time::Infinity);
        }
        cookie.max_age = match object.get("maxAge") {
            Some(Value::Number(number)) => number.as_f64().map(MaxAge::Seconds),
            Some(Value::String(text)) if text == "Infinity" => Some(MaxAge::Infinity),
            Some(Value::String(text)) if text == "-Infinity" => Some(MaxAge::NegInfinity),
            _ => None,
        };
        cookie.domain = text("domain").map(str::to_owned);
        cookie.path = text("path").map(str::to_owned);
        cookie.secure = flag("secure").unwrap_or(false);
        cookie.http_only = flag("httpOnly").unwrap_or(false);

        if let Some(Value::Array(items)) = object.get("extensions")
            && let Some(items) = items
                .iter()
                .map(|item| item.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()
        {
            cookie.extensions = Some(items);
        }
        cookie.host_only = flag("hostOnly");
        cookie.path_is_default = flag("pathIsDefault");

        if let Some(Some(creation)) = time("creation") {
            cookie.creation = creation;
        }
        cookie.last_accessed = time("lastAccessed").flatten();
        cookie.same_site = text("sameSite").map(str::to_owned);
        cookie
    }
}

/// `Cookie.parse(header)` in strict mode; `None` where it returns `undefined`.
pub fn parse(header: &str) -> Option<Cookie> {
    let header = js::trim(header);

    if header.is_empty() {
        return None;
    }
    let (pair, attributes) = match header.split_once(';') {
        Some((pair, attributes)) => (pair, Some(attributes)),
        None => (header, None),
    };
    // trimTerminator: the pair ends at its first line feed, carriage return or NUL.
    let pair = pair.split(['\n', '\r', '\0']).next().unwrap_or_default();
    let equals = pair.find('=').filter(|&at| at > 0)?;
    let (key, value) = (js::trim(&pair[..equals]), js::trim(&pair[equals + 1..]));

    if key.chars().chain(value.chars()).any(|c| c <= '\u{1f}') {
        return None;
    }
    let mut cookie = Cookie {
        key: key.to_owned(),
        value: value.to_owned(),
        ..Cookie::default()
    };

    for attribute in attributes.map(js::trim).unwrap_or_default().split(';') {
        let attribute = js::trim(attribute);

        if attribute.is_empty() {
            continue;
        }
        let (name, value) = match attribute.split_once('=') {
            Some((name, value)) => (name, Some(js::trim(value))),
            None => (attribute, None),
        };
        let value = value.filter(|value| !value.is_empty());

        match js::trim(name).to_lowercase().as_str() {
            "expires" => {
                if let Some(at) = value.and_then(parse_date) {
                    cookie.expires = Time::At(at);
                }
            }
            "max-age" => {
                if let Some(value) = value.filter(|value| is_integer(value)) {
                    // parseInt reads every digit; past f64's range it is infinite.
                    let seconds: f64 = value.parse().unwrap_or(f64::NAN);
                    cookie.max_age = Some(match seconds {
                        f64::INFINITY => MaxAge::Infinity,
                        f64::NEG_INFINITY => MaxAge::NegInfinity,
                        _ => MaxAge::Seconds(seconds),
                    });
                }
            }
            "domain" => {
                if let Some(value) = value {
                    let domain = js::trim(value);
                    let domain = domain.strip_prefix('.').unwrap_or(domain);

                    if !domain.is_empty() {
                        cookie.domain = Some(domain.to_lowercase());
                    }
                }
            }
            "path" => {
                cookie.path = value
                    .filter(|value| value.starts_with('/'))
                    .map(str::to_owned);
            }
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            "samesite" => {
                cookie.same_site = match value.unwrap_or_default().to_lowercase().as_str() {
                    same @ ("strict" | "lax" | "none") => Some(same.to_owned()),
                    _ => None,
                };
            }
            _ => cookie
                .extensions
                .get_or_insert_with(Vec::new)
                .push(attribute.to_owned()),
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
    let leading = |token: &str, min: usize, max: usize| -> Option<i64> {
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
                        hours.parse::<i64>().ok()?,
                        minutes.parse::<i64>().ok()?,
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
                month = Some(index as i64 + 1);
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
    // Date.UTC rolls an impossible day over; tough-cookie then refuses the date.
    let text = format!("{year:04}-{month:02}-{day:02}T{hours:02}:{minutes:02}:{seconds:02}Z");
    js::iso_datetime(&text)
}

/// RFC 6265 path-match, as tough-cookie implements it.
fn path_match(request: &str, cookie: &str) -> bool {
    request == cookie
        || (request.starts_with(cookie)
            && (cookie.ends_with('/') || request[cookie.len()..].starts_with('/')))
}

/// `defaultPath`.
fn default_path(path: &str) -> String {
    if !path.starts_with('/') || path == "/" {
        return "/".to_owned();
    }
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(slash) => path[..slash].to_owned(),
    }
}

/// `domainMatch(host, domain, false)` for a host name that is never an IP address.
fn domain_match(host: &str, domain: &str) -> bool {
    host == domain
        || (!domain.is_empty()
            && host
                .strip_suffix(domain)
                .is_some_and(|rest| rest.ends_with('.')))
}

/// `permuteDomain(host)`: the registrable domain and each longer suffix of `host`. Every host the
/// jar sees is under `is`, whose only public suffix is `is`, so the registrable domain is the last
/// two labels.
fn permute(host: &str) -> Vec<&str> {
    let mut domains: Vec<&str> = host
        .match_indices('.')
        .map(|(at, _)| &host[at + 1..])
        .filter(|suffix| suffix.contains('.'))
        .collect();
    domains.reverse();
    domains.push(host);
    domains
}

/// The request context tough-cookie reads from a URL: its host, and its decoded path.
fn context(url: &Url) -> (&str, String) {
    let path = url.path();
    let path = js::decode_uri(path).unwrap_or_else(|| path.to_owned());
    (url.host_str().unwrap_or_default(), path)
}

/// `cookieCompare`: longer paths first, then older, then created earlier.
fn compare(a: &Cookie, b: &Cookie) -> Ordering {
    let length = |cookie: &Cookie| cookie.path.as_deref().map_or(0, js::units);
    let time = |cookie: &Cookie| match cookie.creation {
        Time::At(at) => at,
        Time::Infinity => 2_147_483_647_000.0,
    };
    length(b)
        .cmp(&length(a))
        // A NaN difference counts as equal, as Array.prototype.sort reads it.
        .then(time(a).partial_cmp(&time(b)).unwrap_or(Ordering::Equal))
        .then(a.index.cmp(&b.index))
}

/// The four `CookieJar` options a serialized jar carries, as `deserialize` reads them.
#[derive(Debug, Clone)]
struct Options {
    reject_public_suffixes: bool,
    loose_mode: bool,
    allow_special_use_domain: bool,
    prefix_security: String,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            reject_public_suffixes: true,
            loose_mode: false,
            allow_special_use_domain: true,
            prefix_security: "silent".to_owned(),
        }
    }
}

/// A `MemoryCookieStore`: one cookie per domain, path and key.
#[derive(Debug, Clone, Default)]
pub struct Jar {
    cookies: Vec<Cookie>,
    options: Options,
}

impl Jar {
    /// `putCookie` and `updateCookie`: replaces the cookie with the same domain, path and key in
    /// place; one without a domain or path is not stored.
    fn put(&mut self, cookie: Cookie) {
        let (Some(domain), Some(path)) = (&cookie.domain, &cookie.path) else {
            return;
        };
        let existing = self.cookies.iter().position(|old| {
            old.domain.as_ref() == Some(domain)
                && old.path.as_ref() == Some(path)
                && old.key == cookie.key
        });

        match existing {
            Some(at) => self.cookies[at] = cookie,
            None => self.cookies.push(cookie),
        }
    }

    /// `setCookie(cookie, url)` of a parsed cookie: `Err` where tough-cookie rejects it (a
    /// public-suffix or foreign domain); a prefix violation is dropped, as `"silent"` does.
    pub fn set(&mut self, mut cookie: Cookie, url: &Url) -> Result<(), ()> {
        let (host, path) = context(url);

        match &cookie.domain {
            Some(domain) => {
                // cdomain(). A non-ASCII domain never matches an ASCII host.
                let canonical = js::trim(domain);
                let canonical = canonical.strip_prefix('.').unwrap_or(canonical);

                if !canonical.is_ascii() {
                    return Err(());
                }
                let canonical = canonical.to_ascii_lowercase();

                // A public suffix (here only `is`) is refused, then a domain outside the host's.
                if (self.options.reject_public_suffixes
                    && (canonical.is_empty() || !canonical.contains('.')))
                    || !domain_match(host, &canonical)
                {
                    return Err(());
                }

                if cookie.host_only.is_none() {
                    cookie.host_only = Some(false);
                }
            }
            None => {
                cookie.host_only = Some(true);
                cookie.domain = Some(host.to_owned());
            }
        }

        if !cookie
            .path
            .as_deref()
            .is_some_and(|path| path.starts_with('/'))
        {
            cookie.path = Some(default_path(&path));
            cookie.path_is_default = Some(true);
        }

        if self.options.prefix_security != "unsafe-disabled" {
            let secure_prefix = cookie.key.starts_with("__Secure-") && !cookie.secure;
            let host_prefix = cookie.key.starts_with("__Host-")
                && !(cookie.secure
                    && cookie.host_only == Some(true)
                    && cookie.path.as_deref() == Some("/"));

            if secure_prefix || host_prefix {
                return match self.options.prefix_security.as_str() {
                    "strict" => Err(()),
                    _ => Ok(()),
                };
            }
        }
        let now = Time::At(js::now_ms());
        let existing = self.cookies.iter().find(|old| {
            old.domain == cookie.domain && old.path == cookie.path && old.key == cookie.key
        });

        match existing {
            Some(old) => {
                cookie.creation = old.creation;
                cookie.index = old.index;
            }
            None => cookie.creation = now,
        }
        cookie.last_accessed = Some(now);
        self.put(cookie);
        Ok(())
    }

    /// `getCookies(url)`: the expired cookies it matches are removed, the rest marked accessed
    /// and ordered by path length, then creation (its default `sort`).
    pub fn get(&mut self, url: &Url) -> Vec<Cookie> {
        let (host, path) = context(url);
        let path = match path.is_empty() {
            true => "/".to_owned(),
            false => path,
        };
        let domains = permute(host);
        let now = js::now_ms();
        let matches = |cookie: &Cookie| {
            let (Some(domain), Some(cookie_path)) = (&cookie.domain, &cookie.path) else {
                return false;
            };
            domains.contains(&domain.as_str())
                && path_match(&path, cookie_path)
                && match cookie.host_only {
                    Some(true) => domain == host,
                    _ => domain_match(host, domain),
                }
        };
        self.cookies
            .retain(|cookie| !(matches(cookie) && cookie.expiry_time(now) <= now));
        let accessed = Time::At(js::now_ms());
        let mut found: Vec<Cookie> = self
            .cookies
            .iter_mut()
            .filter(|cookie| matches(cookie))
            .map(|cookie| {
                cookie.last_accessed = Some(accessed);
                cookie.clone()
            })
            .collect();
        found.sort_by(compare);
        found
    }

    /// `getCookieString(url)`.
    pub fn header(&mut self, url: &Url) -> String {
        self.get(url)
            .iter()
            .map(Cookie::pair)
            .collect::<Vec<_>>()
            .join("; ")
    }

    /// `JSON.stringify(await jar.serialize())`: every cookie's `toJSON` in creation order;
    /// `None` where tough-cookie throws on an invalid date.
    pub fn serialize(&self) -> Option<String> {
        let mut cookies: Vec<&Cookie> = self.cookies.iter().collect();
        cookies.sort_by_key(|cookie| cookie.index);
        let cookies = cookies
            .into_iter()
            .map(Cookie::to_json)
            .collect::<Option<Vec<_>>>()?;
        let options = &self.options;
        Some(
            json!({
                "version": "tough-cookie@6.0.2",
                "storeType": "MemoryCookieStore",
                "rejectPublicSuffixes": options.reject_public_suffixes,
                "enableLooseMode": options.loose_mode,
                "allowSpecialUseDomain": options.allow_special_use_domain,
                "prefixSecurity": options.prefix_security,
                "cookies": cookies,
            })
            .to_string(),
        )
    }

    /// `CookieJar.deserialize(text)`: `None` where it rejects (not JSON, or no cookies array).
    pub fn deserialize(text: &str) -> Option<Self> {
        let serialized = js::parse(text.as_bytes())?;
        let object = serialized.as_object()?;
        let flag = |name: &str| object.get(name).and_then(Value::as_bool);
        let prefix_security = match object
            .get("prefixSecurity")
            .and_then(Value::as_str)
            .map(str::to_lowercase)
            .as_deref()
        {
            Some(security @ ("strict" | "silent" | "unsafe-disabled")) => security.to_owned(),
            _ => "silent".to_owned(),
        };
        let mut jar = Jar {
            options: Options {
                reject_public_suffixes: flag("rejectPublicSuffixes").unwrap_or(true),
                loose_mode: flag("enableLooseMode").unwrap_or(false),
                allow_special_use_domain: flag("allowSpecialUseDomain").unwrap_or(true),
                prefix_security,
            },
            ..Jar::default()
        };

        for cookie in object.get("cookies")?.as_array()? {
            // `fromJSON` also reads a cookie given as JSON text.
            let parsed = match cookie {
                Value::String(text) => js::parse(text.as_bytes()),
                other => Some(other.clone()),
            };

            if let Some(Value::Object(object)) = parsed {
                jar.put(Cookie::from_json(&object));
            }
        }
        Some(jar)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn set_cookie_parsing_follows_tough_cookie() {
        let cookie = parse(" SESSION = a b ; Path=/x; Max-Age=600; HttpOnly; Secure; SameSite=LAX; Priority=High\nignored").unwrap();
        assert_eq!((cookie.key(), cookie.value()), ("SESSION", "a b"));
        assert_eq!(cookie.path.as_deref(), Some("/x"));
        assert_eq!(cookie.max_age, Some(MaxAge::Seconds(600.0)));
        assert!(cookie.http_only && cookie.secure);
        assert_eq!(cookie.same_site.as_deref(), Some("lax"));
        assert!(parse("=x").is_none());
        assert!(parse("novalue").is_none());
        assert_eq!(parse("a=b\rc; Path=/p").unwrap().value, "b");
    }

    #[test]
    fn refused_domains_are_errors_and_prefixes_are_dropped() {
        let origin = url("https://nam.inna.is");
        let mut jar = Jar::default();
        let set = |jar: &mut Jar, header: &str| jar.set(parse(header).unwrap(), &origin);

        assert_eq!(set(&mut jar, "SESSION=1; Path=/; Secure; HttpOnly"), Ok(()));
        assert_eq!(
            set(&mut jar, "XSRF-TOKEN=2; Domain=inna.is; Path=/"),
            Ok(())
        );
        assert_eq!(set(&mut jar, "SESSION=3; Domain=is"), Err(()));
        assert_eq!(set(&mut jar, "SESSION=4; Domain=example.com"), Err(()));
        assert_eq!(set(&mut jar, "__Host-x=5; Path=/"), Ok(()));
        assert_eq!(set(&mut jar, "JSESSIONID=6; Path=/api"), Ok(()));
        assert_eq!(
            jar.header(&url("https://nam.inna.is/api/UserData")),
            "JSESSIONID=6; SESSION=1; XSRF-TOKEN=2"
        );
        assert_eq!(jar.header(&origin), "SESSION=1; XSRF-TOKEN=2");
        let keys: Vec<String> = jar
            .get(&url("https://nam.inna.is/api/x"))
            .iter()
            .map(|cookie| cookie.key().to_owned())
            .collect();
        assert_eq!(keys, ["JSESSIONID", "SESSION", "XSRF-TOKEN"]);
    }

    #[test]
    fn a_saved_jar_round_trips_byte_for_byte() {
        // As tough-cookie 6.0.2 serializes a jar with two cookies.
        let saved = r#"{"version":"tough-cookie@6.0.2","storeType":"MemoryCookieStore","rejectPublicSuffixes":true,"enableLooseMode":false,"allowSpecialUseDomain":true,"prefixSecurity":"silent","cookies":[{"key":"SESSION","value":"s","expires":"2040-01-03T12:00:00.000Z","domain":"nam.inna.is","path":"/","secure":true,"httpOnly":true,"hostOnly":true,"creation":"2040-01-02T12:00:00.000Z","lastAccessed":"2040-01-02T12:00:00.000Z","sameSite":"lax"},{"key":"XSRF-TOKEN","value":"x","domain":"nam.inna.is","path":"/","secure":true,"hostOnly":true,"creation":"2040-01-02T12:00:00.000Z","lastAccessed":"2040-01-02T12:00:00.000Z"}]}"#;
        let jar = Jar::deserialize(saved).unwrap();
        assert_eq!(jar.serialize().unwrap(), saved);
        assert!(Jar::deserialize("{}").is_none());
        assert!(Jar::deserialize("[").is_none());
        let options = r#"{"prefixSecurity":"STRICT","rejectPublicSuffixes":false,"cookies":[]}"#;
        assert_eq!(
            Jar::deserialize(options).unwrap().serialize().unwrap(),
            r#"{"version":"tough-cookie@6.0.2","storeType":"MemoryCookieStore","rejectPublicSuffixes":false,"enableLooseMode":false,"allowSpecialUseDomain":true,"prefixSecurity":"strict","cookies":[]}"#
        );
    }
}
