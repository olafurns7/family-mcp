use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use family_store::Cancel;
use reqwest::Method;
use reqwest::header::{HeaderMap, HeaderValue};
use serde_json::{Value, json};
use tokio::runtime::Handle;
use tokio::sync::{RwLock, watch};

use crate::error::{Fail, Result};
use crate::{catalog, js, origin, shapes, store};

pub const REQUEST_FAILED: &str =
    "The request failed or timed out. Its result may be unknown; do not repeat a payment.";
pub const INVALID_RESPONSE: &str =
    "Unexpected response from Domino’s or its payment provider. The service may have changed.";
pub struct Client {
    pub(crate) path: PathBuf,
    http: reqwest::Client,
    pub(crate) origins: [String; 3],
    handle: Handle,
    stop: watch::Sender<bool>,
    pub(crate) cancel: Cancel,
    active: Arc<RwLock<()>>,
}
impl Client {
    pub fn new() -> Result<Self> {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never());
        #[cfg(feature = "test-origin")]
        let builder = builder.no_proxy();
        Ok(Self {
            path: store::session_path()?,
            http: builder.build().map_err(|_| Fail::Unknown)?,
            origins: origin::origins(),
            handle: Handle::current(),
            stop: watch::channel(false).0,
            cancel: Cancel::default(),
            active: Arc::new(RwLock::new(())),
        })
    }
    pub fn abort(&self) {
        self.stop.send_replace(true);
        self.cancel.cancel();
    }
    pub async fn close(&self) {
        self.abort();
        let _ = self.active.write().await;
    }
    pub async fn run(self: &Arc<Self>, name: String, input: Value) -> Result<Value> {
        let active = self.active.clone().read_owned().await;
        let client = self.clone();
        tokio::task::spawn_blocking(move || {
            let _active = active;
            client.call(&name, &input)
        })
        .await
        .unwrap_or(Err(Fail::Unknown))
    }
    fn wait<F: Future>(&self, future: F) -> Option<F::Output> {
        let mut stop = self.stop.subscribe();
        self.handle.block_on(async {
            tokio::select! { biased; _ = stop.wait_for(|stopped|*stopped) => None, output = future => Some(output) }
        })
    }
    pub fn text(
        &self,
        url: &str,
        method: Method,
        headers: HeaderMap,
        body: Option<String>,
    ) -> Result<String> {
        self.wait(tokio::time::timeout(Duration::from_secs(25), async {
            let mut request = self.http.request(method, url).headers(headers);
            if let Some(body) = body {
                request = request.body(body);
            }
            let response = request
                .send()
                .await
                .map_err(|_| Fail::Safe(REQUEST_FAILED))?;
            // Bun's redirect:'error' refuses a redirect before looking at its body.
            if response.status().is_redirection() {
                return Err(Fail::Safe(REQUEST_FAILED));
            }
            if !response.status().is_success() {
                return Err(Fail::Http(response.status().as_u16()));
            }
            let bytes = mcp_runtime::read_capped(response, 8 * 1024 * 1024)
                .await
                .map_err(|_| Fail::Safe(REQUEST_FAILED))?;
            Ok(String::from_utf8_lossy(&bytes).into_owned())
        }))
        .ok_or(Fail::Safe(REQUEST_FAILED))?
        .map_err(|_| Fail::Safe(REQUEST_FAILED))?
    }
    pub(crate) fn dominos(
        &self,
        path: &str,
        schema: &shapes::S,
        session: Option<&store::Session>,
    ) -> Result<Value> {
        self.dominos_body(path, schema, session, None)
    }
    pub(crate) fn dominos_body(
        &self,
        path: &str,
        schema: &shapes::S,
        session: Option<&store::Session>,
        body: Option<String>,
    ) -> Result<Value> {
        let mut headers = HeaderMap::new();
        headers.insert("accept", HeaderValue::from_static("application/json"));
        if let Some(session) = session {
            headers.insert(
                "authorization",
                HeaderValue::from_str(&format!(
                    "bearer {}",
                    session["accessToken"].as_str().unwrap_or_default()
                ))
                .map_err(|_| Fail::Unknown)?,
            );
        }
        let method = if body.is_some() {
            headers.insert("content-type", HeaderValue::from_static("application/json"));
            Method::POST
        } else {
            Method::GET
        };
        let text = self.text(&format!("{}{path}", self.origins[0]), method, headers, body)?;
        js::parse(text.as_bytes())
            .and_then(|value| shapes::parse(schema, &value))
            .ok_or(Fail::Safe(INVALID_RESPONSE))
    }
    pub(crate) fn menu(&self) -> Result<Value> {
        catalog::parse_menu(&self.text(
            &format!("{}/panta/pizzur", self.origins[1]),
            Method::GET,
            HeaderMap::new(),
            None,
        )?)
    }
    pub fn api_url(&self, path: &str) -> String {
        format!("{}{path}", self.origins[0])
    }
    fn refresh(
        &self,
        previous: &store::Session,
        save: &mut dyn FnMut(&store::Session) -> Result<()>,
    ) -> Result<store::Session> {
        let next = crate::auth::exchange(
            self,
            format!(
                "grant_type=refresh_token&refresh_token={}",
                js::encode_query(previous["refreshToken"].as_str().unwrap_or_default())
            ),
        )?;
        if next["username"] != previous["username"] {
            return Err(Fail::Safe(
                "The refreshed Domino’s account differs from the saved account. Sign in again.",
            ));
        }
        save(&next)?;
        Ok(next)
    }
    pub(crate) fn authenticated(
        &self,
        retry_read: bool,
        mut work: impl FnMut(&store::Session) -> Result<Value>,
    ) -> Result<Value> {
        store::with_session(&self.path, &self.cancel, |mut session, save, _| {
            if session["expiresAt"].as_f64().unwrap_or(0.0) <= js::now() as f64 + 60_000.0 {
                session = self.refresh(&session, save)?;
            }
            match work(&session) {
                Err(Fail::Http(401)) if retry_read => work(&self.refresh(&session, save)?),
                outcome => outcome,
            }
        })
    }
    fn call(&self, name: &str, input: &Value) -> Result<Value> {
        match name {
            "quote_order" => self.quote_order(input),
            "create_checkout" => self.create_checkout(input),
            "get_checkout" => self.get_checkout(input),
            "pay_saved_card" => self.pay_saved_card(input),
            "auth_status" => self.authenticated(true, |session| {
                let account=self.dominos("user/newuser",&shapes::PROFILE,Some(session))?;
                Ok(json!({"authenticated":true,"name":account["name"]}))
            }),
            "get_profile" => self.authenticated(true, |session| {
                let account=self.dominos("user/newuser",&shapes::PROFILE,Some(session))?;
                let addresses=account["savedAddress"].as_array().map(|items|items.iter().map(|a|json!({"ID":a["AddressID"],"Name":a["Address"],"PostalCode":a["PostalCode"],"PostalCodeName":a["PostalCodeName"]})).collect::<Vec<_>>()).unwrap_or_default();
                let orders=account["savedOrders"].as_array().map(|items|items.iter().map(|o|json!({"id":o["id"],"name":o["name"]})).collect::<Vec<_>>()).unwrap_or_default();
                Ok(json!({"id":account["id"],"name":account["name"],"phoneNumber":account["phoneNumber"],"email":account["email"],"addresses":addresses,"savedOrders":orders}))
            }),
            "list_stores" => Ok(json!({"stores":self.dominos("store",&shapes::STORES,None)?})),
            "search_addresses" => Ok(json!({"addresses":self.dominos(&format!("addresses?q={}",js::encode_component(input["query"].as_str().unwrap_or_default())),&shapes::ADDRESSES,None)?})),
            "get_delivery_store" => self.dominos(&format!("addresses/GetAddressStoreWithWaitingTimes?address={}&postalCode={}",js::encode_query(input["address"].as_str().unwrap_or_default()),js::encode_query(input["postalCode"].as_str().unwrap_or_default())),&shapes::DELIVERY_STORE,None),
            "list_receipts" => self.authenticated(true, |session|Ok(json!({"receipts":self.dominos("user/getreceipts",&shapes::RECEIPTS,Some(session))?}))),
            "get_tracker" => self.authenticated(true, |session|Ok(json!({"tracker":self.dominos("tracker",&shapes::TRACKER,Some(session))?}))),
            "search_menu" => {
                let menu=self.menu()?;
                let query=input["query"].as_str().unwrap_or_default().to_lowercase();
                let mut items=Vec::new();
                for (kind,key) in [("pizza","menuPizzas"),("side","sides"),("sauce","sauces"),("beverage","beverages"),("offer","packages")] {
                    if input["kind"].as_str().is_some_and(|selected|selected!=kind) { continue; }
                    for item in menu[key].as_array().ok_or(Fail::Unknown)? {
                        if item["isHidden"]==true || !item["name"].as_str().unwrap_or_default().to_lowercase().contains(&query) { continue; }
                        items.push(json!({"kind":kind,"id":item["id"],"name":item["name"],"description":item.get("description").unwrap_or(&Value::Null)}));
                    }
                }
                let (offset,limit)=(input["offset"].as_u64().unwrap_or(0) as usize,input["limit"].as_u64().unwrap_or(20) as usize);
                let end=offset.saturating_add(limit);
                Ok(json!({"items":items[offset.min(items.len())..end.min(items.len())],"total":items.len(),"nextOffset":if end<items.len(){json!(end)}else{Value::Null}}))
            },
            "get_menu_item" => {
                let menu=self.menu()?;
                let kind=input["kind"].as_str().unwrap_or_default();
                let key=match kind { "pizza"=>"menuPizzas", "side"=>"sides", "sauce"=>"sauces", "beverage"=>"beverages", _=>"packages" };
                let mut items=menu[key].as_array().ok_or(Fail::Unknown)?.iter().collect::<Vec<_>>();
                if kind=="pizza" { items.push(&menu["basePizza"]); }
                let item=items.into_iter().find(|item|item["id"]==input["id"] && item["isHidden"]!=true).ok_or(Fail::Safe("Menu item not found. Use search_menu to discover current IDs."))?;
                let toppings=if kind=="pizza" { menu["allToppings"].as_array().ok_or(Fail::Unknown)?.iter().filter(|item|item["isHidden"]!=true).cloned().collect::<Vec<_>>() }else{Vec::new()};
                Ok(json!({"kind":kind,"item":item,"toppings":toppings,"allergens":menu["allergens"]}))
            },
            _=>Err(Fail::Unknown),
        }
    }
}
