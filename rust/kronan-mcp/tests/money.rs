//! The money cases of tests/ts/integration.test.ts and interop.test.ts, executed against this
//! binary without Bun: each drop-in client call is a tool call to a fresh `serve` (or one long
//! `serve` where the case uses one), against a loopback Krónan whose answers default to the frozen
//! TypeScript fixture answers. Each case checks the requests sent (method and path, in order), the
//! order-attempt record and the files left, and the messages the TypeScript case matched. Needs the
//! `test-origin` feature.
#![cfg(feature = "test-origin")]

mod support;

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use support::{Home, Mcp, Reply, Request, Upstream, fixture, fixture_json};

const TOKEN: &str = "synthetic-token-0123456789";

const ORDER_TOKEN: &str = "123e4567-e89b-12d3-a456-426614174001";

const LIST_TOKEN: &str = "123e4567-e89b-12d3-a456-426614174002";

const CHECKOUT_TOKEN: &str = "123e4567-e89b-12d3-a456-426614174006";

const CHECKOUT_TOTAL: i64 = 1489;

/// The legacy token file the binary reads by default, and the order-attempt record beside it.
const LEGACY: &str = ".config/kronan-mcp/session.json";

const JOURNAL: &str = ".config/kronan-mcp/session.json.order-attempts.json";

const NOTHING_SENT: &str = "Nothing was sent to Krónan";

fn approval() -> Value {
    json!({"confirm": true, "expectedTotal": CHECKOUT_TOTAL, "expectedCheckoutToken": CHECKOUT_TOKEN})
}

/// `base` with `extra`'s keys added or replaced.
fn with(base: &Value, extra: Value) -> Value {
    let mut merged = base.as_object().unwrap().clone();
    merged.extend(extra.as_object().unwrap().clone());
    Value::Object(merged)
}

/// integration.test.ts `placements`: each money tool, its path, and its call for an approval.
fn placements() -> [(&'static str, &'static str, Value); 4] {
    [
        (
            "reserve_delivery_slot",
            "/slots/delivery/reserve/",
            json!({"slotId": 501, "addressId": 11, "returnBags": false}),
        ),
        (
            "reserve_pickup_slot",
            "/slots/pickup/reserve/",
            json!({"slotId": 601, "returnBags": false}),
        ),
        (
            "complete_checkout",
            "/checkout/complete/",
            json!({"slotId": 501, "addressId": 11, "returnBags": false}),
        ),
        (
            "add_checkout_to_order",
            "/checkout/add-to-order/",
            json!({"expectedOrderToken": ORDER_TOKEN}),
        ),
    ]
}

/// A home with the legacy token file.
fn home(name: &str) -> Home {
    let home = Home::new(name);
    home.write(
        LEGACY,
        &format!("{{\"version\":1,\"token\":\"{TOKEN}\"}}\n"),
        None,
    );
    home
}

/// integration.test.ts `scriptedClient`: `script` answers chosen requests, the fixture the rest.
fn scripted(script: impl Fn(&Request) -> Option<Reply> + Send + Sync + 'static) -> Upstream {
    Upstream::new(move |request| script(request).unwrap_or_else(|| fixture(&request.path)))
}

/// A tool answer as the drop-in client sees it: structured content, or the error text.
fn outcome(answer: &Value) -> Result<Value, String> {
    assert!(answer.get("error").is_none(), "{answer}");
    let result = &answer["result"];

    if result["isError"] == true {
        Err(result["content"][0]["text"].as_str().unwrap().to_owned())
    } else {
        Ok(result["structuredContent"].clone())
    }
}

/// One tool call to a fresh `serve`, as the drop-in client's methods make it. Its answer never
/// discloses the token.
fn call(home: &Home, upstream: &Upstream, tool: &str, arguments: Value) -> Result<Value, String> {
    let (mut mcp, _) = Mcp::start(home, &upstream.origin, &[]);
    let answer = mcp.call(tool, arguments).answer;
    let (code, stderr) = mcp.close();
    assert_eq!(code, Some(0), "{stderr}");
    assert!(!answer.to_string().contains(TOKEN), "{answer}");
    outcome(&answer)
}

