//! What a process that Cargo launches sees of the store: whether FAMILY_MCP_STORE_TEST_SEAM is in
//! its environment, whether the seam is on, and where the default record and key of `test-mcp`
//! are. tests/launch.rs runs it with `cargo run`. Paths only; nothing is opened or created.

fn main() {
    let record = family_store::default_secret_record_path("test-mcp").unwrap();
    let keys = family_store::default_key_provider("test-mcp", "default").unwrap();
    println!(
        "variable:{}",
        std::env::var_os(family_store::TEST_SEAM).is_some()
    );
    println!("seam:{}", family_store::test_seam());
    println!("record:{}", record.display());
    println!("key:{}", keys.key_file().unwrap().display());
}
