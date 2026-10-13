//! The one HTTP client: GET only, bounded bodies, a small retry for server errors and timeouts,
//! and a short in-memory cache of successful responses. Failures are never cached.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Utc};
use reqwest::StatusCode;
use reqwest::header::{ACCEPT, CACHE_CONTROL, HeaderMap};
use tokio::time::Instant;

pub const WEATHER_API: &str = "https://api.vedur.is/weather";

pub const CAP_API: &str = "https://api.vedur.is/cap";

pub const GOTTVEDUR: &str = "https://gottvedur.is";

const USER_AGENT: &str = concat!(
    "vedur-mcp/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/olafurns7/family-mcp)"
);

/// Per attempt; three attempts and the backoff stay well inside a host's tool-call timeout.
#[cfg(not(feature = "test-origin"))]
fn attempt_timeout() -> Duration {
    Duration::from_secs(10)
}

/// Tests shorten the attempt timeout with `VEDUR_TEST_ATTEMPT_TIMEOUT_MS`.
#[cfg(feature = "test-origin")]
fn attempt_timeout() -> Duration {
    let millis = std::env::var("VEDUR_TEST_ATTEMPT_TIMEOUT_MS")
        .ok()
        .and_then(|millis| millis.parse().ok())
        .unwrap_or(10_000);
    Duration::from_millis(millis)
}

/// The current time, for `fetched_at` and warning status.
#[cfg(not(feature = "test-origin"))]
pub fn now() -> DateTime<Utc> {
    Utc::now()
}

/// Tests fix the clock with `VEDUR_TEST_NOW` (RFC 3339), so recorded warnings keep their status.
#[cfg(feature = "test-origin")]
pub fn now() -> DateTime<Utc> {
    std::env::var("VEDUR_TEST_NOW")
        .ok()
        .and_then(|now| DateTime::parse_from_rfc3339(&now).ok())
        .map_or_else(Utc::now, |now| now.with_timezone(&Utc))
}

const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);

/// The waits before the second and third attempt.
const BACKOFF: [Duration; 2] = [Duration::from_millis(300), Duration::from_millis(900)];

/// The shortest cache lifetime. A longer upstream `max-age` is honoured up to [`MAX_TTL`].
pub const MIN_TTL: Duration = Duration::from_secs(60);

const MAX_TTL: Duration = Duration::from_secs(600);

const MAX_ENTRIES: usize = 64;

/// Why a GET produced no usable body. None of these carry upstream text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchError {
    /// Connection failure, timeout or a server error, after the retries.
    Unavailable,
    /// A 4xx answer; never retried.
    Refused(u16),
    /// A redirect or another status the APIs do not use.
    Unexpected,
    /// The body exceeded its cap.
    TooLarge,
}

/// A response body and when it was read from upstream.
#[derive(Debug, Clone)]
pub struct Fetched {
    pub body: Arc<Vec<u8>>,
    pub fetched_at: DateTime<Utc>,
    pub cached: bool,
}

struct Entry {
    body: Arc<Vec<u8>>,
    fetched_at: DateTime<Utc>,
    expires: Instant,
}

pub struct Http {
    client: reqwest::Client,
    cache: Mutex<HashMap<String, Entry>>,
    #[cfg(feature = "test-origin")]
    origin: String,
}

/// `max-age` from a Cache-Control header, if any.
fn max_age(headers: &HeaderMap) -> Option<Duration> {
    let value = headers.get(CACHE_CONTROL)?.to_str().ok()?;
    value.split(',').find_map(|directive| {
        let seconds = directive.trim().strip_prefix("max-age=")?;
        seconds.parse().ok().map(Duration::from_secs)
    })
}

/// How long a response stays cached: at least [`MIN_TTL`], at most [`MAX_TTL`].
pub fn ttl(headers: &HeaderMap) -> Duration {
    max_age(headers).unwrap_or(MIN_TTL).clamp(MIN_TTL, MAX_TTL)
}

enum Attempt {
    Done(Result<(Vec<u8>, Duration), FetchError>),
    Retry,
}

impl Http {
    pub fn new() -> reqwest::Result<Self> {
        let builder = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .timeout(attempt_timeout())
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never());
        #[cfg(feature = "test-origin")]
        let builder = builder.no_proxy();

