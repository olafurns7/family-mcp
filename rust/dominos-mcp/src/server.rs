use crate::{
    client::Client,
    error::{Fail, Result},
    input,
};
use mcp_runtime::{Cancelled, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;
use std::sync::Arc;

pub struct Dominos {
    surface: Surface,
    client: Arc<Client>,
}
impl Dominos {
    pub fn new() -> Result<Self> {
        Ok(Self {
            surface: Surface::parse(include_str!("surface.json")),
            client: Arc::new(Client::new()?),
        })
    }
}
impl Server for Dominos {
    type Fail = Fail;
    const NAME: &'static str = "dominos-mcp";
    const VERSION: &'static str = env!("CARGO_PKG_VERSION");
    fn surface(&self) -> &Surface {
        &self.surface
    }
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
        _cancelled: Cancelled,
    ) -> std::result::Result<std::result::Result<Value, Fail>, String> {
        let input = input::parse(name, arguments)?;
        // packages/dominos-mcp/src/server.ts uses only the client's lifecycle signal, not host cancel.
        Ok(self.client.run(name.to_owned(), input).await)
    }
    fn stdin_ended(&self) {
        self.client.abort();
    }
    async fn close(&self) {
        self.client.close().await;
    }
}
