//! The TS quote/checkout records and send-once state transitions. Local records stay beside the
//! legacy path, including after session migration, so either implementation can continue them.
use crate::client::{Client, INVALID_RESPONSE};
use crate::error::{Fail, Result};
use crate::{catalog, input, js, shapes, store};
use family_store::{
    Cancel, DEFAULT_SWEEP_AGE, LockOptions, read_private_file, sweep_temp, with_file_lock,
    write_private_file,
};
use reqwest::{
    Method,
    header::{HeaderMap, HeaderValue},
};
use serde_json::{Value, json};
use std::path::PathBuf;
const LOCAL_FAILED: &str = "Cannot safely access the local Domino’s session. Check file permissions or retry when the other request finishes.";
const RECORD_INVALID: &str = "The local quote or checkout is missing or invalid. Do not repeat an uncertain payment; check your Domino’s order history first.";
fn uuid() -> Result<String> {
    let mut bytes = [0; 16];
    getrandom::fill(&mut bytes).map_err(|_| Fail::Unknown)?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = bytes.iter().map(|b| format!("{b:02x}")).collect::<String>();
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}
fn iso(value: &Value) -> Result<String> {
    let n = value
        .as_f64()
        .filter(|n| n.abs() <= 8_640_000_000_000_000.0)
        .ok_or(Fail::Unknown)?;
    Ok(js::iso_string(n as i64))
}
fn public_checkout(value: &Value) -> Result<Value> {
    let cards=value["cards"].as_array().ok_or(Fail::Unknown)?.iter().enumerate().map(|(at,v)|json!({"cardId":format!("card_{}",at+1),"brand":v["brand"],"lastFour":v["lastFour"],"expiryMonth":v["expiryMonth"],"expiryYear":v["expiryYear"]})).collect::<Vec<_>>();
    Ok(
        json!({"checkoutId":value["id"],"state":value["state"],"total":value["total"],"currency":"ISK","cart":value["cart"],"orderId":value["orderId"],"expiresAt":iso(&value["expiresAt"])?,"resultCode":value.get("resultCode").unwrap_or(&Value::Null),"cards":cards}),
    )
}
enum LocalError {
    Store,
    Fail(Fail),
}
impl From<family_store::Error> for LocalError {
    fn from(_: family_store::Error) -> Self {
        Self::Store
    }
}
impl Client {
    fn file(&self, id: &str) -> Result<PathBuf> {
        if !input::uuid(id) {
            return Err(Fail::Safe(RECORD_INVALID));
        }
        let mut path = self.path.as_os_str().to_owned();
        path.push(".checkouts");
        Ok(PathBuf::from(path).join(format!("{id}.json")))
    }
    fn read_record(&self, id: &str, schema: &shapes::S) -> Result<Value> {
        self.file(id)
            .ok()
            .and_then(|path| read_private_file(&path, 1_048_576).ok())
            .and_then(|s| js::parse(s.as_bytes()))
            .and_then(|v| shapes::parse(schema, &v))
            .ok_or(Fail::Safe(RECORD_INVALID))
    }
    fn save_record(&self, value: &Value) -> Result<()> {
        let path = self.file(value["id"].as_str().ok_or(Fail::Unknown)?)?;
        let text = format!("{}\n", js::normalize(value.clone()));
        write_private_file(&path, text.as_bytes(), &Cancel::default()).map_err(|_| Fail::LocalStore)
    }
    fn record_locked(&self, id: &str, work: impl FnOnce() -> Result<Value>) -> Result<Value> {
        let path = self.file(id)?;
        let options = LockOptions {
            cancel: self.cancel.clone(),
            ..LockOptions::default()
        };
        with_file_lock(&path, &options, || {
            sweep_temp(&path, DEFAULT_SWEEP_AGE)?;
            work().map_err(LocalError::Fail)
        })
        .map_err(|e| match e {
            LocalError::Store | LocalError::Fail(Fail::LocalStore) => Fail::Safe(LOCAL_FAILED),
            LocalError::Fail(f) => f,
        })
    }
    fn payload(&self, cart: &Value, session: &store::Session, final_order: bool) -> Result<String> {
        let items = catalog::order_items(cart, &self.menu()?)?;
        let account = self.dominos("user/newuser", &shapes::PROFILE, Some(session))?;
        let fulfillment = &cart["fulfillment"];
        let pickup = fulfillment["type"] == "pickup";
        let store_id = if pickup {
            fulfillment["storeId"].clone()
        } else {
            self.dominos(
                &format!(
                    "addresses/GetAddressStoreWithWaitingTimes?address={}&postalCode={}",
                    js::encode_query(fulfillment["address"]["Name"].as_str().unwrap_or_default()),
                    js::encode_query(
                        fulfillment["address"]["PostalCode"]
                            .as_str()
                            .unwrap_or_default()
                    )
                ),
                &shapes::DELIVERY_STORE,
                None,
            )?["RefID"]
                .clone()
        };
        let stores = self.dominos("store", &shapes::STORES, None)?;
        let selected = stores
            .as_array()
            .ok_or(Fail::Unknown)?
            .iter()
            .find(|v| v["RefID"] == store_id);
        if !selected.is_some_and(|v| {
            v["Disabled"] != true
                && v["IsHidden"] != true
                && v["AcceptInternet"] == true
                && v[if pickup {
                    "AcceptsPickup"
                } else {
                    "AcceptsDelivery"
                }] == true
        }) {
            return Err(Fail::Safe(
                "The selected store is not accepting this type of online order now.",
            ));
        }
        let mut body = items.clone();
        body["User"] = json!({"Name":account["name"].as_str().unwrap_or_default(),"Username":session["username"],"Translation":"IS"});
        body["IsPickup"] = json!(pickup);
        if pickup {
            body["StoreID"] = store_id;
        } else {
            let mut location = fulfillment["address"].clone();
            location["Address"] = fulfillment["address"]["Name"].clone();
            location["AdditionalInfo"] = fulfillment["instructions"].clone();
            body["Location"] = location;
        }
        body["AdditionalPickupInfo"] = if pickup {
            fulfillment["instructions"].clone()
        } else {
            json!("")
        };
        body["IsTouchFreeDelivery"] = json!(false);
        body["IsFinal"] = json!(final_order);
        body["IsCompanyOrder"] = json!(false);
        body["CompanyDescription"] = json!("");
        body["CartCollection"] = json!(js::normalize(items).to_string());
        if let Some(coupon) = cart.get("coupon") {
            body["WebCoupon"] = coupon.clone();
        }
        if final_order {
            for (key, value) in [
                ("AurToken", json!(false)),
                ("AurUserName", json!("")),
                ("CouponApplied", json!(cart.get("coupon").is_some())),
                ("IsPayed", json!(false)),
                ("KassResponse", json!(false)),
                ("KassUserName", json!("")),
                ("PayToken", json!(false)),
                ("PayWithAur", json!(false)),
                ("PayWithPei", json!(false)),
                ("PeiToken", json!(false)),
                ("PayWithStraumur", json!(true)),
                ("PaymentMethod", Value::Null),
                ("CreditUsed", json!(0)),
                ("Total", json!(0)),
                ("Payonline", json!(false)),
                ("PeiPurchaseAccess", json!(false)),
                ("ClientID", Value::Null),
            ] {
                body[key] = value;
            }
        }
        Ok(js::normalize(body).to_string())
    }
    pub(crate) fn quote_order(&self, cart: &Value) -> Result<Value> {
        self.authenticated(false,|session| {
            let response=self.dominos_body("orders",&shapes::QUOTE_RESPONSE,Some(session),Some(self.payload(cart,session,false)?))?;
            if response["Success"]==false || response["Total"].as_i64().unwrap_or(0)<=0 {return Err(Fail::Safe("Domino’s did not return a valid order quote."));}
            let quote=json!({"id":uuid()?,"username":session["username"],"cart":cart,"total":response["Total"],"createdAt":js::now(),"expiresAt":js::now()+300_000});
            self.save_record(&quote)?;
            Ok(json!({"quoteId":quote["id"],"total":quote["total"],"currency":"ISK","expiresAt":iso(&quote["expiresAt"])?,"cart":cart}))
        })
    }
    fn adyen(
        &self,
        checkout: &Value,
        endpoint: &str,
        body: Value,
        schema: &shapes::S,
    ) -> Result<Value> {
        let nonempty = |key| checkout[key].as_str().filter(|s| !s.is_empty());
        let (Some(session_id), Some(_), Some(client_key)) = (
            nonempty("sessionId"),
            nonempty("sessionData"),
            nonempty("clientKey"),
        ) else {
            return Err(Fail::Safe(
                "The payment session is incomplete. No payment was sent.",
            ));
        };
        let url = format!(
            "{}/checkoutshopper/v1/sessions/{}/{endpoint}?clientKey={}",
            self.origins[2],
            js::encode_component(session_id),
            js::encode_query(client_key)
        );
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("application/json"));
        let text = self.text(
            &url,
            Method::POST,
            headers,
            Some(js::normalize(body).to_string()),
        )?;
        js::parse(text.as_bytes())
            .and_then(|v| shapes::parse(schema, &v))
            .ok_or(Fail::Safe(INVALID_RESPONSE))
    }
    pub(crate) fn create_checkout(&self, input: &Value) -> Result<Value> {
        let id = input["quoteId"].as_str().ok_or(Fail::Unknown)?;
        self.record_locked(id,||self.authenticated(false,|session| {
            let mut quote=self.read_record(id,&shapes::QUOTE)?;
            if quote["username"]!=session["username"] || quote["total"]!=input["expectedTotal"] {return Err(Fail::Safe("The quoted account or total does not match. Obtain and review a new quote."));}
            if let Some(existing)=quote.get("checkoutId").and_then(Value::as_str) {return public_checkout(&self.read_record(existing,&shapes::CHECKOUT)?);}
            if quote["expiresAt"].as_f64().unwrap_or(0.0)<=js::now() as f64 {return Err(Fail::Safe("The quote expired. Obtain and review a new quote."));}
            let body=self.payload(&quote["cart"],session,true)?;
            let mut checkout=json!({"id":uuid()?,"quoteId":id,"username":session["username"],"total":quote["total"],"cart":quote["cart"],"state":"creating","expiresAt":quote["expiresAt"],"orderId":null,"cards":[]});
            self.save_record(&checkout)?;
            quote["checkoutId"]=checkout["id"].clone();
            self.save_record(&quote)?;
            let attempt=(||->Result<()> {
                let order=self.dominos_body("orders",&shapes::ORDER_RESPONSE,Some(session),Some(body))?;
                if order["Success"]==false {return Err(Fail::Safe("Domino’s did not accept this checkout. No payment was sent."));}
                checkout["orderId"]=order.get("OrderID").cloned().unwrap_or(Value::Null);
                for (local,remote) in [("orderGuid","OrderGuidId"),("sessionId","AdyenSessionId"),("sessionData","AdyenSessionData"),("clientKey","AdyenClientId")] {checkout[local]=order[remote].clone();}
                self.save_record(&checkout)?;
                let setup=self.adyen(&checkout,"setup",json!({"sessionData":checkout["sessionData"]}),&shapes::SETUP_RESPONSE)?;
                checkout["sessionData"]=setup["sessionData"].clone();
                checkout["cards"]=setup["paymentMethods"].get("storedPaymentMethods").cloned().unwrap_or_else(||json!([]));
                checkout["expiresAt"]=json!(js::date_parse(setup["expiresAt"].as_str().ok_or(Fail::Unknown)?).ok_or(Fail::Unknown)?);
                checkout["state"]=json!(if order["Total"]==quote["total"] && setup["amount"]["value"].as_f64()==quote["total"].as_f64().map(|n|n*100.0) && setup["id"]==checkout["sessionId"] {"ready"}else{"amount_changed"});
                Ok(())
            })();
            if attempt.is_err() {checkout["state"]=json!("unknown");}
            self.save_record(&checkout)?;
            public_checkout(&checkout)
        }))
    }
    pub(crate) fn get_checkout(&self, input: &Value) -> Result<Value> {
        let id = input["checkoutId"].as_str().ok_or(Fail::Unknown)?;
        self.record_locked(id, || {
            self.authenticated(true, |session| {
                let mut checkout = self.read_record(id, &shapes::CHECKOUT)?;
                if checkout["username"] != session["username"] {
                    return Err(Fail::Safe(
                        "This checkout belongs to a different Domino’s account.",
                    ));
                }
                if let Some(guid) = checkout
                    .get("orderGuid")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    && checkout["state"] != "ready"
                    && checkout["state"] != "amount_changed"
                {
                    let latest = self.dominos(
                        &format!(
                            "orders/cart/latest?orderGuid={}",
                            js::encode_component(guid)
                        ),
                        &shapes::LATEST_CART,
                        Some(session),
                    )?;
                    if latest["OrderData"]["IsPayed"] == true {
                        checkout["state"] = json!("authorised");
                        self.save_record(&checkout)?;
                    }
                }
                public_checkout(&checkout)
            })
        })
    }
    pub(crate) fn pay_saved_card(&self, input: &Value) -> Result<Value> {
        let id = input["checkoutId"].as_str().ok_or(Fail::Unknown)?;
        self.record_locked(id,||self.authenticated(false,|session| {
            let mut checkout=self.read_record(id,&shapes::CHECKOUT)?;
            if checkout["username"]!=session["username"] || checkout["total"]!=input["expectedTotal"] {return Err(Fail::Safe("The checkout account or amount differs from the confirmed order. No payment was sent."));}
            if checkout["state"]!="ready" {return public_checkout(&checkout);}
            if checkout["expiresAt"].as_f64().unwrap_or(0.0)<=js::now() as f64 {return Err(Fail::Safe("The payment session expired. No payment was sent."));}
            let card_index=input["cardId"].as_str().and_then(|s|s.strip_prefix("card_")).and_then(|s|s.parse::<f64>().ok()).filter(|n|*n>=1.0 && *n<=usize::MAX as f64).map(|n|n as usize-1);
            let card=card_index.and_then(|at|checkout["cards"].as_array()?.get(at)).ok_or(Fail::Safe("Saved card not found in this checkout. No payment was sent."))?.clone();
            checkout["state"]=json!("submitting");
            self.save_record(&checkout)?;
            let attempt=self.adyen(&checkout,"payments",json!({"sessionData":checkout.get("sessionData"),"paymentMethod":{"type":"scheme","storedPaymentMethodId":card["id"]},"storePaymentMethod":false}),&shapes::PAYMENT_RESPONSE);
            match attempt {
                Ok(response) => {
                    checkout["sessionData"]=response["sessionData"].clone();
                    checkout["resultCode"]=response["resultCode"].clone();
                    checkout["state"]=json!(if response.get("action").is_some() {"requires_action"}else{match response["resultCode"].as_str().unwrap_or_default() {"Authorised"=>"authorised","Refused"|"Cancelled"|"Error"=>"refused",_=>"pending"}});
                }
                Err(_) => checkout["state"]=json!("unknown"),
            }
            self.save_record(&checkout)?;
            public_checkout(&checkout)
        }))
    }
}