        Ok(Self {
            client: builder.build()?,
            cache: Mutex::new(HashMap::new()),
            #[cfg(feature = "test-origin")]
            origin: test_origin(),
        })
    }

    /// The URL actually requested for a public URL: itself, or the loopback fake in tests.
    fn target(&self, url: &str) -> String {
        #[cfg(feature = "test-origin")]
        {
            for host in ["https://api.vedur.is/", "https://gottvedur.is/"] {
                if let Some(rest) = url.strip_prefix(host) {
                    let name = &host["https://".len()..host.len() - 1];
                    return format!("{}/{name}/{rest}", self.origin);
                }
            }
        }
        url.to_owned()
    }

    fn cached(&self, url: &str) -> Option<Fetched> {
        let cache = self.cache.lock().ok()?;
        let entry = cache.get(url)?;
        (entry.expires > Instant::now()).then(|| Fetched {
            body: entry.body.clone(),
            fetched_at: entry.fetched_at,
            cached: true,
        })
    }

    fn store(&self, url: &str, body: Arc<Vec<u8>>, fetched_at: DateTime<Utc>, ttl: Duration) {
        let Ok(mut cache) = self.cache.lock() else {
            return;
        };
        let now = Instant::now();
        cache.retain(|_, entry| entry.expires > now);

        if cache.len() >= MAX_ENTRIES
            && let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, entry)| entry.expires)
                .map(|(key, _)| key.clone())
        {
            cache.remove(&oldest);
        }
        cache.insert(
            url.to_owned(),
            Entry {
                body,
                fetched_at,
                expires: now + ttl,
            },
        );
    }

    async fn attempt(&self, target: &str, accept: &str, max_bytes: usize) -> Attempt {
        let response = match self.client.get(target).header(ACCEPT, accept).send().await {
            Ok(response) => response,
            Err(_) => return Attempt::Retry,
        };
        let status = response.status();

        if status.is_server_error() {
            return Attempt::Retry;
        }

        if status.is_client_error() {
            return Attempt::Done(Err(FetchError::Refused(status.as_u16())));
        }

        if status != StatusCode::OK {
            return Attempt::Done(Err(FetchError::Unexpected));
        }
        let ttl = ttl(response.headers());

        match mcp_runtime::read_capped(response, max_bytes).await {
            Ok(body) => Attempt::Done(Ok((body, ttl))),
            Err(mcp_runtime::BodyError::TooLarge) => Attempt::Done(Err(FetchError::TooLarge)),
            Err(mcp_runtime::BodyError::Failed) => Attempt::Retry,
        }
    }

    /// GET `url` (a public https URL), from the cache when fresh.
    pub async fn get(
        &self,
        url: &str,
        accept: &str,
        max_bytes: usize,
    ) -> Result<Fetched, FetchError> {
        if let Some(fetched) = self.cached(url) {
            return Ok(fetched);
        }
        let target = self.target(url);

        for wait in std::iter::once(None).chain(BACKOFF.map(Some)) {
            if let Some(wait) = wait {
                tokio::time::sleep(wait).await;
            }

            match self.attempt(&target, accept, max_bytes).await {
                Attempt::Retry => continue,
                Attempt::Done(Err(error)) => return Err(error),
                Attempt::Done(Ok((body, ttl))) => {
                    let body = Arc::new(body);
                    let fetched_at = now();
                    self.store(url, body.clone(), fetched_at, ttl);
                    return Ok(Fetched {
                        body,
                        fetched_at,
                        cached: false,
                    });
                }
            }
        }
        Err(FetchError::Unavailable)
    }
}

#[cfg(feature = "test-origin")]
fn test_origin() -> String {
    let origin =
        std::env::var("VEDUR_TEST_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:9".to_owned());
    local_origin(&origin).expect("VEDUR_TEST_ORIGIN must be a loopback origin with a port.")
}

/// `http://127.0.0.1:<port>` and nothing else.
#[cfg(feature = "test-origin")]
fn local_origin(value: &str) -> Option<String> {
    let rest = value.strip_prefix("http://127.0.0.1:")?;
    let port = rest.strip_suffix('/').unwrap_or(rest);
    let port: u16 = port.parse().ok().filter(|port| *port > 0)?;
    Some(format!("http://127.0.0.1:{port}"))
}

#[cfg(test)]
mod tests {
    use reqwest::header::HeaderValue;

    use super::*;

    fn headers(cache_control: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CACHE_CONTROL, HeaderValue::from_str(cache_control).unwrap());
        headers
    }

    #[test]
    fn the_cache_lifetime_is_at_least_a_minute_and_honours_longer_max_ages() {
        assert_eq!(ttl(&HeaderMap::new()), MIN_TTL);
        assert_eq!(ttl(&headers("public, max-age=10, s-maxage=10")), MIN_TTL);
        assert_eq!(
            ttl(&headers("public, max-age=120")),
            Duration::from_secs(120)
        );
        assert_eq!(ttl(&headers("max-age=86400")), MAX_TTL);
        assert_eq!(ttl(&headers("no-store")), MIN_TTL);
    }

    #[tokio::test]
    async fn fresh_entries_are_served_and_expired_ones_are_not() {
        let http = Http::new().unwrap();
        let at = Utc::now();
        http.store("u", Arc::new(b"x".to_vec()), at, MIN_TTL);
        let hit = http.cached("u").unwrap();
        assert!(hit.cached);
        assert_eq!(hit.fetched_at, at);
        assert_eq!(hit.body.as_slice(), b"x");

        http.store("old", Arc::new(Vec::new()), at, Duration::ZERO);
        assert!(http.cached("old").is_none());
        assert!(http.cached("missing").is_none());
    }

    #[tokio::test]
    async fn the_cache_stays_bounded() {
        let http = Http::new().unwrap();

        for index in 0..MAX_ENTRIES * 2 {
            http.store(
                &index.to_string(),
                Arc::new(Vec::new()),
                Utc::now(),
                MIN_TTL,
            );
        }
        assert_eq!(http.cache.lock().unwrap().len(), MAX_ENTRIES);
    }

    #[cfg(feature = "test-origin")]
    #[test]
    fn only_a_loopback_origin_with_a_port_is_accepted() {
        assert_eq!(
            local_origin("http://127.0.0.1:1234/"),
            Some("http://127.0.0.1:1234".to_owned())
        );

        for value in [
            "http://127.0.0.1:1@example.invalid",
            "http://127.0.0.1:1/x",
            "http://127.0.0.1",
            "https://127.0.0.1:1",
            "http://localhost:1",
            "http://127.0.0.1:0",
        ] {
            assert_eq!(local_origin(value), None, "{value}");
        }
    }
}
