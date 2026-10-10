#[cfg(not(feature = "test-origin"))]
pub const API: &str = "https://api.dominos.is/api/";
#[cfg(not(feature = "test-origin"))]
pub const WEBSITE: &str = "https://www.dominos.is";
#[cfg(not(feature = "test-origin"))]
pub const ADYEN: &str = "https://checkoutshopper-live.adyen.com";

#[cfg(feature = "test-origin")]
fn local_origin(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    (url.scheme() == "http"
        && url.host_str() == Some("127.0.0.1")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_some()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none())
    .then(|| format!("http://127.0.0.1:{}", url.port().unwrap_or_default()))
}

pub fn origins() -> [String; 3] {
    #[cfg(feature = "test-origin")]
    {
        let origin =
            std::env::var("DOMINOS_TEST_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:9".into());
        let origin = local_origin(&origin).expect("DOMINOS_TEST_ORIGIN must be local.");
        [
            format!("{origin}/api/"),
            format!("{origin}/website"),
            format!("{origin}/adyen"),
        ]
    }
    #[cfg(not(feature = "test-origin"))]
    {
        [API.into(), WEBSITE.into(), ADYEN.into()]
    }
}

#[cfg(all(test, feature = "test-origin"))]
mod tests {
    use super::*;
    #[test]
    fn only_a_loopback_origin_with_a_port_is_accepted() {
        assert_eq!(
            local_origin("http://127.0.0.1:1234/"),
            Some("http://127.0.0.1:1234".into())
        );
        for value in [
            "http://127.0.0.1:1@example.invalid",
            "http://127.0.0.1:1/x",
            "http://127.0.0.1",
            "https://127.0.0.1:1",
            "http://localhost:1",
            "http://127.0.0.1:1/?q=x",
            "http://127.0.0.1:1/#x",
        ] {
            assert_eq!(local_origin(value), None, "{value}");
        }
    }
}
