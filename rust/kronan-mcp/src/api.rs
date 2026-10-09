//! Krónan's API, with packages/kronan-mcp/src/api.ts's requests, bounds, upstream shapes and
//! messages. A client operation may hold a file lock across requests, so it runs on a blocking
//! thread and waits for each request with `Handle::block_on`.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::{RwLock, watch};
use tokio::time::Instant;

use crate::auth;
use crate::error::{Fail, Result};
use crate::input::{ProductKey, Query, Window};
use crate::js;
use crate::shapes::{self, S};

#[cfg(not(feature = "test-origin"))]
const ORIGIN: &str = "https://api.kronan.is";

const MAX_RESPONSE_BODY_BYTES: usize = 4 * 1024 * 1024;

const TIMEOUT: Duration = Duration::from_secs(20);

const TOKEN_REJECTED: Fail = Fail::Safe(
    "Krónan rejected the access token. Create a new token in Krónan settings and run kronan-mcp auth set.",
);

const ACCESS_DENIED: Fail = Fail::Safe(
    "Krónan denied this request for the saved token. Use a token for the right user or customer group, or one with the needed permission.",
);

const RESPONSE_TOO_LARGE: Fail =
    Fail::Safe("Krónan response exceeded the 4 MiB limit. Request a smaller page and retry.");

const CANCELLED: Fail =
    Fail::Safe("The Krónan request was cancelled while the server was shutting down.");

const INVALID_RESPONSE: Fail = Fail::Safe("Krónan returned an invalid API response.");

const REQUEST_FAILED: Fail =
    Fail::Safe("Krónan request failed or timed out. Check the connection and try again.");

const RATE_LIMITED: Fail = Fail::Safe(
    "Krónan rate limit reached (200 requests per 200 seconds per account). Wait and retry.",
);

const UNEXPECTED_DATA: Fail = Fail::Safe(
    "Krónan returned data outside the documented schema. The API may have changed; report this with the kronan-mcp version.",
);

const UPSTREAM_ERROR: Fail = Fail::Safe("Krónan returned an error for the requested operation.");

const ORDER_NOT_FOUND: Fail =
    Fail::Safe("Order not found at Krónan. Use a token from list_orders.");

/// A response together with the deadline that bounds its request, for the body read.
struct Exchange {
    response: reqwest::Response,
    deadline: Instant,
}

#[cfg(not(feature = "test-origin"))]
fn origin() -> String {
    ORIGIN.to_owned()
}

/// A `test-origin` build never talks to Krónan: it sends to the loopback port in
/// KRONAN_TEST_ORIGIN, and without one to a closed local port.
#[cfg(feature = "test-origin")]
fn origin() -> String {
    let origin = std::env::var("KRONAN_TEST_ORIGIN").unwrap_or_default();
    let port = origin.strip_prefix("http://127.0.0.1:").unwrap_or_default();

    match !port.is_empty() && port.bytes().all(|byte| byte.is_ascii_digit()) {
        true => origin,
        false => "http://127.0.0.1:9".to_owned(),
    }
}

/// Maps status codes to fixed messages; a 404 is only meaningful where the caller names it.
fn failure(status: u16, not_found: Option<Fail>) -> Option<Fail> {
    match status {
        401 => Some(TOKEN_REJECTED),
        403 => Some(ACCESS_DENIED),
        429 => Some(RATE_LIMITED),
        404 if not_found.is_some() => not_found,
        200..=299 => None,
        _ => Some(UPSTREAM_ERROR),
    }
}

/// `URLSearchParams` in insertion order.
fn query_string(query: &Query) -> String {
    let pairs: Vec<String> = query
        .iter()
        .map(|(name, value)| format!("{}={}", js::encode_query(name), js::encode_query(value)))
        .collect();
    match pairs.is_empty() {
        true => String::new(),
        false => format!("?{}", pairs.join("&")),
    }
}

/// Limit/offset pages arrive with absolute URLs; the result reports the window as flags. The next
/// offset counts the items actually returned, so a clamped or short upstream page cannot skip
/// items.
fn offset_page(page: Value, window: Window) -> Value {
    let has_next = !matches!(page.get("next"), None | Some(Value::Null));
    let returned = page["results"].as_array().map_or(0, Vec::len) as i64;
    json!({
        "count": page["count"],
        "limit": window.limit,
        "offset": window.offset,
        "hasNextPage": has_next,
        "nextOffset": if has_next { json!(window.offset + returned) } else { Value::Null },
        "results": page["results"],
    })
}

