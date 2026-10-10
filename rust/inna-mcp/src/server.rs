//! The MCP surface of packages/inna-mcp/src/server.ts. tools/list replays the TypeScript server's
//! advertised tools (src/surface.json, generated with absence writes allowed and checked by a
//! test), so names, descriptions, schemas and annotations match exactly. Without
//! `--allow-absence-writes` the two write tools are neither listed nor callable, as there.

use std::sync::OnceLock;

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::error::{Fail, Result};

/// The tools `createServer` registers only with `allowAbsenceWrites`.
const WRITE_TOOLS: [&str; 2] = ["inna_prepare_absence", "inna_submit_absence"];

fn surface(allow_absence_writes: bool) -> &'static Surface {
    static ALL: OnceLock<Surface> = OnceLock::new();
    static READ: OnceLock<Surface> = OnceLock::new();
    let all = ALL.get_or_init(|| Surface::parse(include_str!("surface.json")));

    if allow_absence_writes {
        return all;
    }
    READ.get_or_init(|| Surface {
        instructions: all.instructions.clone(),
        tools: all
            .tools
            .iter()
            .filter(|tool| !WRITE_TOOLS.contains(&tool.name.as_ref()))
            .cloned()
            .collect(),
    })
}

pub struct Inna {
    pub allow_absence_writes: bool,
}

impl Server for Inna {
    type Fail = Fail;

    const NAME: &'static str = "inna-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        surface(self.allow_absence_writes)
    }

    // The tools themselves arrive with the HTTP client; until then each call fails closed.
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
    fn write_tools_are_listed_only_when_allowed() {
        let names = |allowed| -> Vec<String> {
            surface(allowed)
                .tools
                .iter()
                .map(|tool| tool.name.to_string())
                .collect()
        };
        assert_eq!(names(true).len(), 16);
        assert_eq!(names(false).len(), 14);
        assert_eq!(names(true)[14..], WRITE_TOOLS);
        assert_eq!(names(true)[..14], names(false));
        assert_eq!(surface(true).instructions, surface(false).instructions);
    }
}
