use crate::error::{Fail, Result};
use crate::{js, shapes};
use serde_json::Value;

/// Extract one JSON object in a single pass; no page script is evaluated.
pub fn parse_menu(html: &str) -> Result<Value> {
    let marker = html
        .find("ReactDOM.hydrate(")
        .ok_or(Fail::Safe("Domino’s menu data is missing from the page."))?;
    let start = html[marker..]
        .find('{')
        .map(|start| marker + start)
        .ok_or(Fail::Safe("Domino’s menu data is missing from the page."))?;
    let (mut depth, mut quoted, mut escaped) = (0usize, false, false);
    for (offset, byte) in html.as_bytes()[start..].iter().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if *byte == b'\\' {
                escaped = true;
            } else if *byte == b'"' {
                quoted = false;
            }
        } else if *byte == b'"' {
            quoted = true;
        } else if *byte == b'{' {
            depth += 1;
        } else if *byte == b'}' {
            depth -= 1;
            if depth == 0 {
                return js::parse(&html.as_bytes()[start..=start + offset])
                    .and_then(|value| shapes::parse(&shapes::MENU, &value["menu"]))
                    .ok_or(Fail::Safe(
                        "Domino’s menu format changed. No order was sent.",
                    ));
            }
        }
    }
    Err(Fail::Safe("Domino’s menu data is incomplete."))
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}
fn visible<'a>(items: impl IntoIterator<Item = &'a Value>, id: &Value) -> Option<&'a Value> {
    items
        .into_iter()
        .find(|v| v["id"] == *id && v["isHidden"] != true)
}
fn pizza_order(input: &Value, data: &Value) -> Result<Value> {
    let mut sections = Vec::new();
    for section in list(&input["sections"]) {
        let item = visible(
            list(&data["menuPizzas"])
                .iter()
                .chain(std::iter::once(&data["basePizza"])),
            &section["pizzaId"],
        );
        let size = item.and_then(|v| {
            list(&v["sizes"])
                .iter()
                .find(|v| v["id"] == input["sizeId"])
        });
        let crust = item.and_then(|v| {
            list(&v["crusts"])
                .iter()
                .find(|v| v["id"] == input["crustId"])
        });
        if item.is_none()
            || size.is_none()
            || !crust.is_some_and(|v| list(&v["allowedSizes"]).contains(&input["sizeId"]))
        {
            return Err(Fail::Safe(
                "The selected pizza, size, or crust is not available in the current menu.",
            ));
        }
        if list(&input["sections"]).len() == 2
            && size.is_some_and(|v| v["blockHalfAndHalf"] == true)
        {
            return Err(Fail::Safe("This size does not allow half-and-half pizzas."));
        }
        let mut seen = std::collections::HashSet::new();
        let mut modifications = Vec::new();
        for change in list(&section["modifications"]) {
            let topping = visible(list(&data["allToppings"]), &change["toppingId"]);
            if topping.is_none()
                || !seen.insert(change["toppingId"].as_str().unwrap_or_default())
                || (change["quantity"].as_f64().unwrap_or(0.0) > 1.0
                    && topping.is_some_and(|v| v["isDoubleable"] != true))
            {
                return Err(Fail::Safe("A topping modification is invalid or repeated."));
            }
            modifications.push(serde_json::json!({"ToppingRefID":change["toppingId"],"Quantity":change["quantity"]}));
        }
        sections.push(serde_json::json!({"PizzaRefID":item.ok_or(Fail::Unknown)?["id"],"Modifications":modifications}));
    }
    Ok(
        serde_json::json!({"Quantity":input["quantity"],"SizeRefID":input["sizeId"],"TypeRefID":input["crustId"],"Sections":sections}),
    )
}
fn side_order(input: &Value, data: &Value) -> Result<Value> {
    if visible(
        list(&data["sides"]).iter().chain(list(&data["sauces"])),
        &input["id"],
    )
    .is_none()
    {
        return Err(Fail::Safe(
            "The selected side or sauce is not available in the current menu.",
        ));
    }
    let side = list(&data["sides"]).iter().find(|v| v["id"] == input["id"]);
    let extra = input
        .get("extraId")
        .or_else(|| side.and_then(|v| v.get("defaultExtraId")))
        .filter(|v| v.as_str().is_some_and(|s| !s.is_empty()));
    if extra.is_some_and(|extra| {
        !side.is_some_and(|side| visible(list(&side["extras"]), extra).is_some())
    }) {
        return Err(Fail::Safe(
            "The selected extra is not available for this side.",
        ));
    }
    Ok(
        serde_json::json!({"SideOrderID":input["id"],"Quantity":input["quantity"],"Modifiers":extra.into_iter().collect::<Vec<_>>()}),
    )
}
fn beverage_order(input: &Value, data: &Value) -> Result<Value> {
    if !visible(list(&data["beverages"]), &input["id"])
        .is_some_and(|v| list(&v["sizes"]).iter().any(|v| v["id"] == input["sizeId"]))
    {
        return Err(Fail::Safe(
            "The selected drink or size is not available in the current menu.",
        ));
    }
    Ok(
        serde_json::json!({"BeverageID":input["id"],"SizeRefID":input["sizeId"],"Quantity":input["quantity"]}),
    )
}
pub fn order_items(cart: &Value, data: &Value) -> Result<Value> {
    use serde_json::json;
    let mut packages = Vec::new();
    for input in list(&cart["packages"]) {
        let offer = visible(list(&data["packages"]), &input["id"]).ok_or(Fail::Safe(
            "This offer is not available for the selected fulfillment method.",
        ))?;
        let available = if cart["fulfillment"]["type"] == "pickup" {
            "availableForPickup"
        } else {
            "availableForDelivery"
        };
        if offer[available] != true {
            return Err(Fail::Safe(
                "This offer is not available for the selected fulfillment method.",
            ));
        }
        let mut choices = Vec::new();
        for (key, kind) in [("pizzas", 0), ("sides", 4), ("beverages", 2)] {
            for item in list(&input[key]) {
                let (crust, ids, size) = if kind == 0 {
                    (
                        item["crustId"].clone(),
                        list(&item["sections"])
                            .iter()
                            .map(|v| v["pizzaId"].clone())
                            .collect::<Vec<_>>(),
                        item["sizeId"].clone(),
                    )
                } else {
                    (
                        Value::Null,
                        vec![item["id"].clone()],
                        if kind == 2 {
                            item["sizeId"].clone()
                        } else {
                            json!("")
                        },
                    )
                };
                choices.push(json!({"slot":item["packageItemId"],"type":kind,"crustId":crust,"ids":ids,"quantity":item["quantity"],"sizeId":size}));
            }
        }
        for slot in list(&offer["items"]) {
            let matches = choices
                .iter()
                .filter(|v| v["slot"] == slot["id"])
                .collect::<Vec<_>>();
            if matches.is_empty() && slot["isOptional"] == true {
                continue;
            }
            if matches
                .iter()
                .map(|v| v["quantity"].as_f64().unwrap_or(0.0))
                .sum::<f64>()
                != slot["quantity"].as_f64().unwrap_or(0.0)
            {
                return Err(Fail::Safe(
                    "Select the required quantity for each offer slot.",
                ));
            }
            if matches.iter().any(|choice| {
                choice["type"] != slot["type"]
                    || (slot["pizzaType"].as_str().is_some_and(|s| !s.is_empty())
                        && choice["crustId"] != slot["pizzaType"])
                    || list(&choice["ids"])
                        .iter()
                        .any(|id| !list(&slot["items"]).iter().any(|v| v["id"] == *id))
                    || (choice["sizeId"].as_str().is_some_and(|s| !s.is_empty())
                        && !list(&slot["sizeList"]).is_empty()
                        && !list(&slot["sizeList"]).contains(&choice["sizeId"]))
            }) {
                return Err(Fail::Safe(
                    "An item, size, or quantity does not match this offer.",
                ));
            }
        }
        if choices.iter().any(|choice| {
            !list(&offer["items"])
                .iter()
                .any(|slot| slot["id"] == choice["slot"])
        }) {
            return Err(Fail::Safe(
                "Unknown offer slot. Use the slots returned by get_menu_item.",
            ));
        }
        let packaged =
            |key: &str, order: fn(&Value, &Value) -> Result<Value>| -> Result<Vec<Value>> {
                list(&input[key])
                    .iter()
                    .map(|v| {
                        let mut result = order(v, data)?;
                        result["PackageItemID"] = v["packageItemId"].clone();
                        Ok(result)
                    })
                    .collect()
            };
        packages.push(json!({"PackageRefID":input["id"],"Quantity":input["quantity"],"Pizzas":packaged("pizzas",pizza_order)?,"SideOrders":packaged("sides",side_order)?,"Beverages":packaged("beverages",beverage_order)?}));
    }
    let ordered = |key: &str, order: fn(&Value, &Value) -> Result<Value>| -> Result<Vec<Value>> {
        list(&cart[key]).iter().map(|v| order(v, data)).collect()
    };
    Ok(
        json!({"Pizzas":ordered("pizzas",pizza_order)?,"SideOrders":ordered("sides",side_order)?,"Beverages":ordered("beverages",beverage_order)?,"Packages":packages,"UpsellOffer":{"Pizzas":[],"SideOrders":[],"Beverages":[],"Packages":[]}}),
    )
}
