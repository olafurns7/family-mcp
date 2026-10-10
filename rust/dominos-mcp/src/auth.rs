use crate::client::{Client, INVALID_RESPONSE};
use crate::error::{Fail, Result};
use crate::{js, store};
use reqwest::Method;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};

pub fn phone_number(value: &str) -> Result<String> {
    let digits: String = value
        .chars()
        .filter(|c| !js::is_space(*c) && !matches!(c, '+' | '-'))
        .collect();
    let normalized = if digits.len() == 7 {
        format!("354{digits}")
    } else {
        digits
    };
    if normalized.len() != 10
        || !normalized.starts_with("354")
        || !normalized.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(Fail::Safe(
            "Use a seven-digit Icelandic phone number, optionally prefixed with +354.",
        ));
    }
    Ok(normalized)
}
fn token_response(value: &Value) -> Option<store::Session> {
    let access = value["access_token"]
        .as_str()
        .filter(|s| store::valid_token(s))?;
    let refresh = value["refresh_token"]
        .as_str()
        .filter(|s| store::valid_token(s))?;
    let username = value["username"]
        .as_str()
        .filter(|s| (1..=256).contains(&s.chars().count()))?;
    let expires = value["expires_in"]
        .as_f64()
        .filter(|n| n.fract() == 0.0 && *n > 0.0 && *n <= 9_007_199_254_740_991.0)?;
    value["token_type"]
        .as_str()
        .filter(|s| s.eq_ignore_ascii_case("bearer"))?;
    Some(
        json!({"version":1,"accessToken":access,"refreshToken":refresh,"username":username,"expiresAt":js::number(js::now() as f64+expires*1000.0)}),
    )
}
pub fn exchange(client: &Client, body: String) -> Result<store::Session> {
    let mut headers = HeaderMap::new();
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    match client.text(&client.api_url("token"), Method::POST, headers, Some(body)) {
        Ok(text) => js::parse(text.as_bytes())
            .and_then(|value| token_response(&value))
            .ok_or(Fail::Safe(INVALID_RESPONSE)),
        Err(Fail::Http(429)) => Err(Fail::Safe(
            "Domino’s is rate limiting sign-in. Wait before requesting another code.",
        )),
        Err(Fail::Http(_)) => Err(Fail::Safe(
            "Domino’s rejected the sign-in code or refresh token. Sign in again.",
        )),
        Err(other) => Err(other),
    }
}
pub fn request_code(client: &Client, phone: &str) -> Result<()> {
    client
        .text(
            &client.api_url(&format!(
                "login/sendPin?phoneNumber={}",
                phone_number(phone)?
            )),
            Method::POST,
            HeaderMap::new(),
            None,
        )
        .map(|_| ())
}
pub fn login(client: &Client, phone: &str, pin: &str) -> Result<bool> {
    if pin.len() != 6 || !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Err(Fail::Safe("The SMS code must contain six digits."));
    }
    store::save_login(|| {
        let value = exchange(
            client,
            format!(
                "grant_type=password&username={}&password={pin}&authentication_type=sms",
                phone_number(phone)?
            ),
        )?;
        let mut headers = HeaderMap::new();
        headers.insert(
            "authorization",
            HeaderValue::from_str(&format!(
                "bearer {}",
                value["accessToken"].as_str().unwrap_or_default()
            ))
            .map_err(|_| Fail::Unknown)?,
        );
        let text = client.text(&client.api_url("user/newuser"), Method::GET, headers, None)?;
        let verified = js::parse(text.as_bytes()).ok_or(Fail::Safe(INVALID_RESPONSE))?;
        if !matches!(&verified["id"], Value::String(_) | Value::Number(_)) {
            return Err(Fail::Safe(INVALID_RESPONSE));
        }
        Ok(value)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn phone_and_token_values_match_the_reference_bounds() {
        for input in ["5550123", "+354 555-0123", "\u{feff}3545550123\u{2028}"] {
            assert_eq!(phone_number(input).unwrap(), "3545550123");
        }
        for input in [
            "",
            "https://example.invalid",
            "123456",
            "3555550123",
            "5550123\u{85}",
        ] {
            assert!(phone_number(input).is_err());
        }
        let value = json!({"access_token":"a","refresh_token":"r","username":"u","token_type":"BEARER","expires_in":1});
        assert!(token_response(&value).is_some());
        for (key, invalid) in [
            ("access_token", json!(" ")),
            ("refresh_token", json!("x".repeat(32769))),
            ("username", json!("x".repeat(257))),
            ("expires_in", json!(1.5)),
            ("token_type", json!("basic")),
        ] {
            let mut bad = value.clone();
            bad[key] = invalid;
            assert!(token_response(&bad).is_none());
        }
    }
}
