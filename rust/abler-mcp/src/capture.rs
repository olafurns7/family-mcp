//! `auth capture`: read the Abler cookies of a signed-in tab from a loopback Chrome debugging
//! endpoint, as `captureCookies` in packages/abler-mcp/src/auth.ts does. Blocks.

use std::io::ErrorKind;
use std::net::TcpStream;
use std::time::{Duration, Instant};

use reqwest::Url;
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tungstenite::{Error as SocketError, Message};

use crate::api::ORIGIN;
use crate::error::{Fail, Result};
use crate::jar::{ImportError, Jar};
use crate::js;

const TIMEOUT: Duration = Duration::from_secs(10);

const NOT_LOOPBACK: Fail =
    Fail::Safe("Use a loopback Chrome debugging URL, such as http://127.0.0.1:9222.");

const NO_CONNECTION: Fail = Fail::Safe("Cannot connect to Chrome debugging.");

const INVALID_RESPONSE: Fail = Fail::Safe("Invalid Chrome debugging response.");

const UNEXPECTED_ADDRESS: Fail = Fail::Safe("Chrome returned an unexpected debugging address.");

fn has_credentials(url: &Url) -> bool {
    !url.username().is_empty() || url.password().is_some_and(|password| !password.is_empty())
}

/// The debugging endpoint, which must be plain HTTP on this machine.
fn loopback(endpoint: &str) -> Result<Url> {
    let url = Url::parse(endpoint).map_err(|_| NOT_LOOPBACK)?;

    if url.scheme() != "http"
        || !["localhost", "127.0.0.1", "[::1]"].contains(&url.host_str().unwrap_or_default())
        || has_credentials(&url)
    {
        return Err(NOT_LOOPBACK);
    }
    Ok(url)
}

/// The body of `/json/list`, fetched without following redirects.
fn list_tabs(list: Url) -> Result<Vec<u8>> {
    let http = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .build()
        .map_err(|_| Fail::Unknown)?;
    let handle = Handle::try_current().map_err(|_| Fail::Unknown)?;

    handle.block_on(async {
        let fetched = tokio::time::timeout(TIMEOUT, async {
            let response = http.get(list).send().await.map_err(|_| NO_CONNECTION)?;
            let status = response.status();

            // fetch's `redirect: 'error'` fails the request itself.
            if [301, 302, 303, 307, 308].contains(&status.as_u16()) {
                return Err(NO_CONNECTION);
            }

            if !status.is_success() {
                return Err(Fail::Safe("Cannot list Chrome debugging tabs."));
            }
            Ok(response
                .bytes()
                .await
                .map_err(|_| INVALID_RESPONSE)?
                .to_vec())
        })
        .await;
        fetched.unwrap_or(Err(NO_CONNECTION))
    })
}

/// The debugging socket of the first Abler tab, which must be on the endpoint itself.
fn abler_tab(body: &[u8], endpoint: &Url) -> Result<Url> {
    let pages = js::parse(body).ok_or(INVALID_RESPONSE)?;
    let pages: Vec<(&str, &str, Option<&str>)> = pages
        .as_array()
        .ok_or(INVALID_RESPONSE)?
        .iter()
        .map(|page| {
            Some((
                page.get("type")?.as_str()?,
                page.get("url")?.as_str()?,
                match page.as_object()?.get("webSocketDebuggerUrl") {
                    None => None,
                    Some(socket) => Some(socket.as_str()?),
                },
            ))
        })
        .collect::<Option<_>>()
        .ok_or(INVALID_RESPONSE)?;
    let socket = pages
        .into_iter()
        .find_map(|(kind, url, socket)| {
            socket.filter(|socket| {
                kind == "page" && url.starts_with(&format!("{ORIGIN}/")) && !socket.is_empty()
            })
        })
        .ok_or(Fail::Safe(
            "Open www.abler.io and sign in in that browser first.",
        ))?;
    let socket = Url::parse(socket).map_err(|_| UNEXPECTED_ADDRESS)?;

    if socket.scheme() != "ws"
        || (socket.host_str(), socket.port()) != (endpoint.host_str(), endpoint.port())
        || has_credentials(&socket)
    {
        return Err(UNEXPECTED_ADDRESS);
    }
    Ok(socket)
}

