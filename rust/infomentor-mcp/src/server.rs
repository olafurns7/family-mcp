//! The MCP surface of packages/infomentor-mcp/src/server.ts. tools/list replays the TypeScript
//! server's advertised tools (src/surface.json, generated with the setup tools and checked by a
//! test), so names, descriptions, schemas and annotations match exactly.

use std::sync::Arc;

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::client::Client;
use crate::error::{Fail, Result};
use crate::input;
use crate::signal::Signal;

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
    client: Arc<Client>,
}

impl InfoMentor {
    pub fn new(allow_setup_tools: bool, client: Client) -> Self {
        Self {
            surface: surface(allow_setup_tools),
            client: Arc::new(client),
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

    // The runtime passes no per-request cancellation; a call ends with the client's lifetime.
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        let client = &self.client;
        let signal = Signal::default();

        Ok(match name {
            "infomentor_session_status" => {
                input::empty(arguments)?;
                client.session_status(signal).await
            }
            "infomentor_get_overview" => {
                input::empty(arguments)?;
                client.overview(signal).await
            }
            "infomentor_select_child" => {
                let child_id = input::select_child(arguments)?;
                client.select_child(child_id, signal).await
            }
            "infomentor_get_messages" => {
                let request = input::messages(arguments)?;
                client.messages(request, signal).await
            }
            "infomentor_get_message" => {
                let id = input::message(arguments)?;
                client.message(id, signal).await
            }
            "infomentor_get_notifications" => {
                let request = input::notifications(arguments)?;
                client.notifications(request, signal).await
            }
            "infomentor_collect_updates" => {
                let request = input::collect(arguments)?;
                client.collect(request, signal).await
            }
            _ => Err(Fail::config(
                "This InfoMentor tool is not available in this build yet.",
            )),
        })
    }

    fn stdin_ended(&self) {
        self.client.abort();
    }

    async fn close(&self) {
        self.client.close().await;
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
