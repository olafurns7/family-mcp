use crate::error::Fail;
use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

pub struct Dominos {
    surface: Surface,
    _origins: [String; 3],
}
impl Dominos {
    pub fn new() -> Self {
        Self {
            surface: Surface::parse(include_str!("surface.json")),
            _origins: crate::origin::origins(),
        }
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
        _name: &str,
        arguments: &JsonObject,
    ) -> std::result::Result<std::result::Result<Value, Fail>, String> {
        mcp_runtime::input::empty(arguments)?;
        Ok(Err(Fail::Safe(
            "The operation failed. Check the server logs for details.",
        )))
    }
}
