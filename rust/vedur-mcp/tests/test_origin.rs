//! tools.rs exists only with the `test-origin` feature, so without it a plain `cargo test` would
//! pass having checked no tool. This fails instead.

#[cfg(not(feature = "test-origin"))]
#[test]
fn the_tool_tests_require_the_test_origin_feature() {
    panic!("vedur-mcp's tests need the test-origin feature: run cargo test --all-features");
}