/// JavaScript truthiness of a JSON value.
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// The cookie list in the reply to request 1; `None` for any other message.
fn cookie_reply(message: &[u8]) -> Result<Option<Value>> {
    let message = js::parse(message).ok_or(INVALID_RESPONSE)?;
    let object = message.as_object().ok_or(INVALID_RESPONSE)?;
    let id = match object.get("id") {
        None => return Ok(None),
        Some(id) => id.as_f64().ok_or(INVALID_RESPONSE)?,
    };

    if id != 1.0 {
        return Ok(None);
    }
    let result = object
        .get("result")
        .filter(|result| result.is_array() || result.get("cookies").is_some_and(Value::is_array))
        .ok_or(INVALID_RESPONSE)?;

    if object.get("error").is_some_and(truthy) {
        return Err(Fail::Safe("Chrome rejected session capture."));
    }
    Ok(Some(result.clone()))
}

/// Ask the tab for Abler's cookies over its debugging socket, within `TIMEOUT` in all.
fn tab_cookies(socket: &Url) -> Result<Value> {
    let deadline = Instant::now() + TIMEOUT;
    let remaining = || {
        Some(deadline.saturating_duration_since(Instant::now()))
            .filter(|left| !left.is_zero())
            .ok_or(Fail::Safe("Chrome session capture timed out."))
    };
    // A step that fails once the time is up failed because of it.
    let failed = |fallback: Fail| remaining().err().unwrap_or(fallback);
    let stream = socket
        .socket_addrs(|| None)
        .unwrap_or_default()
        .iter()
        .find_map(|address| TcpStream::connect_timeout(address, remaining().ok()?).ok())
        .ok_or_else(|| failed(NO_CONNECTION))?;
    let bound = |stream: &TcpStream| -> Result<()> {
        let left = Some(remaining()?);
        stream
            .set_read_timeout(left)
            .and_then(|()| stream.set_write_timeout(left))
            .map_err(|_| NO_CONNECTION)
    };
    bound(&stream)?;
    let (mut socket, _) =
        tungstenite::client(socket.as_str(), stream).map_err(|_| failed(NO_CONNECTION))?;
    let command = json!({
        "id": 1,
        "method": "Network.getCookies",
        "params": { "urls": [format!("{ORIGIN}/oauth/token"), format!("{ORIGIN}/graphql")] },
    });
    socket
        .send(Message::text(command.to_string()))
        .map_err(|_| failed(NO_CONNECTION))?;

    let cookies = loop {
        bound(socket.get_ref())?;
        let reply = match socket.read() {
            Ok(Message::Text(text)) => cookie_reply(text.as_bytes())?,
            Ok(Message::Binary(bytes)) => cookie_reply(&bytes)?,
            Ok(Message::Close(_))
            | Err(
                SocketError::ConnectionClosed
                | SocketError::AlreadyClosed
                | SocketError::Protocol(_),
            ) => {
                return Err(Fail::Safe("Chrome debugging connection closed."));
            }
            Ok(_) => None,
            Err(SocketError::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                return Err(Fail::Safe("Chrome session capture timed out."));
            }
            Err(_) => return Err(NO_CONNECTION),
        };

        if let Some(cookies) = reply {
            break cookies;
        }
    };
    let _ = socket.close(None);
    Ok(cookies)
}

