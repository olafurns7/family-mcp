use mcp_runtime::input::{Parse, object};
use serde_json::{Map, Value, json};
const SAFE: f64 = 9_007_199_254_740_991.0;
pub const KINDS: [&str; 5] = ["pizza", "side", "sauce", "beverage", "offer"];

fn integer(
    parse: &mut Parse,
    value: Option<&Value>,
    min: Option<i64>,
    max: Option<i64>,
) -> Option<i64> {
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
    if let Some(min) = min.filter(|min| number < *min as f64) {
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
        "quote_order" => cart(args),
        "create_checkout" | "get_checkout" | "pay_saved_card" => money_tool(name, args),
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
                    integer(&mut p.at("offset"), a.get("offset"), Some(0), None).unwrap_or(0)
                } else {
                    0
                });
                out["limit"] = json!(if a.contains_key("limit") {
                    integer(&mut p.at("limit"), a.get("limit"), Some(1), Some(50)).unwrap_or(20)
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

pub fn uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, b)| {
            if [8, 13, 18, 23].contains(&at) {
                *b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
        && ((b'1'..=b'8').contains(&bytes[14]) && b"89aAbB".contains(&bytes[19])
            || text == "00000000-0000-0000-0000-000000000000"
            || text.eq_ignore_ascii_case("ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
fn local_id(p: &mut Parse, value: Option<&Value>) -> Option<String> {
    let text = p.string(value, (0, usize::MAX));
    if text.as_deref().is_some_and(|s| !uuid(s)) {
        p.issue("Invalid UUID".into(), true);
    }
    text
}
fn money_tool(name: &str, args: &Map<String, Value>) -> Result<Value, String> {
    let fields: &[&str] = match name {
        "create_checkout" => &["quoteId", "expectedTotal"],
        "get_checkout" => &["checkoutId"],
        _ => &["checkoutId", "cardId", "expectedTotal", "confirm"],
    };
    object(
        args,
        fields,
        |p, a| {
            let mut out = Map::new();
            for key in fields {
                let mut at = p.at(key);
                let value = a.get(*key);
                let parsed = match *key {
                    "quoteId" | "checkoutId" => json!(local_id(&mut at, value)),
                    "cardId" => {
                        let text = at.string(value, (0, usize::MAX));
                        pattern(&mut at, text.as_deref(), r"/^card_\d+$/", |s| {
                            s.strip_prefix("card_").is_some_and(|s| {
                                !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
                            })
                        });
                        json!(text)
                    }
                    "expectedTotal" => json!(integer(&mut at, value, Some(0), Some(1_000_000))),
                    _ => {
                        if value != Some(&Value::Bool(true)) {
                            at.issue("Invalid input: expected true".into(), false);
                        }
                        json!(true)
                    }
                };
                out.insert((*key).into(), parsed);
            }
            Value::Object(out)
        },
        |_| None,
    )
}
fn strict(
    p: &mut Parse,
    value: Option<&Value>,
    fields: &[&str],
    work: impl FnOnce(&mut Parse, &Map<String, Value>) -> Value,
) -> Option<Value> {
    let Some(a) = value.and_then(Value::as_object) else {
        p.wrong_type("object", value);
        return None;
    };
    let out = work(p, a);
    let unknown = js_keys(a)
        .into_iter()
        .filter(|k| !fields.contains(&k.as_str()))
        .map(|k| json!(k).to_string())
        .collect::<Vec<_>>();
    if !unknown.is_empty() {
        p.issue(
            format!(
                "Unrecognized key{}: {}",
                if unknown.len() > 1 { "s" } else { "" },
                unknown.join(", ")
            ),
            true,
        );
    }
    Some(out)
}
fn js_keys(a: &Map<String, Value>) -> Vec<String> {
    crate::js::order(a.clone())
        .into_iter()
        .map(|(k, _)| k)
        .collect()
}
fn default_array(
    p: &mut Parse,
    a: &Map<String, Value>,
    key: &str,
    bounds: (usize, usize),
    element: impl FnMut(&mut Parse, &Value) -> Option<Value>,
) -> Value {
    if let Some(value) = a.get(key) {
        json!(p.at(key).array(Some(value), bounds, element))
    } else {
        json!([])
    }
}
fn quantity(p: &mut Parse, a: &Map<String, Value>) -> Value {
    json!(if a.contains_key("quantity") {
        integer(&mut p.at("quantity"), a.get("quantity"), Some(1), Some(20))
    } else {
        Some(1)
    })
}
fn pizza(p: &mut Parse, v: &Value, packaged: bool) -> Option<Value> {
    let keys: &[&str] = if packaged {
        &["quantity", "sizeId", "crustId", "sections", "packageItemId"]
    } else {
        &["quantity", "sizeId", "crustId", "sections"]
    };
    strict(p, Some(v), keys, |p, a| {
        let count = quantity(p, a);
        let size = id(&mut p.at("sizeId"), a.get("sizeId"));
        let crust = id(&mut p.at("crustId"), a.get("crustId"));
        let sections = p.at("sections").array(a.get("sections"), (1, 2), |p, v| {
            strict(p, Some(v), &["pizzaId", "modifications"], |p, a| {
                let pizza = id(&mut p.at("pizzaId"), a.get("pizzaId"));
                let modifications = default_array(p, a, "modifications", (0, 40), |p, v| {
                    strict(p, Some(v), &["toppingId", "quantity"], |p, a| {
                        let topping = id(&mut p.at("toppingId"), a.get("toppingId"));
                        let value = a.get("quantity");
                        if !value
                            .and_then(Value::as_f64)
                            .is_some_and(|n| [0.0, 0.5, 0.75, 1.0, 2.0].contains(&n))
                        {
                            p.at("quantity").issue("Invalid input".into(), false);
                        }
                        json!({"toppingId":topping,"quantity":value})
                    })
                });
                json!({"pizzaId":pizza,"modifications":modifications})
            })
        });
        let mut out = json!({"quantity":count,"sizeId":size,"crustId":crust,"sections":sections});
        if packaged {
            out["packageItemId"] = json!(id(&mut p.at("packageItemId"), a.get("packageItemId")));
        }
        out
    })
}
fn side(p: &mut Parse, v: &Value, packaged: bool) -> Option<Value> {
    let keys: &[&str] = if packaged {
        &["id", "quantity", "extraId", "packageItemId"]
    } else {
        &["id", "quantity", "extraId"]
    };
    strict(p, Some(v), keys, |p, a| {
        let item = id(&mut p.at("id"), a.get("id"));
        let count = quantity(p, a);
        let mut out = json!({"id":item,"quantity":count});
        if a.contains_key("extraId") {
            out["extraId"] = json!(id(&mut p.at("extraId"), a.get("extraId")));
        }
        if packaged {
            out["packageItemId"] = json!(id(&mut p.at("packageItemId"), a.get("packageItemId")));
        }
        out
    })
}
fn beverage(p: &mut Parse, v: &Value, packaged: bool) -> Option<Value> {
    let keys: &[&str] = if packaged {
        &["id", "sizeId", "quantity", "packageItemId"]
    } else {
        &["id", "sizeId", "quantity"]
    };
    strict(p, Some(v), keys, |p, a| {
        let item = id(&mut p.at("id"), a.get("id"));
        let size = id(&mut p.at("sizeId"), a.get("sizeId"));
        let count = quantity(p, a);
        let mut out = json!({"id":item,"sizeId":size,"quantity":count});
        if packaged {
            out["packageItemId"] = json!(id(&mut p.at("packageItemId"), a.get("packageItemId")));
        }
        out
    })
}
fn package(p: &mut Parse, v: &Value) -> Option<Value> {
    strict(
        p,
        Some(v),
        &["id", "quantity", "pizzas", "sides", "beverages"],
        |p, a| {
            let item = id(&mut p.at("id"), a.get("id"));
            let count = quantity(p, a);
            let pizzas = default_array(p, a, "pizzas", (0, 10), |p, v| pizza(p, v, true));
            let sides = default_array(p, a, "sides", (0, 10), |p, v| side(p, v, true));
            let beverages = default_array(p, a, "beverages", (0, 10), |p, v| beverage(p, v, true));
            json!({"id":item,"quantity":count,"pizzas":pizzas,"sides":sides,"beverages":beverages})
        },
    )
}
fn cart_fields(p: &mut Parse, a: &Map<String, Value>) -> Value {
    let fulfillment = {
        let mut at = p.at("fulfillment");
        let v = a.get("fulfillment");
        if let Some(obj) = v.and_then(Value::as_object) {
            match obj.get("type").and_then(Value::as_str) {
                Some("pickup") => {
                    strict(&mut at, v, &["type", "storeId", "instructions"], |p, a| {
                        let store = id(&mut p.at("storeId"), a.get("storeId"));
                        let instructions = if a.contains_key("instructions") {
                            p.at("instructions").string(a.get("instructions"), (0, 300))
                        } else {
                            Some(String::new())
                        };
                        json!({"type":"pickup","storeId":store,"instructions":instructions})
                    })
                }
                Some("delivery") => {
                    strict(&mut at, v, &["type", "address", "instructions"], |p, a| {
                        let address = strict(
                            &mut p.at("address"),
                            a.get("address"),
                            &["ID", "Name", "PostalCode", "PostalCodeName"],
                            |p, a| {
                                let id = integer(&mut p.at("ID"), a.get("ID"), None, None);
                                if id.is_some_and(|n| n <= 0) {
                                    p.at("ID")
                                        .issue("Too small: expected number to be >0".into(), true);
                                }
                                let name = p.at("Name").string(a.get("Name"), (0, usize::MAX));
                                let code = p
                                    .at("PostalCode")
                                    .string(a.get("PostalCode"), (0, usize::MAX));
                                let city = p
                                    .at("PostalCodeName")
                                    .string(a.get("PostalCodeName"), (0, usize::MAX));
                                json!({"ID":id,"Name":name,"PostalCode":code,"PostalCodeName":city})
                            },
                        );
                        let instructions = if a.contains_key("instructions") {
                            p.at("instructions").string(a.get("instructions"), (0, 300))
                        } else {
                            Some(String::new())
                        };
                        json!({"type":"delivery","address":address,"instructions":instructions})
                    })
                }
                _ => {
                    at.at("type").issue(
                        "Invalid discriminator value. Expected 'pickup' | 'delivery'".into(),
                        false,
                    );
                    None
                }
            }
        } else {
            at.wrong_type("object", v);
            None
        }
    };
    let pizzas = default_array(p, a, "pizzas", (0, 20), |p, v| pizza(p, v, false));
    let sides = default_array(p, a, "sides", (0, 20), |p, v| side(p, v, false));
    let beverages = default_array(p, a, "beverages", (0, 20), |p, v| beverage(p, v, false));
    let packages = default_array(p, a, "packages", (0, 20), package);
    let mut out = json!({"fulfillment":fulfillment,"pizzas":pizzas,"sides":sides,"beverages":beverages,"packages":packages});
    if a.contains_key("coupon") {
        out["coupon"] = json!(p.at("coupon").string(a.get("coupon"), (1, 80)));
    }
    out
}
pub fn cart(args: &Map<String, Value>) -> Result<Value, String> {
    object(
        args,
        &[
            "fulfillment",
            "pizzas",
            "sides",
            "beverages",
            "packages",
            "coupon",
        ],
        cart_fields,
        |out| {
            (["pizzas", "sides", "beverages", "packages"]
                .iter()
                .map(|key| out[key].as_array().map_or(0, Vec::len))
                .sum::<usize>()
                == 0)
                .then_some("Cart is empty.")
        },
    )
}