pub struct Client {
    http: reqwest::Client,
    origin: String,
    handle: Handle,
    stop: watch::Sender<bool>,
    active: Arc<RwLock<()>>,
}

impl Client {
    pub fn new() -> Result<Self> {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .build()
            .map_err(|_| Fail::Unknown)?;

        Ok(Self {
            http,
            origin: origin(),
            handle: Handle::current(),
            stop: watch::channel(false).0,
            active: Arc::new(RwLock::new(())),
        })
    }

    /// Cancel requests in flight, and every later one.
    pub fn abort(&self) {
        self.stop.send_replace(true);
    }

    /// Abort, then wait for every operation to end.
    pub async fn close(&self) {
        self.abort();
        let _ = self.active.write().await;
    }

    /// Run a client operation on a blocking thread; `close` waits for it.
    pub async fn run<T: Send + 'static>(
        self: &Arc<Self>,
        operation: impl FnOnce(&Client) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let active = self.active.clone().read_owned().await;
        let client = self.clone();

        let outcome = tokio::task::spawn_blocking(move || {
            let _active = active;
            operation(&client)
        })
        .await;
        outcome.unwrap_or(Err(Fail::Unknown))
    }

    /// Wait for `future` from the blocking thread; `None` once the client closes.
    fn wait<F: Future>(&self, future: F) -> Option<F::Output> {
        let mut stop = self.stop.subscribe();

        self.handle.block_on(async {
            tokio::select! {
                biased;
                _ = stop.wait_for(|stopped| *stopped) => None,
                output = future => Some(output),
            }
        })
    }

    fn send(
        &self,
        method: Method,
        path: &str,
        query: &Query,
        body: Option<&Value>,
    ) -> Result<Exchange> {
        // The saved token is read for every request, so `auth set` applies without a restart.
        let token = auth::load_token()?;

        // Identifiers are validated and encoded, so URL normalization must not move the request.
        if path
            .split('/')
            .any(|segment| segment == "." || segment == "..")
        {
            return Err(Fail::Safe("Invalid identifier in the request."));
        }
        let url = format!("{}/api/v1{path}{}", self.origin, query_string(query));
        let authorization =
            HeaderValue::from_str(&format!("AccessToken {token}")).map_err(|_| Fail::Unknown)?;
        let mut request = self
            .http
            .request(method, url)
            .header(AUTHORIZATION, authorization)
            .header(ACCEPT, "application/json");

        if let Some(body) = body {
            request = request
                .header(CONTENT_TYPE, "application/json")
                .body(body.to_string());
        }
        let deadline = Instant::now() + TIMEOUT;
        let sent = self.wait(tokio::time::timeout_at(deadline, request.send()));
        let response = sent
            .ok_or(CANCELLED)?
            .ok()
            .and_then(std::result::Result::ok)
            // fetch's `redirect: 'error'` fails on any redirect status.
            .filter(|response| ![301, 302, 303, 307, 308].contains(&response.status().as_u16()))
            .ok_or(REQUEST_FAILED)?;
        Ok(Exchange { response, deadline })
    }

    fn json(&self, exchange: Exchange, not_found: Option<Fail>) -> Result<Value> {
        let Exchange { response, deadline } = exchange;

        // Error bodies may echo request details; they are discarded unread.
        if let Some(fail) = failure(response.status().as_u16(), not_found) {
            return Err(fail);
        }
        let read = self.wait(tokio::time::timeout_at(
            deadline,
            mcp_runtime::read_capped(response, MAX_RESPONSE_BODY_BYTES),
        ));
        let body = match read {
            None => return Err(CANCELLED),
            // The request timer also bounds the body; a stalled stream is a connection problem.
            Some(Err(_)) => return Err(REQUEST_FAILED),
            Some(Ok(Err(mcp_runtime::BodyError::TooLarge))) => return Err(RESPONSE_TOO_LARGE),
            Some(Ok(Err(_))) => return Err(INVALID_RESPONSE),
            Some(Ok(Ok(body))) => body,
        };
        js::parse(&body).ok_or(INVALID_RESPONSE)
    }

    fn get(&self, path: &str, query: &Query, schema: &S, not_found: Option<Fail>) -> Result<Value> {
        let data = self.json(self.send(Method::GET, path, query, None)?, not_found)?;
        shapes::parse(schema, &data).ok_or(UNEXPECTED_DATA)
    }

    fn post(&self, path: &str, body: &Value, schema: &S) -> Result<Value> {
        let data = self.json(
            self.send(Method::POST, path, &Query::new(), Some(body))?,
            None,
        )?;
        shapes::parse(schema, &data).ok_or(UNEXPECTED_DATA)
    }

    /// Fetches one limit/offset page and reports its window as flags instead of upstream URLs.
    fn offset_paged(&self, path: &str, window: Window, extra: Query, page: &S) -> Result<Value> {
        let mut query = vec![
            ("limit", window.limit.to_string()),
            ("offset", window.offset.to_string()),
        ];
        query.extend(extra);
        Ok(offset_page(self.get(path, &query, page, None)?, window))
    }

    fn read_active_order(&self) -> Result<Value> {
        let exchange = self.send(
            Method::GET,
            "/orders/currently-active/",
            &Query::new(),
            None,
        )?;

        // Krónan documents 404 with no body as 'no active order'; every other failure is an error.
        if exchange.response.status() == 404 {
            return Ok(json!({ "active": false, "order": null }));
        }
        let data = self.json(exchange, None)?;
        let order = shapes::parse(&shapes::ACTIVE_ORDER, &data).ok_or(UNEXPECTED_DATA)?;
        Ok(json!({ "active": true, "order": order }))
    }

    /// An authenticated read, so 'authenticated' never means only 'file exists'.
    pub fn status(&self) -> Result<Value> {
        let account = self.get("/me/", &Query::new(), &shapes::ME, None)?;
        Ok(json!({ "authenticated": true, "account": account }))
    }

    pub fn search_products(&self, body: &Value) -> Result<Value> {
        self.post("/products/search/", body, &shapes::SEARCH_RESULT)
    }

    pub fn product(&self, key: &ProductKey) -> Result<Value> {
        let path = match key {
            ProductKey::Sku(sku) => format!("/products/{}/", js::encode_component(sku)),
            ProductKey::Barcode(barcode) => {
                format!("/products/barcode/{}/", js::encode_component(barcode))
            }
        };
        self.get(
            &path,
            &Query::new(),
            &shapes::PRODUCT_DETAIL,
            Some(Fail::Safe("Product not found at Krónan.")),
        )
    }

    pub fn lookup_products(&self, body: &Value) -> Result<Value> {
        self.post("/products/batch/", body, &shapes::LOOKUP_RESULT)
    }

    pub fn categories(&self) -> Result<Value> {
        let categories = self.get("/categories/", &Query::new(), &shapes::CATEGORIES, None)?;
        Ok(json!({ "categories": categories }))
    }

    pub fn category_products(&self, slug: &str, page: i64) -> Result<Value> {
        self.get(
            &format!("/categories/{}/products/", js::encode_component(slug)),
            &vec![("page", page.to_string())],
            &shapes::CATEGORY_PRODUCTS,
            Some(Fail::Safe(
                "Category not found at Krónan. Use a leaf (third-level) slug from list_categories.",
            )),
        )
    }

    pub fn tags(&self) -> Result<Value> {
        let tags = self.get("/products/tags/", &Query::new(), &shapes::TAGS, None)?;
        Ok(json!({ "tags": tags }))
    }

    pub fn products_by_tag(&self, slug: &str, page: i64) -> Result<Value> {
        self.get(
            &format!("/products/by-tag/{}/", js::encode_component(slug)),
            &vec![("page", page.to_string())],
            &shapes::PRODUCT_PAGE,
            Some(Fail::Safe(
                "Tag not found at Krónan. Use a slug from list_product_tags.",
            )),
        )
    }

    pub fn products_on_sale(&self, page: i64) -> Result<Value> {
        self.get(
            "/products/on-sale/",
            &vec![("page", page.to_string())],
            &shapes::PRODUCT_PAGE,
            None,
        )
    }

    pub fn favorite_products(&self, page: i64) -> Result<Value> {
        self.get(
            "/products/favorites/",
            &vec![("page", page.to_string())],
            &shapes::PRODUCT_PAGE,
            None,
        )
    }

    pub fn orders(&self, window: Window, filters: Query) -> Result<Value> {
        self.offset_paged("/orders/", window, filters, &shapes::ORDERS_PAGE)
    }

    pub fn order(&self, token: &str) -> Result<Value> {
        self.get(
            &format!("/orders/{}/", js::encode_component(token)),
            &Query::new(),
            &shapes::ORDER,
            Some(ORDER_NOT_FOUND),
        )
    }

    pub fn active_order(&self) -> Result<Value> {
        self.read_active_order()
    }

    pub fn order_line_summary(&self, query: &Query) -> Result<Value> {
        self.get("/orders/line-summary/", query, &shapes::LINE_SUMMARY, None)
    }

    pub fn purchase_stats(&self, window: Window, query: Query) -> Result<Value> {
        self.offset_paged(
            "/product-purchase-stats/",
            window,
            query,
            &shapes::PURCHASE_STATS_PAGE,
        )
    }

    pub fn shopping_note(&self) -> Result<Value> {
        self.get(
            "/shopping-notes/",
            &Query::new(),
            &shapes::SHOPPING_NOTE,
            None,
        )
    }

    pub fn archived_shopping_note_lines(&self) -> Result<Value> {
        let lines = self.get(
            "/shopping-notes/lines-archived/",
            &Query::new(),
            &shapes::ARCHIVED_LINES,
            None,
        )?;
        Ok(json!({ "lines": lines }))
    }

    pub fn product_lists(&self, window: Window) -> Result<Value> {
        self.offset_paged(
            "/product-lists/",
            window,
            Query::new(),
            &shapes::PRODUCT_LISTS_PAGE,
        )
    }

    pub fn product_list(&self, token: &str) -> Result<Value> {
        self.get(
            &format!("/product-lists/{}/", js::encode_component(token)),
            &Query::new(),
            &shapes::PRODUCT_LIST_DETAIL,
            Some(Fail::Safe(
                "Product list not found at Krónan. Use a token from list_product_lists.",
            )),
        )
    }

    pub fn recipes(&self, window: Window) -> Result<Value> {
        self.offset_paged("/recipes/", window, Query::new(), &shapes::RECIPES_PAGE)
    }

    pub fn search_recipes(&self, body: &Value) -> Result<Value> {
        self.post("/recipes/search/", body, &shapes::RECIPE_SEARCH)
    }

    pub fn recipe(&self, slug: &str) -> Result<Value> {
        self.get(
            &format!("/recipes/{}/", js::encode_component(slug)),
            &Query::new(),
            &shapes::RECIPE_DETAIL,
            Some(Fail::Safe(
                "Recipe not found at Krónan. Use a slug from list_recipes.",
            )),
        )
    }

    pub fn favorite_recipes(&self, window: Window) -> Result<Value> {
        self.offset_paged(
            "/recipes/favorites/",
            window,
            Query::new(),
            &shapes::RECIPES_PAGE,
        )
    }

    pub fn addresses(&self) -> Result<Value> {
        let addresses = self.get("/addresses/", &Query::new(), &shapes::ADDRESSES, None)?;
        Ok(json!({ "addresses": addresses }))
    }

    /// Availability lookups are POSTs upstream but change nothing; reservation is a separate
    /// endpoint.
    pub fn delivery_slots(&self, body: &Value) -> Result<Value> {
        let days = self.post("/slots/delivery/", body, &shapes::DELIVERY_SLOTS)?;
        Ok(json!({ "days": days }))
    }

    pub fn pickup_slots(&self, body: &Value) -> Result<Value> {
        let stores = self.post("/slots/pickup/", body, &shapes::PICKUP_SLOTS)?;
        Ok(json!({ "stores": stores }))
    }

    pub fn checkout(&self) -> Result<Value> {
        self.get("/checkout/", &Query::new(), &shapes::CHECKOUT, None)
    }

    /// Krónan documents this POST as validation only; the checkout is not modified.
    pub fn preview_checkout_lines(&self, body: &Value) -> Result<Value> {
        self.post("/checkout/preview-lines/", body, &shapes::PREVIEW)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_count_returned_items_and_queries_encode_like_url_search_params() {
        let page = json!({ "count": 60, "next": "https://x/?offset=50", "results": [1, 2] });
        assert_eq!(
            offset_page(
                page,
                Window {
                    limit: 100,
                    offset: 10
                }
            )
            .to_string(),
            r#"{"count":60,"limit":100,"offset":10,"hasNextPage":true,"nextOffset":12,"results":[1,2]}"#
        );
        let last = json!({ "count": 2, "next": null, "results": [1] });
        assert_eq!(
            offset_page(
                last,
                Window {
                    limit: 20,
                    offset: 1
                }
            )["nextOffset"],
            Value::Null
        );
        assert_eq!(
            query_string(&vec![
                ("name_contains", "mjólk & co".to_owned()),
                ("skus", "A".to_owned())
            ]),
            "?name_contains=mj%C3%B3lk+%26+co&skus=A"
        );
        assert_eq!(failure(404, None), Some(UPSTREAM_ERROR));
        assert_eq!(failure(204, None), None);
    }
}