/// Attach to an existing Chromium page; the server itself never needs a browser.
pub fn capture_cookies(endpoint: &str) -> Result<Jar> {
    let endpoint = loopback(endpoint)?;
    let list = endpoint.join("/json/list").map_err(|_| NOT_LOOPBACK)?;
    let socket = abler_tab(&list_tabs(list)?, &endpoint)?;

    Jar::import(&tab_cookies(&socket)?).map_err(|error| match error {
        ImportError::Cookie => Fail::Safe("Invalid Abler authentication cookie."),
        ImportError::NoRefresh => Fail::Safe(
            "No unexpired Abler refreshToken cookie found. Sign in again and capture/import the session.",
        ),
        ImportError::Input => Fail::Unknown,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_loopback_endpoints_are_accepted() {
        for endpoint in [
            "http://127.0.0.1:9222",
            "http://localhost:9222/",
            "http://LOCALHOST",
            "http://[::1]:9222",
            "http://127.1:9222",
        ] {
            assert!(loopback(endpoint).is_ok(), "{endpoint}");
        }

        for endpoint in [
            "https://example.com",
            "https://127.0.0.1:9222",
            "ws://127.0.0.1:9222",
            "http://192.168.1.2:9222",
            "http://127.0.0.2:9222",
            "http://user@127.0.0.1:9222",
            "http://:secret@127.0.0.1:9222",
            "http://localhost.example:9222",
            "127.0.0.1:9222",
            "",
        ] {
            assert_eq!(loopback(endpoint), Err(NOT_LOOPBACK), "{endpoint}");
        }
    }

    #[test]
    fn the_tab_must_be_ablers_and_its_socket_on_the_endpoint() {
        let endpoint = loopback("http://127.0.0.1:9222").unwrap();
        let tab = |body: &str| abler_tab(body.as_bytes(), &endpoint).map(String::from);
        let pages = |socket: &str| {
            format!(
                r#"[{{"type":"page","url":"https://unrelated.example","webSocketDebuggerUrl":"ws://unrelated.example"}},
                {{"type":"worker","url":"https://www.abler.io/w","webSocketDebuggerUrl":"ws://127.0.0.1:9222/w"}},
                {{"type":"page","url":"https://www.abler.io/coach","webSocketDebuggerUrl":"{socket}"}}]"#
            )
        };
        assert_eq!(
            tab(&pages("ws://127.0.0.1:9222/devtools/page/1")).as_deref(),
            Ok("ws://127.0.0.1:9222/devtools/page/1")
        );

        for elsewhere in [
            "ws://127.0.0.1:9223/devtools/page/1",
            "ws://example.com:9222/devtools/page/1",
            "wss://127.0.0.1:9222/devtools/page/1",
            "ws://user@127.0.0.1:9222/devtools/page/1",
            "not a url",
        ] {
            assert_eq!(
                tab(&pages(elsewhere)),
                Err(UNEXPECTED_ADDRESS),
                "{elsewhere}"
            );
        }
        let no_tab = Fail::Safe("Open www.abler.io and sign in in that browser first.");
        assert_eq!(tab("[]"), Err(no_tab));
        assert_eq!(
            tab(r#"[{"type":"page","url":"https://www.abler.io.evil/"}]"#),
            Err(no_tab)
        );
        assert_eq!(tab(&pages("")), Err(no_tab));

        for invalid in [
            "{}",
            "nope",
            r#"[{"type":"page"}]"#,
            r#"[{"type":"page","url":"u","webSocketDebuggerUrl":null}]"#,
        ] {
            assert_eq!(tab(invalid), Err(INVALID_RESPONSE), "{invalid}");
        }
    }

    #[test]
    fn only_the_reply_to_the_cookie_request_is_read() {
        let reply = |message: &str| cookie_reply(message.as_bytes());
        assert_eq!(reply(r#"{"method":"Network.x","params":{}}"#), Ok(None));
        assert_eq!(reply(r#"{"id":2,"result":{}}"#), Ok(None));
        assert_eq!(
            reply(r#"{"id":1,"result":{"cookies":[]}}"#),
            Ok(Some(json!({ "cookies": [] })))
        );
        assert_eq!(
            reply(r#"{"id":1,"result":[],"error":null}"#),
            Ok(Some(json!([])))
        );
        assert_eq!(
            reply(r#"{"id":1,"result":{"cookies":[]},"error":{"code":1}}"#),
            Err(Fail::Safe("Chrome rejected session capture."))
        );

        for invalid in [
            r#"{"id":1,"error":{"code":1}}"#,
            r#"{"id":1,"result":{}}"#,
            r#"{"id":"1"}"#,
            "[]",
            "x",
        ] {
            assert_eq!(reply(invalid), Err(INVALID_RESPONSE), "{invalid}");
        }
    }
}
