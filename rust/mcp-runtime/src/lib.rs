//! The shared runtime of the native MCP servers, as packages/mcp-runtime/src/index.ts is for the
//! TypeScript ones: the safe error boundary, `toolResult`, the replayed tool surface and its
//! error texts, the stdio lifetime, bounded body reads and zod-compatible input validation.
//!
//! # The entry point
//!
//! The caller owns the Tokio runtime and its shutdown. Build it, `block_on` [`serve_stdio`],
//! which returns once the server's `close` has finished, then call
//! [`shutdown_background`](tokio::runtime::Runtime::shutdown_background). Tokio reads stdin on a
//! blocking thread that cannot be cancelled, and dropping a runtime waits for its blocking
//! threads, so with `#[tokio::main]` or a plain drop a process that got SIGINT or SIGTERM stays
//! alive for as long as the host holds stdin open. rust/abler-mcp/src/main.rs and
//! examples/stdio.rs follow this pattern; tests/signals.rs checks it.
//!
//! ```no_run
//! use mcp_runtime::{Cancelled, Fail, Server, Surface};
//! use rmcp::model::JsonObject;
//! use serde_json::{Value, json};
//!
//! struct Example(Surface);
//!
//! impl Server for Example {
//!     type Fail = Fail;
//!
//!     const NAME: &'static str = "example";
//!
//!     const VERSION: &'static str = "0.1.0";
//!
//!     fn surface(&self) -> &Surface {
//!         &self.0
//!     }
//!
//!     async fn call(
//!         &self,
//!         _name: &str,
//!         arguments: &JsonObject,
//!         _cancelled: Cancelled,
//!     ) -> Result<Result<Value, Fail>, String> {
//!         mcp_runtime::input::empty(arguments)?;
//!         Ok(Ok(json!({ "ok": true })))
//!     }
//! }
//!
//! fn main() -> std::io::Result<()> {
//!     let surface = Surface::parse(
//!         r#"{"instructions":"","tools":[{"name":"ping","inputSchema":{"type":"object"}}]}"#,
//!     );
//!     let runtime = tokio::runtime::Builder::new_current_thread()
//!         .enable_all()
//!         .build()?;
//!     let outcome = runtime.block_on(mcp_runtime::serve_stdio(Example(surface)));
//!     // close has finished; only the stdin reader may still block, so do not wait for it.
//!     runtime.shutdown_background();
//!     outcome
//! }
//! ```

mod body;
mod fail;
pub mod input;
mod server;
mod stdio;

pub use body::{BodyError, read_capped};
pub use fail::{Fail, Failure, UNKNOWN_ERROR, ZOD_ERROR, cli_text, tool_text};
pub use server::{
    Cancelled, Handler, Server, Surface, invalid_arguments, tool_result, unknown_tool,
};
pub use stdio::serve_stdio;
