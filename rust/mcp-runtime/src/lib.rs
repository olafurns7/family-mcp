//! The shared runtime of the native MCP servers, as packages/mcp-runtime/src/index.ts is for the
//! TypeScript ones: the safe error boundary, `toolResult`, the replayed tool surface and its
//! error texts, the stdio lifetime, bounded body reads and zod-compatible input validation.

mod body;
mod fail;
pub mod input;
mod server;
mod stdio;

pub use body::{BodyError, read_capped};
pub use fail::{Fail, Failure, UNKNOWN_ERROR, ZOD_ERROR, cli_text, tool_text};
pub use server::{Handler, Server, Surface, invalid_arguments, tool_result, unknown_tool};
pub use stdio::serve_stdio;
