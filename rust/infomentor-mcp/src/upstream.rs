//! Where requests go: InfoMentor's own hosts, or, in a `test-origin` build, a local fake upstream.

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
