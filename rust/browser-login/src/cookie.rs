//! tough-cookie 6's `Cookie.parse` (strict mode), `parseDate`, `pathMatch` and `defaultPath`: the
//! parts of its cookie handling that do not depend on a jar, a host or a stored format.

use crate::js;

/// `SameSite` as tough-cookie keeps it: lower case, and only the three values it recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    Strict,
    Lax,
    None,
}

impl SameSite {
    pub fn as_str(self) -> &'static str {
        match self {
            SameSite::Strict => "strict",
            SameSite::Lax => "lax",
            SameSite::None => "none",
        }
    }
}

/// One parsed `Set-Cookie` header. Empty `domain` and `path` are tough-cookie's `null`.
#[derive(Debug, Clone, PartialEq)]
pub struct SetCookie {
    pub key: String,
    pub value: String,
    /// Lower case, without a leading dot.
    pub domain: String,
    pub path: String,
    /// Epoch milliseconds.
    pub expires: Option<f64>,
    /// Seconds, as written: tough-cookie keeps any whole number, negative ones included.
    pub max_age: Option<f64>,
    pub secure: bool,
    pub http_only: bool,
    pub same_site: Option<SameSite>,
}

/// `Cookie.parse` of one `Set-Cookie` value (strict mode). `None` when tough-cookie returns
/// `undefined`.
pub fn parse_set_cookie(header: &str) -> Option<SetCookie> {
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
    let mut cookie = SetCookie {
        key: name.to_owned(),
        value: value.to_owned(),
        domain: String::new(),
        path: String::new(),
        expires: None,
        max_age: None,
        secure: false,
        http_only: false,
        same_site: None,
    };

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
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            "samesite" => {
                cookie.same_site = match value.map(str::to_lowercase).as_deref() {
                    Some("strict") => Some(SameSite::Strict),
                    Some("lax") => Some(SameSite::Lax),
                    Some("none") => Some(SameSite::None),
                    _ => None,
                };
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
pub fn parse_date(text: &str) -> Option<f64> {
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
pub fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let of_era = year - era * 400;
    let month = i64::from(month);
    let of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let of_era_days = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    era * 146_097 + of_era_days - 719_468
}

/// RFC 6265 path-match, as tough-cookie implements it.
pub fn path_match(request: &str, cookie: &str) -> bool {
    request == cookie
        || (request.starts_with(cookie)
            && (cookie.ends_with('/') || request[cookie.len()..].starts_with('/')))
}

/// tough-cookie's `defaultPath` for a request path.
pub fn default_path(path: &str) -> String {
    match path.rfind('/') {
        Some(0) | None => "/".to_owned(),
        Some(_) if !path.starts_with('/') => "/".to_owned(),
        Some(slash) => path[..slash].to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_cookie_parsing_follows_tough_cookie() {
        let cookie = parse_set_cookie(
            " id_token = a b ; SameSite=LAX; Path=/x; Max-Age=600; HttpOnly; Secure",
        )
        .unwrap();
        assert_eq!(
            (cookie.key.as_str(), cookie.value.as_str()),
            ("id_token", "a b")
        );
        assert_eq!((cookie.path.as_str(), cookie.max_age), ("/x", Some(600.0)));
        assert!(cookie.http_only && cookie.secure);
        assert_eq!(cookie.same_site, Some(SameSite::Lax));
        assert_eq!(parse_set_cookie("a=b; SameSite=x").unwrap().same_site, None);
        assert!(parse_set_cookie("=x").is_none());
        assert!(parse_set_cookie("novalue").is_none());
        assert!(parse_set_cookie("a=\u{1}").is_none());
        assert_eq!(parse_set_cookie("a=b\rc; Path=/p").unwrap().value, "b");
        assert_eq!(parse_set_cookie("a=b; Path=relative").unwrap().path, "");
        assert_eq!(parse_set_cookie("a=b; Max-Age=1.5").unwrap().max_age, None);
        assert_eq!(
            parse_set_cookie("a=b; Max-Age=-3").unwrap().max_age,
            Some(-3.0)
        );
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
    fn paths_match_and_default_as_in_tough_cookie() {
        assert!(path_match("/a/b", "/a"));
        assert!(path_match("/a/b", "/a/"));
        assert!(!path_match("/ab", "/a"));
        assert!(path_match("/a", "/a"));
        assert_eq!(default_path("/a/b"), "/a");
        assert_eq!(default_path("/a"), "/");
        assert_eq!(default_path(""), "/");
        assert_eq!(default_path("x/y"), "/");
    }
}
