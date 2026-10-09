//! The MCP surface of packages/abler-mcp/src/server.ts. tools/list replays the TypeScript server's
//! advertised tools (src/surface.json, checked by a test), so names, descriptions, schemas and
//! annotations match exactly; inputs are validated with zod's rules and messages (input.rs).

use std::sync::{Arc, OnceLock};

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
    JsonObject, ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData, RoleServer, ServerHandler};
use serde_json::Value;

use crate::api::{self, Client};
use crate::error::Result;
use crate::input;

struct Surface {
    instructions: String,
    tools: Vec<Tool>,
}

fn surface() -> &'static Surface {
    static SURFACE: OnceLock<Surface> = OnceLock::new();
    SURFACE.get_or_init(|| {
        let mut surface: Value =
            serde_json::from_str(include_str!("surface.json")).expect("surface.json is JSON");
        Surface {
            instructions: surface["instructions"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            tools: serde_json::from_value(surface["tools"].take()).expect("surface.json has tools"),
        }
    })
}

pub struct Abler {
    pub client: Arc<Client>,
}

/// `toolResult`: the output as JSON text and structured content, or a fixed error text.
fn tool_result(output: Result<Value>) -> CallToolResult {
    match output {
        Ok(output) => {
            let mut result = CallToolResult::structured(output);
            result.is_error = None;
            result
        }
        Err(fail) => CallToolResult::error(vec![ContentBlock::text(fail.tool_text())]),
    }
}

impl Abler {
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        let client = &self.client;

        Ok(match name {
            "auth_status" => {
                input::empty(arguments)?;
                client
                    .run(|client| client.status(api::status_forces_refresh()))
                    .await
            }
            "get_profile" => {
                input::empty(arguments)?;
                client.run(Client::profile).await
            }
            "list_groups" => {
                input::empty(arguments)?;
                client.run(Client::groups).await
            }
            "list_schedule" => {
                let filters = input::schedule(arguments)?;
                client.run(|client| client.schedule(filters)).await
            }
            "list_child_schedules" => {
                let filters = input::child_schedules(arguments)?;
                client.run(|client| client.child_schedules(filters)).await
            }
            "get_event" => {
                let event = input::event(arguments)?;
                client.run(|client| client.event(event)).await
            }
            "list_conversations" => {
                let page = input::conversations(arguments)?;
                client.run(|client| client.conversations(page)).await
            }
            "list_messages" => {
                let messages = input::messages(arguments)?;
                client.run(|client| client.messages(messages)).await
            }
            _ => unreachable!("only listed tools are called"),
        })
    }
}

impl ServerHandler for Abler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(
            ServerCapabilities::builder()
                .enable_tools()
                .enable_tool_list_changed()
                .build(),
        )
        .with_server_info(Implementation::new("abler-mcp", env!("CARGO_PKG_VERSION")))
        .with_instructions(surface().instructions.clone())
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(surface().tools.clone()))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> std::result::Result<CallToolResponse, ErrorData> {
        let name = request.name.as_ref();

        if !surface().tools.iter().any(|tool| tool.name == name) {
            return Err(ErrorData::invalid_params(
                format!("Tool {name} not found"),
                None,
            ));
        }
        let arguments = request.arguments.unwrap_or_default();

        Ok(match self.call(name, &arguments).await {
            Ok(output) => tool_result(output),
            Err(issues) => CallToolResult::error(vec![ContentBlock::text(format!(
                "Input validation error: Invalid arguments for tool {name}: {issues}"
            ))]),
        }
        .into())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn results_match_tool_result() {
        let ok = serde_json::to_value(tool_result(Ok(json!({ "b": 1, "a": [] })))).unwrap();
        assert_eq!(
            ok,
            json!({
                "resultType": ok["resultType"],
                "content": [{ "type": "text", "text": r#"{"b":1,"a":[]}"# }],
                "structuredContent": { "b": 1, "a": [] },
            })
        );
        let error = serde_json::to_value(tool_result(Err(crate::error::Fail::Unknown))).unwrap();
        assert_eq!(error["isError"], true);
        assert_eq!(
            error["content"][0]["text"],
            "The operation failed. Check the server logs for details."
        );
        assert_eq!(surface().tools.len(), 8);
    }
}
