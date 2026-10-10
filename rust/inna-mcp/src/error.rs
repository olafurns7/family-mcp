//! How a failure crosses the MCP and terminal boundaries: the shared runtime's `SafeError`,
//! `ZodError` and anything else.

pub use mcp_runtime::Fail;

pub type Result<T> = std::result::Result<T, Fail>;
