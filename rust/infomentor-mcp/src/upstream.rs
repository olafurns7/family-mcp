//! Where requests go: InfoMentor's own hosts, or, in a `test-origin` build, a local fake upstream.
//! Requests run on blocking threads (a client operation holds file locks across them) and wait
//! with `Handle::block_on`.

use std::future::Future;

use mcp_runtime::{BodyError, read_capped};
use reqwest::Method;
use reqwest::header::HeaderMap;
use tokio::runtime::Handle;
use url::Url;

use crate::signal::Signal;

/// INFOMENTOR_TEST_ORIGIN, the loopback origin that stands in for every InfoMentor host. A test
/// build needs one and refuses any other, so a test can never reach InfoMentor.
#[cfg(feature = "test-origin")]
pub fn test_origin() -> &'static str {
    static ORIGIN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    ORIGIN.get_or_init(|| {
        std::env::var("INFOMENTOR_TEST_ORIGIN")
            .ok()
            .filter(|origin| origin.starts_with("http://127.0.0.1:"))
            .expect("INFOMENTOR_TEST_ORIGIN must be local.")
    })
}

/// The address a request for `url` is sent to. A test build sends it to
/// `<INFOMENTOR_TEST_ORIGIN>/<host><path><query>`; cookies, redirects and checks still use `url`.
fn target(url: &Url) -> String {
    #[cfg(feature = "test-origin")]
    {
        let query = url
            .query()
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        format!(
            "{}/{}{}{query}",
            test_origin(),
            url.host_str().unwrap_or_default(),
            url.path()
        )
    }
    #[cfg(not(feature = "test-origin"))]
    {
        let mut url = url.clone();
        url.set_fragment(None);
        url.into()
    }
}

/// One HTTP client for the process, as `globalThis.fetch` is.
#[derive(Clone)]
pub struct Net {
    client: reqwest::Client,
    pub handle: Handle,
}

/// The parts of a response the request loop reads.
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    body: reqwest::Response,
}

impl Net {
    /// Never follows a redirect and never retries; proxies come from HTTP_PROXY, HTTPS_PROXY and
    /// NO_PROXY, as Bun's fetch reads them.
    pub fn new() -> Option<Self> {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .build()
            .ok()?;
        Some(Self {
            client,
            handle: Handle::try_current().ok()?,
        })
    }

    /// Wait for `future` from a blocking thread; `None` once `signal` aborts.
    pub fn wait<F: Future>(&self, signal: &Signal, future: F) -> Option<F::Output> {
        self.handle.block_on(signal.wait(future))
    }

    /// Send one request. `None` once `signal` aborts; `Some(None)` when it failed.
    pub fn send(
        &self,
        signal: &Signal,
        url: &Url,
        headers: HeaderMap,
        body: Option<String>,
    ) -> Option<Option<Response>> {
        let method = match body {
            Some(_) => Method::POST,
            None => Method::GET,
        };
        let mut request = self.client.request(method, target(url)).headers(headers);

        if let Some(body) = body {
            request = request.body(body);
        }
        let sent = self.wait(signal, request.send())?;
        Some(sent.ok().map(|response| Response {
            status: response.status().as_u16(),
            headers: response.headers().clone(),
            body: response,
        }))
    }

    /// Read a body of at most `max_bytes`. `None` once `signal` aborts.
    pub fn read(
        &self,
        signal: &Signal,
        response: Response,
        max_bytes: usize,
    ) -> Option<Result<Vec<u8>, BodyError>> {
        self.wait(signal, read_capped(response.body, max_bytes))
    }
}
