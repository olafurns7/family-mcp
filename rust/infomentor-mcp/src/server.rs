//! The MCP surface of packages/infomentor-mcp/src/server.ts. tools/list replays the TypeScript
//! server's advertised tools (src/surface.json, generated with the setup tools and checked by a
//! test). Native-only absence tools are appended separately, and only on explicit opt-in.

use std::sync::Arc;

use mcp_runtime::{Cancelled, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::{Value, json};

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
fn surface(allow_setup_tools: bool, allow_absence_writes: bool) -> Surface {
    let mut surface = Surface::parse(include_str!("surface.json"));

    if !allow_setup_tools {
        surface
            .tools
            .retain(|tool| !SETUP_TOOLS.contains(&tool.name.as_ref()));
    }
    if allow_absence_writes {
        surface
            .tools
            .extend(Surface::parse(include_str!("absence-surface.json")).tools);
        surface.instructions = surface.instructions.replace("School records are read-only.", "School records are read-only except the explicitly enabled whole-day sickness prepare/submit tools. Show the preview and obtain human approval before submitting. Unknown writes must never be retried or bypassed.");
    }
    surface
}

pub struct InfoMentor {
    surface: Surface,
    client: Arc<Client>,
}

impl InfoMentor {
    pub fn new(allow_setup_tools: bool, allow_absence_writes: bool, client: Client) -> Self {
        Self {
            surface: surface(allow_setup_tools, allow_absence_writes),
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

    // A host's cancel is not passed on, though the TypeScript tools abort on theirs: a call ends
    // with the client's lifetime.
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
        _cancelled: Cancelled,
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
            "infomentor_prepare_absence" => {
                let (child, date) = input::absence_prepare(arguments)?;
                client.prepare_absence(child, date, signal).await
            }
            "infomentor_submit_absence" => {
                let operation = input::absence_submit(arguments)?;
                client.submit_absence(operation, signal).await
            }
            "infomentor_login" => {
                let request = input::login(arguments)?;
                client.start_login(request)
            }
            "infomentor_setup_status" => {
                input::empty(arguments)?;
                Ok(client.setup_status())
            }
            "infomentor_cancel_setup" => {
                input::empty(arguments)?;
                Ok(client.cancel_setup().await)
            }
            "infomentor_logout" => {
                input::empty(arguments)?;
                client.logout().await.map(|()| {
                    json!({"authenticated": false, "nextStep": "Call infomentor_login to sign in again."})
                })
            }
            // The runtime lists and accepts only the surface's tools.
            _ => Err(Fail::Unknown),
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
            surface(allowed, false)
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
    #[test]
    fn absence_writes_are_independent_of_setup_and_never_read_only() {
        for setup in [false, true] {
            let disabled = surface(setup, false);
            assert!(!disabled.has_tool("infomentor_prepare_absence"));
            assert!(!disabled.has_tool("infomentor_submit_absence"));
            let enabled = surface(setup, true);
            assert_eq!(enabled.tools.len(), disabled.tools.len() + 2);
            assert_eq!(enabled.has_tool("infomentor_logout"), setup);
            assert!(enabled.instructions.contains("obtain human approval"));
            for name in ["infomentor_prepare_absence", "infomentor_submit_absence"] {
                let tool = enabled.tools.iter().find(|tool| tool.name == name).unwrap();
                assert_eq!(
                    tool.annotations.as_ref().unwrap().read_only_hint,
                    Some(false)
                );
            }
        }
    }
}
