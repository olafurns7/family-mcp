//! parity.rs and cli.rs exist only with the `test-origin` feature, so without it a plain
//! `cargo test` would pass having compared nothing. This fails instead.

#[cfg(not(feature = "test-origin"))]
#[test]
fn the_parity_and_cli_tests_require_the_test_origin_feature() {
    panic!("kronan-mcp's tests need the test-origin feature: run cargo test --all-features");
}
