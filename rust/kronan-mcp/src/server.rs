//! The MCP surface of packages/kronan-mcp/src/server.ts. tools/list replays the TypeScript
//! server's advertised tools (src/surface.json, checked by a test), so names, descriptions,
//! schemas and annotations match exactly.

use std::sync::{Arc, OnceLock};

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::api::Client;
use crate::error::{Fail, Result};
use crate::input;

fn surface() -> &'static Surface {
    static SURFACE: OnceLock<Surface> = OnceLock::new();
    SURFACE.get_or_init(|| Surface::parse(include_str!("surface.json")))
}

pub struct Kronan {
    pub client: Arc<Client>,
}

impl Server for Kronan {
    type Fail = Fail;

    const NAME: &'static str = "kronan-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        surface()
    }

    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        let client = &self.client;

        Ok(match name {
            "auth_status" => {
                input::empty(arguments)?;
                client.run(Client::status).await
            }
            "search_products" => {
                let body = input::search_products(arguments)?;
                client
                    .run(move |client| client.search_products(&body))
                    .await
            }
            "get_product" => {
                let key = input::product(arguments)?;
                client.run(move |client| client.product(&key)).await
            }
            "lookup_products" => {
                let body = input::lookup_products(arguments)?;
                client
                    .run(move |client| client.lookup_products(&body))
                    .await
            }
            "list_categories" => {
                input::empty(arguments)?;
                client.run(Client::categories).await
            }
            "list_category_products" => {
                let (slug, page) = input::slug_page(arguments)?;
                client
                    .run(move |client| client.category_products(&slug, page))
                    .await
            }
            "list_product_tags" => {
                input::empty(arguments)?;
                client.run(Client::tags).await
            }
            "list_products_by_tag" => {
                let (slug, page) = input::slug_page(arguments)?;
                client
                    .run(move |client| client.products_by_tag(&slug, page))
                    .await
            }
            "list_products_on_sale" => {
                let page = input::page_only(arguments)?;
                client
                    .run(move |client| client.products_on_sale(page))
                    .await
            }
            "list_favorite_products" => {
                let page = input::page_only(arguments)?;
                client
                    .run(move |client| client.favorite_products(page))
                    .await
            }
            "list_orders" => {
                let (window, filters) = input::list_orders(arguments)?;
                client
                    .run(move |client| client.orders(window, filters))
                    .await
            }
            "get_order" => {
                let token = input::token(arguments)?;
                client.run(move |client| client.order(&token)).await
            }
            "get_active_order" => {
                input::empty(arguments)?;
                client.run(Client::active_order).await
            }
            "summarize_order_lines" => {
                let query = input::summarize_order_lines(arguments)?;
                client
                    .run(move |client| client.order_line_summary(&query))
                    .await
            }
            "list_purchase_stats" => {
                let (window, query) = input::purchase_stats(arguments)?;
                client
                    .run(move |client| client.purchase_stats(window, query))
                    .await
            }
            "get_shopping_note" => {
                input::empty(arguments)?;
                client.run(Client::shopping_note).await
            }
            "list_archived_shopping_note_lines" => {
                input::empty(arguments)?;
                client.run(Client::archived_shopping_note_lines).await
            }
            "list_product_lists" => {
                let window = input::offset(arguments)?;
                client.run(move |client| client.product_lists(window)).await
            }
            "get_product_list" => {
                let token = input::token(arguments)?;
                client.run(move |client| client.product_list(&token)).await
            }
            "list_recipes" => {
                let window = input::offset(arguments)?;
                client.run(move |client| client.recipes(window)).await
            }
            "search_recipes" => {
                let body = input::search_recipes(arguments)?;
                client.run(move |client| client.search_recipes(&body)).await
            }
            "get_recipe" => {
                let slug = input::recipe(arguments)?;
                client.run(move |client| client.recipe(&slug)).await
            }
            "list_favorite_recipes" => {
                let window = input::offset(arguments)?;
                client
                    .run(move |client| client.favorite_recipes(window))
                    .await
            }
            "list_addresses" => {
                input::empty(arguments)?;
                client.run(Client::addresses).await
            }
            "get_delivery_slots" => {
                let body = input::delivery_slots(arguments)?;
                client.run(move |client| client.delivery_slots(&body)).await
            }
            "get_pickup_slots" => {
                let body = input::pickup_slots(arguments)?;
                client.run(move |client| client.pickup_slots(&body)).await
            }
            "get_checkout" => {
                input::empty(arguments)?;
                client.run(Client::checkout).await
            }
            "preview_checkout_lines" => {
                let body = input::preview_checkout_lines(arguments)?;
                client
                    .run(move |client| client.preview_checkout_lines(&body))
                    .await
            }
            // The write and order tools arrive with their confirmation gates.
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
