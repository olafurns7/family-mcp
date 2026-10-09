//! The MCP surface of packages/kronan-mcp/src/server.ts. tools/list replays the TypeScript
//! server's advertised tools (src/surface.json, checked by a test), so names, descriptions,
//! schemas and annotations match exactly.

use std::sync::OnceLock;

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::error::{Fail, Result};

fn surface() -> &'static Surface {
    static SURFACE: OnceLock<Surface> = OnceLock::new();
    SURFACE.get_or_init(|| Surface::parse(include_str!("surface.json")))
}

pub struct Kronan;

impl Server for Kronan {
    type Fail = Fail;

    const NAME: &'static str = "kronan-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        surface()
    }

    async fn call(
        &self,
        _name: &str,
        _arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        Ok(Err(Fail::Unknown))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_surface_lists_every_tool_of_the_release_manifest() {
        let manifest: Value =
            serde_json::from_str(include_str!("../../../packages/kronan-mcp/package.json"))
                .unwrap();
        let names: Vec<&str> = surface()
            .tools
            .iter()
            .map(|tool| tool.name.as_ref())
            .collect();
        assert_eq!(
            names,
            manifest["familyMcp"]["release"]["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|name| name.as_str().unwrap())
                .collect::<Vec<_>>()
        );
        assert_eq!(names.len(), 41);
    }
}
