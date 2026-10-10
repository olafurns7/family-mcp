use mcp_runtime::input::{Parse, object};
use serde_json::{Map, Value, json};
const SAFE: f64 = 9_007_199_254_740_991.0;
pub const KINDS: [&str; 5] = ["pizza", "side", "sauce", "beverage", "offer"];

fn integer(parse: &mut Parse, value: Option<&Value>, min: i64, max: Option<i64>) -> Option<i64> {
    let Some(number) = value.and_then(Value::as_f64) else {
        parse.wrong_type("number", value);
        return None;
    };
    if number.fract() != 0.0 {
        parse.wrong_type("int", value);
        return None;
    }
    if number > SAFE {
        parse.issue(format!("Too big: expected int to be <={SAFE}"), true);
    } else if number < -SAFE {
        parse.issue(format!("Too small: expected int to be >=-{SAFE}"), true);
    }
    if number < min as f64 {
        parse.issue(format!("Too small: expected number to be >={min}"), true);
    }
    if let Some(max) = max.filter(|max| number > *max as f64) {
        parse.issue(format!("Too big: expected number to be <={max}"), true);
    }
    Some(number as i64)
}
fn kind(parse: &mut Parse, value: Option<&Value>) -> Option<String> {
    let found = value.and_then(Value::as_str).filter(|s| KINDS.contains(s));
    if found.is_none() {
        parse.issue(
            "Invalid option: expected one of \"pizza\"|\"side\"|\"sauce\"|\"beverage\"|\"offer\""
                .into(),
            false,
        );
    }
    found.map(str::to_owned)
}
fn pattern(
    parse: &mut Parse,
    value: Option<&str>,
    expression: &str,
    matches: impl Fn(&str) -> bool,
) {
    if value.is_some_and(|s| !matches(s)) {
        parse.issue(
            format!("Invalid string: must match pattern {expression}"),
            true,
        );
    }
}
fn id(parse: &mut Parse, value: Option<&Value>) -> Option<String> {
    let text = parse.string(value, (1, 80));
    pattern(parse, text.as_deref(), "/^[A-Za-z0-9_-]+$/", |s| {
        !s.is_empty()
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
    });
    text
}
pub fn parse(name: &str, args: &Map<String, Value>) -> Result<Value, String> {
    match name {
        "search_menu" => object(
            args,
            &["query", "kind", "offset", "limit"],
            |p, a| {
                let query = if a.contains_key("query") {
                    p.at("query")
                        .string(a.get("query"), (0, 100))
                        .unwrap_or_default()
                } else {
                    String::new()
                };
                let mut out = json!({"query": query});
                if a.contains_key("kind") {
                    out["kind"] = json!(kind(&mut p.at("kind"), a.get("kind")));
                }
                out["offset"] = json!(if a.contains_key("offset") {
                    integer(&mut p.at("offset"), a.get("offset"), 0, None).unwrap_or(0)
                } else {
                    0
                });
                out["limit"] = json!(if a.contains_key("limit") {
                    integer(&mut p.at("limit"), a.get("limit"), 1, Some(50)).unwrap_or(20)
                } else {
                    20
                });
                out
            },
            |_| None,
        ),
        "get_menu_item" => object(
            args,
            &["kind", "id"],
            |p, a| json!({"kind":kind(&mut p.at("kind"),a.get("kind")),"id":id(&mut p.at("id"),a.get("id"))}),
            |_| None,
        ),
        "search_addresses" => object(
            args,
            &["query"],
            |p, a| json!({"query":p.at("query").string(a.get("query"),(2,100))}),
            |_| None,
        ),
        "get_delivery_store" => object(
            args,
            &["address", "postalCode"],
            |p, a| {
                let address = p.at("address").string(a.get("address"), (1, 200));
                let mut postal = p.at("postalCode");
                let code = postal.string(a.get("postalCode"), (0, usize::MAX));
                pattern(&mut postal, code.as_deref(), r"/^\d{3}$/", |s| {
                    s.len() == 3 && s.bytes().all(|b| b.is_ascii_digit())
                });
                json!({"address":address,"postalCode":code})
            },
            |_| None,
        ),
        _ => mcp_runtime::input::empty(args).map(|()| json!({})),
    }
}
