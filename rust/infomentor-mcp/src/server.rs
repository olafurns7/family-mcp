//! The MCP surface of packages/infomentor-mcp/src/server.ts. tools/list replays the TypeScript
//! server's advertised tools (src/surface.json, generated with the setup tools and checked by a
//! test), so names, descriptions, schemas and annotations match exactly.

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::error::{Fail, Result};

/// The tools registered only with `--allow-setup-tools`: a prompt-injected agent must not be able
/// to log the parent out or replace the account.
const SETUP_TOOLS: [&str; 4] = [
    "infomentor_login",
    "infomentor_setup_status",
    "infomentor_cancel_setup",
    "infomentor_logout",
];

/// The TypeScript surface, without the setup tools unless they are allowed.
fn surface(allow_setup_tools: bool) -> Surface {
    let mut surface = Surface::parse(include_str!("surface.json"));

    if !allow_setup_tools {
        surface
            .tools
            .retain(|tool| !SETUP_TOOLS.contains(&tool.name.as_ref()));
    }
    surface
}

pub struct InfoMentor {
    surface: Surface,
}

impl InfoMentor {
    pub fn new(allow_setup_tools: bool) -> Self {
        Self {
            surface: surface(allow_setup_tools),
        }
    }
}

impl Server for InfoMentor {
    type Fail = Fail;

    const NAME: &'static str = "infomentor-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        &self.surface
    }

    async fn call(
        &self,
        _name: &str,
        _arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        Ok(Err(Fail::Safe(
            "This InfoMentor tool is not available in this build yet.",
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_tools_are_listed_only_when_allowed() {
        let names = |allowed| -> Vec<String> {
            surface(allowed)
                .tools
                .iter()
                .map(|tool| tool.name.to_string())
                .collect()
        };
        assert_eq!(
            names(false),
            [
                "infomentor_session_status",
                "infomentor_get_overview",
                "infomentor_select_child",
                "infomentor_get_messages",
                "infomentor_get_message",
                "infomentor_get_notifications",
                "infomentor_collect_updates",
            ]
        );
        assert_eq!(names(true).len(), 11);
        assert!(names(true).ends_with(&SETUP_TOOLS.map(String::from)));
    }
}