/// The order-attempt record's attempts, or None without a record.
fn journal(home: &Home) -> Option<Vec<Value>> {
    let text = fs::read_to_string(home.path(JOURNAL)).ok()?;
    let record: Value = serde_json::from_str(&text).unwrap();
    Some(record["attempts"].as_array().unwrap().clone())
}

/// The names under `.config/kronan-mcp`.
fn left(home: &Home) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(home.path(".config/kronan-mcp"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    names
}

fn only_the_token(home: &Home) {
    assert_eq!(left(home), ["session.json"]);
}

/// `message` holds each part, in order (a TypeScript `a.*b` pattern).
fn matches(message: &str, parts: &[&str]) -> bool {
    let mut rest = message;

    for part in parts {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

fn posts(sent: &[String]) -> Vec<String> {
    sent.iter()
        .filter(|entry| entry.starts_with("POST"))
        .cloned()
        .collect()
}

/// The fixture checkout, which the gate reads.
fn checkout() -> Value {
    fixture_json("/api/v1/checkout/")
}

#[test]
fn the_money_gate_refuses_without_sending_a_charge_bearing_request() {
    let home = home("gate");
    let current = Arc::new(Mutex::new(checkout()));
    let state = current.clone();
    let upstream = scripted(move |request| {
        (request.path == "/api/v1/checkout/")
            .then(|| Reply::json(200, &state.lock().unwrap().clone()))
    });
    let empty = with(&checkout(), json!({"lines": [], "total": 0}));
    let refusals = [
        (
            "total mismatch",
            checkout(),
            with(&approval(), json!({"expectedTotal": CHECKOUT_TOTAL - 1})),
            "total differs",
        ),
        (
            "token mismatch",
            checkout(),
            with(&approval(), json!({"expectedCheckoutToken": LIST_TOKEN})),
            "checkout token differs",
        ),
        (
            "empty checkout",
            empty,
            with(&approval(), json!({"expectedTotal": 0})),
            "checkout is empty",
        ),
    ];

    for (tool, _, arguments) in placements() {
        for (label, state, gate, pattern) in &refusals {
            *current.lock().unwrap() = state.clone();
            let before = upstream.count();
            let message = call(&home, &upstream, tool, with(gate, arguments.clone())).unwrap_err();
            assert!(message.contains(pattern), "{tool}: {label}: {message}");
            assert!(message.contains(NOTHING_SENT), "{tool}: {label}: {message}");
            assert!(message.contains("no order was placed"), "{message}");
            assert_eq!(
                upstream.sent()[before..],
                ["GET /checkout/"],
                "{tool}: {label}"
            );
        }
    }
    assert_eq!(posts(&upstream.sent()), Vec::<String>::new());
    // A refused gate records nothing, so it never blocks a later, corrected approval.
    assert_eq!(journal(&home), None);
    only_the_token(&home);
}

#[test]
fn money_and_destructive_tools_without_confirm_send_nothing() {
    let home = home("confirm");
    let upstream = scripted(|_| None);
    let mut unconfirmed = approval();
    unconfirmed.as_object_mut().unwrap().remove("confirm");
    let calls = [
        (
            "reserve_delivery_slot",
            with(
                &unconfirmed,
                json!({"slotId": 501, "addressId": 11, "returnBags": false}),
            ),
        ),
        (
            "reserve_pickup_slot",
            with(&unconfirmed, json!({"slotId": 601, "returnBags": false})),
        ),
        (
            "complete_checkout",
            with(&unconfirmed, json!({"slotId": 501, "returnBags": false})),
        ),
        (
            "add_checkout_to_order",
            with(&unconfirmed, json!({"expectedOrderToken": ORDER_TOKEN})),
        ),
        ("clear_shopping_note", json!({})),
        (
            "delete_order_lines",
            json!({"orderToken": ORDER_TOKEN, "lineIds": [1]}),
        ),
        (
            "lower_order_line_quantities",
            json!({"orderToken": ORDER_TOKEN, "lineIds": [1], "quantity": 0}),
        ),
    ];
    // One server, as the case connects one client.
    let (mut mcp, _) = Mcp::start(&home, &upstream.origin, &[]);

    for (tool, arguments) in &calls {
        for confirm in [None, Some(json!(false)), Some(json!("true"))] {
            let arguments = match &confirm {
                None => arguments.clone(),
                Some(confirm) => with(arguments, json!({"confirm": confirm})),
            };
            let answer = mcp.call(tool, arguments).answer;
            assert!(outcome(&answer).is_err(), "{tool} {confirm:?}: {answer}");
        }
    }
    let (code, stderr) = mcp.close();
    assert_eq!(code, Some(0), "{stderr}");
    assert_eq!(upstream.sent(), Vec::<String>::new());
    assert_eq!(journal(&home), None);
    only_the_token(&home);
}

#[test]
fn add_checkout_to_order_refuses_an_absent_or_different_active_order() {
    let home = home("active");
    let active = Arc::new(Mutex::new(Reply::empty(404)));
    let state = active.clone();
    let upstream = scripted(move |request| {
        (request.path == "/api/v1/orders/currently-active/").then(|| state.lock().unwrap().clone())
    });
    let differs = with(
        &fixture_json("/api/v1/orders/currently-active/"),
        json!({"orderToken": LIST_TOKEN}),
    );

    for (reply, pattern) in [
        (Reply::empty(404), "no active order"),
        (Reply::json(200, &differs), "active order differs"),
    ] {
        *active.lock().unwrap() = reply;
        let before = upstream.count();
        let arguments = with(&approval(), json!({"expectedOrderToken": ORDER_TOKEN}));
        let message = call(&home, &upstream, "add_checkout_to_order", arguments).unwrap_err();
        assert!(message.contains(pattern), "{message}");
        assert!(message.contains(NOTHING_SENT), "{message}");
        assert_eq!(
            upstream.sent()[before..],
            ["GET /checkout/", "GET /orders/currently-active/"]
        );
    }
    assert_eq!(journal(&home), None);
    only_the_token(&home);
}

#[test]
fn ambiguous_money_outcomes_are_unknown_after_exactly_one_request() {
    let home = home("ambiguous");
    let failure = Arc::new(Mutex::new(Reply::dropped()));
    let state = failure.clone();
    let upstream =
        scripted(move |request| (request.method == "POST").then(|| state.lock().unwrap().clone()));
    // The upstream may have accepted the request before any of these; none proves a refusal. A
    // failed fetch (a network error or a timeout) reaches the binary as a dropped connection.
    let ambiguous = [
        ("network error", Reply::dropped()),
        ("timeout", Reply::dropped()),
        ("server error", Reply::text(502, TOKEN)),
        ("unparsable body", Reply::text(201, "{not json")),
        (
            "undocumented body",
            Reply::json(201, &json!({"orderToken": ORDER_TOKEN})),
        ),
        ("accepted then 400", Reply::text(400, TOKEN)),
        ("accepted then 408", Reply::text(408, TOKEN)),
        ("accepted then 409", Reply::text(409, TOKEN)),
        ("accepted then 422", Reply::text(422, TOKEN)),
        ("accepted then 429", Reply::text(429, TOKEN)),
        ("accepted then 401", Reply::text(401, TOKEN)),
    ];

    for (tool, path, arguments) in placements() {
        for (label, reply) in &ambiguous {
            // Each case is a fresh approval; the record rules are tested separately.
            let _ = fs::remove_file(home.path(JOURNAL));
            *failure.lock().unwrap() = reply.clone();
            let before = upstream.count();
            let placed = call(&home, &upstream, tool, with(&approval(), arguments.clone()))
                .unwrap_or_else(|message| panic!("{tool}: {label}: {message}"));
            assert_eq!(placed["outcome"], "unknown", "{tool}: {label}");
            let message = placed["message"].as_str().unwrap();
            assert!(
                matches(
                    message,
                    &["Outcome unknown", "do not retry or place another order"]
                ),
                "{message}"
            );
            assert!(
                !message.contains("Nothing was sent") && !message.contains("no order was placed")
            );
            assert_eq!(
                posts(&upstream.sent()[before..]),
                [format!("POST {path}")],
                "{tool}: {label}"
            );
            // Exactly one attempt, recorded as unknown for this tool and checkout.
            let attempts = journal(&home).unwrap();
            assert_eq!(attempts.len(), 1, "{tool}: {label}");
            assert_eq!(attempts[0]["tool"], tool);
            assert_eq!(attempts[0]["state"], "unknown", "{tool}: {label}");
            assert_eq!(attempts[0]["checkoutToken"], CHECKOUT_TOKEN);
            assert_eq!(
                left(&home),
                ["session.json", "session.json.order-attempts.json"]
            );
        }
    }
}

#[test]
fn an_unknown_money_outcome_is_a_validated_result_not_an_error() {
    let home = home("validated");
    let upstream = scripted(|request| (request.method == "POST").then(|| Reply::text(502, TOKEN)));
    let calls = [
        (
            "reserve_delivery_slot",
            json!({"slotId": 501, "addressId": 11, "returnBags": false}),
        ),
        (
            "reserve_pickup_slot",
            json!({"slotId": 601, "returnBags": false}),
        ),
        (
            "complete_checkout",
            json!({"slotId": 501, "returnBags": false}),
        ),
        (
            "add_checkout_to_order",
            json!({"expectedOrderToken": ORDER_TOKEN}),
        ),
    ];
    // One server for every call: the record removed between them is read again each time.
    let (mut mcp, _) = Mcp::start(&home, &upstream.origin, &[]);

    for (tool, arguments) in calls {
        let _ = fs::remove_file(home.path(JOURNAL));
        let before = upstream.count();
        let answer = mcp.call(tool, with(&approval(), arguments)).answer;
        assert!(!answer.to_string().contains(TOKEN), "{answer}");
        assert_ne!(answer["result"]["isError"], true, "{tool}: {answer}");
        let structured = &answer["result"]["structuredContent"];
        assert_eq!(structured["outcome"], "unknown", "{tool}");
        assert!(matches(
            &structured.to_string(),
            &["Outcome unknown", "do not retry or place another order"]
        ));
        assert_eq!(posts(&upstream.sent()[before..]).len(), 1, "{tool}");
        assert_eq!(journal(&home).unwrap()[0]["state"], "unknown", "{tool}");
    }
    let (code, stderr) = mcp.close();
    assert_eq!(code, Some(0), "{stderr}");
}

#[test]
fn a_failed_gate_read_refuses_the_money_call_without_sending() {
    let home = home("gate-read");
    let upstream =
        scripted(|request| (request.path == "/api/v1/checkout/").then(|| Reply::text(503, TOKEN)));

    for (tool, _, arguments) in placements() {
        let before = upstream.count();
        let message = call(&home, &upstream, tool, with(&approval(), arguments)).unwrap_err();
        assert!(message.contains(NOTHING_SENT), "{tool}: {message}");
        assert!(message.contains("Could not read the checkout"), "{message}");
        assert_eq!(upstream.sent()[before..], ["GET /checkout/"], "{tool}");
    }
    assert_eq!(journal(&home), None);
    only_the_token(&home);
}

// The binary reads the saved token once, in the gate, and sends the order call with it (api.rs
// `place`), an intended difference from api.ts that the drop-in case pins.
#[test]
fn an_unreadable_token_refuses_the_money_call_before_any_record_or_send() {
    let unreadable = "Cannot read the Krónan token file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.";

    for (tool, path, arguments) in placements() {
        let home = home("unreadable");
        let token: PathBuf = home.path(LEGACY);
        let mode = |mode| fs::set_permissions(&token, fs::Permissions::from_mode(mode)).unwrap();

        // A token file a group can read: refused before the gate.
        mode(0o640);
        let upstream = scripted(|_| None);
        let message = call(&home, &upstream, tool, with(&approval(), arguments.clone()));
        assert_eq!(message, Err(unreadable.to_owned()), "{tool}");
        assert_eq!(upstream.sent(), Vec::<String>::new(), "{tool}");
        assert_eq!(journal(&home), None, "{tool}");

        // The same failure once the gate has read the live checkout: the order call is still sent
        // once, with the token the gate read, and recorded as accepted.
        let later_token = token.clone();
        let later = scripted(move |request| {
            if request.method == "GET" && request.path == "/api/v1/checkout/" {
                fs::set_permissions(&later_token, fs::Permissions::from_mode(0o640)).unwrap();
            }
            None
        });
        mode(0o600);
        let placed = call(&home, &later, tool, with(&approval(), arguments)).unwrap();
        assert_eq!(placed["outcome"], "accepted", "{tool}");
        assert_eq!(posts(&later.sent()), [format!("POST {path}")], "{tool}");
        let attempts = journal(&home).unwrap();
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0]["state"], "accepted", "{tool}");
        assert_eq!(
            left(&home),
            ["session.json", "session.json.order-attempts.json"]
        );
    }
}

/// Tool calls with their arguments.
type Writes<'a> = &'a [(&'a str, Value)];

#[test]
fn other_writes_are_sent_once_and_report_an_unconfirmed_change() {
    let home = home("writes");
    // 0 stands for a connection failure after the request was sent.
    let status = Arc::new(Mutex::new(0u16));
    let state = status.clone();
    let upstream = scripted(move |request| {
        if request.method == "GET" {
            return None;
        }
        Some(match *state.lock().unwrap() {
            0 => Reply::dropped(),
            404 => Reply::empty(404),
            status => Reply::text(status, TOKEN),
        })
    });
    let note_and_basket = [
        (
            "add_shopping_note_lines",
            json!({"lines": [{"text": "Eggs"}]}),
        ),
        ("clear_shopping_note", json!({"confirm": true})),
        (
            "set_checkout_lines",
            json!({"lines": [{"sku": "SKU-1"}], "replace": false}),
        ),
    ];
    // Placed-order changes move money; after sending, no status proves they were not applied.
    let order_changes = [
        (
            "delete_order_lines",
            json!({"orderToken": ORDER_TOKEN, "lineIds": [1], "confirm": true}),
        ),
        (
            "lower_order_line_quantities",
            json!({"orderToken": ORDER_TOKEN, "lineIds": [1], "quantity": 0, "confirm": true}),
        ),
        (
            "toggle_order_line_substitution",
            json!({"orderToken": ORDER_TOKEN, "lineIds": [1]}),
        ),
    ];
    let order_pattern: &[&str] =
        &["did not confirm this order change; it may have been applied. Read get_order"];
    let mut expectations: Vec<(u16, &[&str], Writes)> = vec![
        (
            0,
            &["did not confirm this change", "may have been applied"],
            &note_and_basket,
        ),
        (500, &["did not confirm this change"], &note_and_basket),
        (
            400,
            &["refused the request; nothing was changed"],
            &note_and_basket,
        ),
    ];

    for code in [0, 400, 404, 409, 422, 429, 500] {
        expectations.push((code, order_pattern, &order_changes));
    }

    for (code, pattern, writes) in expectations {
        *status.lock().unwrap() = code;

        for (tool, arguments) in writes {
            let before = upstream.count();
            let message = call(&home, &upstream, tool, arguments.clone()).unwrap_err();
            assert!(matches(&message, pattern), "{tool} {code}: {message}");
            assert!(!message.contains("Check the connection and try again"));
            let sent = upstream.sent()[before..].to_vec();
            assert_eq!(sent.len(), 1, "{tool} {code}: {sent:?}");
            assert!(!sent[0].starts_with("GET"), "{tool} {code}: {sent:?}");
        }
    }
    assert_eq!(journal(&home), None);
    only_the_token(&home);
}
