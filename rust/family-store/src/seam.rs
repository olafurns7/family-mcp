/// Test seam only: with `FAMILY_MCP_STORE_TEST_SEAM=1` macOS honours absolute XDG directories like
/// Linux, so a test run keeps its store in scratch directories, and Time Machine exclusion runs
/// only through `FAMILY_MCP_STORE_TEST_TMUTIL`. Production never sets it, so the macOS store
/// cannot be moved into iCloud Drive, Desktop or Documents by an XDG variable.
pub const TEST_SEAM: &str = "FAMILY_MCP_STORE_TEST_SEAM";

/// Test seam only, honoured with the seam on: an absolute path to a fake tmutil to run instead.
pub const TEST_TMUTIL: &str = "FAMILY_MCP_STORE_TEST_TMUTIL";

/// Test seam only, honoured with the seam on: an absolute path to an ls for the ACL listing.
pub const TEST_LS: &str = "FAMILY_MCP_STORE_TEST_LS";

pub fn test_seam() -> bool {
    std::env::var_os(TEST_SEAM).is_some_and(|value| value == "1")
}
