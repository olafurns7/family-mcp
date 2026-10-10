//! The upstream and output shapes of packages/dominos-mcp/src/schemas.ts, as zod parses them:
//! unknown keys dropped, known keys in shape order (an extended shape's own keys after its
//! base's), absent optional keys left absent. A shape that does not match is `None`, which the
//! client reports as data outside the documented schema.

use serde_json::{Map, Value};

/// Number.MAX_SAFE_INTEGER, the bound of zod's `int()`.
const SAFE: f64 = 9_007_199_254_740_991.0;

/// One object shape's fields, in order.
pub type Fields = &'static [(&'static str, S)];

#[derive(Clone, Copy)]
pub enum S {
    Str,
    Num,
    /// `z.number().int().positive()`: a positive safe integer.
    PositiveInt,
    Bool,
    Opt(&'static S),
    Null(&'static S),
    List(&'static S),
    /// Field groups, concatenated: a base shape's fields, then an extension's.
    Obj(&'static [Fields]),
    /// `z.union(options)`: the first option that matches.
    Union(&'static [S]),
}

/// `schema.parse(value)`; `None` input is `undefined`, and stays absent (`Ok(None)`).
fn shape(schema: &S, value: Option<&Value>) -> Result<Option<Value>, ()> {
    let parsed = match (schema, value) {
        (S::Opt(_), None) => return Ok(None),
        (S::Null(_), Some(Value::Null)) => Value::Null,
        (S::Opt(inner) | S::Null(inner), value) => return shape(inner, value),
        (S::Str, Some(text @ Value::String(_))) => text.clone(),
        (S::Num, Some(number @ Value::Number(_))) => number.clone(),
        (S::PositiveInt, Some(Value::Number(number)))
            if number.as_f64().is_some_and(|value| {
                value.fract() == 0.0 && value.abs() <= SAFE && value > 0.0
            }) =>
        {
            Value::Number(number.clone())
        }
        (S::Bool, Some(flag @ Value::Bool(_))) => flag.clone(),
        (S::List(item), Some(Value::Array(items))) => Value::Array(
            items
                .iter()
                .map(|value| shape(item, Some(value))?.ok_or(()))
                .collect::<Result<_, ()>>()?,
        ),
        (S::Obj(groups), Some(Value::Object(object))) => {
            let mut parsed = Map::new();

            for (key, field) in groups.iter().flat_map(|fields| fields.iter()) {
                if let Some(value) = shape(field, object.get(*key))? {
                    parsed.insert((*key).to_owned(), value);
                }
            }
            Value::Object(parsed)
        }
        (S::Union(options), value) => {
            return options
                .iter()
                .find_map(|option| shape(option, value).ok())
                .ok_or(());
        }
        _ => return Err(()),
    };
    Ok(Some(parsed))
}

/// `schema.safeParse(value)`: the parsed value, or `None`.
pub fn parse(schema: &S, value: &Value) -> Option<Value> {
    shape(schema, Some(value)).ok().flatten()
}

const STR: S = S::Str;
const NUM: S = S::Num;
const BOOL: S = S::Bool;
const REF: S = S::Union(&[S::Str, S::Num]);
const PRICED: Fields = &[
    ("id", STR),
    ("name", STR),
    ("pickupPrice", NUM),
    ("deliveryPrice", NUM),
];
const AVAILABILITY: Fields = &[
    ("isHidden", BOOL),
    ("storeAvailability", S::List(&REF)),
    ("availableIn", S::Null(&S::List(&REF))),
    ("notAvailableIn", S::Null(&S::List(&REF))),
    ("availabilityDescription", S::Null(&STR)),
];
const TOPPING: S = S::Obj(&[&[
    ("id", STR),
    ("name", STR),
    ("category", STR),
    ("quantity", NUM),
    ("isDoubleable", BOOL),
    ("isVegan", BOOL),
    ("isHidden", BOOL),
    (
        "prices",
        S::List(&S::Obj(&[&[
            ("sizeId", STR),
            ("pickupPrice", NUM),
            ("deliveryPrice", NUM),
        ]])),
    ),
]]);
const PIZZA: S = S::Obj(&[
    &[("id", STR), ("name", STR)],
    AVAILABILITY,
    &[
        (
            "sizes",
            S::List(&S::Obj(&[PRICED, &[("blockHalfAndHalf", BOOL)]])),
        ),
        (
            "crusts",
            S::List(&S::Obj(&[&[
                ("id", STR),
                ("name", STR),
                ("allowedSizes", S::List(&STR)),
            ]])),
        ),
        ("toppings", S::List(&TOPPING)),
        ("allergens", S::List(&REF)),
    ],
]);
const SIDE: S = S::Obj(&[
    PRICED,
    AVAILABILITY,
    &[
        ("description", S::Null(&STR)),
        ("extras", S::List(&S::Obj(&[PRICED, &[("isHidden", BOOL)]]))),
        ("allergens", S::List(&REF)),
        ("defaultExtraId", S::Null(&STR)),
    ],
]);
const SAUCE: S = S::Obj(&[
    PRICED,
    AVAILABILITY,
    &[("description", S::Null(&STR)), ("allergens", S::List(&REF))],
]);
const BEVERAGE: S = S::Obj(&[
    &[
        ("id", STR),
        ("name", STR),
        ("sizes", S::List(&S::Obj(&[PRICED]))),
    ],
    AVAILABILITY,
]);
const OFFER: S = S::Obj(&[
    &[
        ("id", STR),
        ("name", STR),
        ("description", STR),
        ("price", NUM),
    ],
    AVAILABILITY,
    &[
        ("availableForPickup", BOOL),
        ("availableForDelivery", BOOL),
        ("payOnlineOnly", BOOL),
        (
            "items",
            S::List(&S::Obj(&[&[
                ("id", STR),
                ("type", NUM),
                ("quantity", NUM),
                ("sizeId", S::Null(&STR)),
                ("sizeList", S::List(&STR)),
                ("pizzaType", S::Null(&STR)),
                ("isOptional", BOOL),
                ("items", S::List(&S::Obj(&[&[("id", STR), ("name", STR)]]))),
            ]])),
        ),
    ],
]);
pub const MENU: S = S::Obj(&[&[
    ("menuPizzas", S::List(&PIZZA)),
    ("basePizza", PIZZA),
    ("sides", S::List(&SIDE)),
    ("sauces", S::List(&SAUCE)),
    ("beverages", S::List(&BEVERAGE)),
    ("packages", S::List(&OFFER)),
    ("allToppings", S::List(&TOPPING)),
    (
        "allergens",
        S::List(&S::Obj(&[&[("id", STR), ("name", STR)]])),
    ),
]]);
pub const PROFILE: S = S::Obj(&[&[
    ("id", REF),
    ("name", S::Null(&STR)),
    ("phoneNumber", STR),
    ("email", S::Null(&STR)),
    (
        "savedAddress",
        S::Opt(&S::List(&S::Obj(&[&[
            ("AddressID", S::PositiveInt),
            ("Address", STR),
            ("PostalCode", STR),
            ("PostalCodeName", STR),
        ]]))),
    ),
    (
        "savedOrders",
        S::Opt(&S::List(&S::Obj(&[&[
            ("id", REF),
            ("name", STR),
            ("cartCollection", STR),
        ]]))),
    ),
]]);
pub const STORES: S = S::List(&S::Obj(&[&[
    ("RefID", STR),
    ("Address", STR),
    ("City", STR),
    ("Zip", STR),
    ("AcceptInternet", BOOL),
    ("AcceptsPickup", BOOL),
    ("AcceptsDelivery", BOOL),
    ("Disabled", BOOL),
    ("IsHidden", BOOL),
    ("Status", NUM),
    ("StoreStatus", NUM),
    ("PickupQuote", S::Null(&STR)),
    ("DeliveryQuote", S::Null(&STR)),
    ("OpensAt", S::Null(&STR)),
    ("ClosesAt", S::Null(&STR)),
    ("OpeningHours", S::Null(&STR)),
    ("NotificationText", S::Null(&STR)),
]]));
pub const ADDRESSES: S = S::List(&S::Obj(&[&[
    ("ID", S::PositiveInt),
    ("Name", STR),
    ("PostalCode", STR),
    ("PostalCodeName", STR),
]]));
pub const DELIVERY_STORE: S = S::Obj(&[&[("RefID", STR), ("WaitingTime", S::Null(&STR))]]);
pub const RECEIPTS: S = S::List(&S::Obj(&[&[
    ("Id", REF),
    ("Amount", NUM),
    ("DateOf", STR),
    ("IsOneSystem", S::Opt(&BOOL)),
]]));
pub const TRACKER: S = S::Obj(&[&[
    ("OrderID", S::Null(&REF)),
    ("OrderState", STR),
    ("Remaining", S::Null(&NUM)),
    ("IsPickup", BOOL),
    ("IsTimedOrder", BOOL),
    ("EstimatedFinishTime", S::Opt(&S::Null(&STR))),
]]);
