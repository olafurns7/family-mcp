//! The smallest server on the documented entry point: one tool, `hang`, that waits until the
//! call is cancelled, and a `close` that waits for calls in flight. tests/signals.rs runs it to
//! check when a call is cancelled and that a signal ends the process while the host still holds
//! stdin open.

use mcp_runtime::{Cancelled, Fail, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::{Value, json};
use tokio::sync::RwLock;

struct Hang {
    surface: Surface,
    running: RwLock<()>,
}

impl Server for Hang {
    type Fail = Fail;

    const NAME: &'static str = "stdio-example";

    const VERSION: &'static str = "0.0.0";

    fn surface(&self) -> &Surface {
        &self.surface
    }

    async fn call(
        &self,
        _name: &str,
        arguments: &JsonObject,
        cancelled: Cancelled,
    ) -> Result<Result<Value, Fail>, String> {
        mcp_runtime::input::empty(arguments)?;
        let _running = self.running.read().await;
        eprintln!("HANG");
        cancelled.await;
        eprintln!("CANCELLED");
        Ok(Ok(json!({})))
    }

    async fn close(&self) {
        let _ = self.running.write().await;
        eprintln!("CLOSE");
    }
}

fn main() {
    let surface = Surface::parse(
        r#"{"instructions":"","tools":[{"name":"hang","inputSchema":{"type":"object"}}]}"#,
    );
    let server = Hang {
        surface,
        running: RwLock::new(()),
    };
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let outcome = runtime.block_on(mcp_runtime::serve_stdio(server));
    // serve_stdio has waited for close; only the stdin reader may still block.
    runtime.shutdown_background();
    outcome.unwrap();
}
