//! The smallest server on the documented entry point: one tool, `hang`, that waits until the
//! server closes. tests/signals.rs runs it to check that a signal ends the process while the
//! host still holds stdin open.

use mcp_runtime::{Fail, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::{Value, json};
use tokio::sync::Notify;

struct Hang {
    surface: Surface,
    closed: Notify,
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
    ) -> Result<Result<Value, Fail>, String> {
        mcp_runtime::input::empty(arguments)?;
        eprintln!("HANG");
        self.closed.notified().await;
        Ok(Ok(json!({})))
    }

    async fn close(&self) {
        self.closed.notify_waiters();
        eprintln!("CLOSE");
    }
}

fn main() {
    let surface = Surface::parse(
        r#"{"instructions":"","tools":[{"name":"hang","inputSchema":{"type":"object"}}]}"#,
    );
    let server = Hang {
        surface,
        closed: Notify::new(),
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
