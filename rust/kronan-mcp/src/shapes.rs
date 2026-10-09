//! The upstream and output shapes of packages/kronan-mcp/src/schemas.ts, as zod parses them:
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
    /// `z.number().int()`: a safe integer.
    Int,
    Bool,
    /// `z.literal(true)`.
    Enum(&'static [&'static str]),
    Opt(&'static S),
    Null(&'static S),
    Nullish(&'static S),
    List(&'static S),
    /// Field groups, concatenated: a base shape's fields, then an extension's.
    Obj(&'static [Fields]),
    /// `z.record(z.string(), value)`.
    Record(&'static S),
    /// `z.union(options)`: the first option that matches.
    Union(&'static [S]),
}

/// `schema.parse(value)`; `None` input is `undefined`, and stays absent (`Ok(None)`).
fn shape(schema: &S, value: Option<&Value>) -> Result<Option<Value>, ()> {
    let parsed = match (schema, value) {
        (S::Opt(_) | S::Nullish(_), None) => return Ok(None),
        (S::Null(_) | S::Nullish(_), Some(Value::Null)) => Value::Null,
        (S::Opt(inner) | S::Null(inner) | S::Nullish(inner), value) => return shape(inner, value),
        (S::Str, Some(text @ Value::String(_))) => text.clone(),
        (S::Num, Some(number @ Value::Number(_))) => number.clone(),
        (S::Int, Some(Value::Number(number)))
            if number
                .as_f64()
                .is_some_and(|value| value.fract() == 0.0 && value.abs() <= SAFE) =>
        {
            Value::Number(number.clone())
        }
        (S::Bool, Some(flag @ Value::Bool(_))) => flag.clone(),
        (S::Enum(options), Some(Value::String(text))) if options.contains(&text.as_str()) => {
            Value::String(text.clone())
        }
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
        (S::Record(item), Some(Value::Object(object))) => {
            let mut parsed = Map::new();

            // The input is already in JavaScript key order; zod never copies `__proto__`.
            for (key, value) in object.iter().filter(|(key, _)| *key != "__proto__") {
                parsed.insert(key.clone(), shape(item, Some(value))?.ok_or(())?);
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
const INT: S = S::Int;

/// `z.string().nullish()`: image and URL strings are also accepted as null.
const IMAGE: S = S::Nullish(&STR);

const ID_NAME: S = S::Obj(&[&[("id", INT), ("name", STR)]]);

const SLUG_NAME: S = S::Obj(&[&[("slug", STR), ("name", STR)]]);

const PAGE_FIELDS: Fields = &[
    ("count", INT),
    ("page", INT),
    ("pageCount", INT),
    ("hasNextPage", S::Bool),
];

const PRODUCT_FIELDS: Fields = &[
    ("sku", STR),
    ("name", STR),
    ("thumbnail", IMAGE),
    ("price", INT),
    ("discountedPrice", INT),
    ("discountPercent", NUM),
    ("onSale", S::Bool),
    ("priceInfo", S::Null(&STR)),
    ("chargedByWeight", S::Opt(&S::Bool)),
    ("pricePerKilo", S::Null(&NUM)),
    ("baseComparisonUnit", S::Nullish(&STR)),
    ("temporaryShortage", S::Bool),
    ("categoryPath", S::Null(&STR)),
    ("brand", S::Nullish(&STR)),
];

pub const PRODUCT: S = S::Obj(&[PRODUCT_FIELDS]);

/// Nutrition is documented as a string map; flat numbers are tolerated, nested objects are not.
const NUTRITION_VALUE: S = S::Union(&[STR, NUM, S::Null(&STR)]);

pub const PRODUCT_DETAIL: S = S::Obj(&[
    PRODUCT_FIELDS,
    &[
        ("description", S::Opt(&STR)),
        ("image", IMAGE),
        ("qtyPerBaseCompUnit", S::Nullish(&NUM)),
        ("qtyInSalesUnit", S::Nullish(&NUM)),
        ("countryOfOrigin", S::Nullish(&STR)),
        ("tags", S::List(&SLUG_NAME)),
        ("nutrition", S::Null(&S::Record(&NUTRITION_VALUE))),
    ],
]);

pub const ME: S = S::Obj(&[&[("type", STR), ("name", STR)]]);

const SEARCH_HIT: S = S::Obj(&[&[
    ("sku", STR),
    ("name", STR),
    ("price", INT),
    ("thumbnail", IMAGE),
    ("temporaryShortage", S::Bool),
    ("priceInfo", S::Null(&STR)),
    ("chargedByWeight", S::Bool),
    ("pricePerKilo", S::Null(&NUM)),
    ("baseComparisonUnit", S::Null(&STR)),
    (
        "detail",
        S::Null(&S::Obj(&[&[
            ("discountedPrice", INT),
            ("discountPercent", NUM),
            ("onSale", S::Bool),
            ("qtyInSalesUnit", S::Nullish(&NUM)),
            ("tags", S::List(&SLUG_NAME)),
        ]])),
    ),
    (
        "purchaseHistory",
        S::Null(&S::Obj(&[&[
            ("purchaseCount", INT),
            ("averagePurchaseQuantity", S::Null(&NUM)),
            ("lastPurchaseDate", S::Null(&STR)),
        ]])),
    ),
]]);

pub const SEARCH_RESULT: S = S::Obj(&[PAGE_FIELDS, &[("hits", S::List(&SEARCH_HIT))]]);

pub const LOOKUP_RESULT: S = S::Obj(&[&[
    ("results", S::List(&PRODUCT_DETAIL)),
    ("missingSkus", S::List(&STR)),
]]);

const CATEGORY_LEVEL_1: S = S::Obj(&[&[
    ("slug", STR),
    ("name", STR),
    ("children", S::List(&SLUG_NAME)),
]]);

pub const CATEGORIES: S = S::List(&S::Obj(&[&[
    ("slug", STR),
    ("name", STR),
    ("backgroundImage", IMAGE),
    ("icon", IMAGE),
    ("children", S::List(&CATEGORY_LEVEL_1)),
]]));

pub const CATEGORY_PRODUCTS: S = S::Obj(&[
    &[("name", STR)],
    PAGE_FIELDS,
    &[("products", S::List(&PRODUCT))],
]);

pub const TAGS: S = S::List(&SLUG_NAME);

pub const PRODUCT_PAGE: S = S::Obj(&[PAGE_FIELDS, &[("results", S::List(&PRODUCT))]]);

const DELIVERY_INFO: S = S::Obj(&[&[
    ("timeStart", S::Null(&STR)),
    ("timeStop", S::Null(&STR)),
    ("status", S::Null(&NUM)),
    ("statusDisplay", S::Null(&STR)),
    ("eta", S::Null(&STR)),
    (
        "address",
        S::Null(&S::Obj(&[&[
            ("streetAddress1", STR),
            ("city", STR),
            ("postalCode", STR),
            ("lat", S::Null(&NUM)),
            ("lng", S::Null(&NUM)),
            ("comment", S::Null(&STR)),
        ]])),
    ),
]]);

const ORDER_HEAD: Fields = &[("token", S::Opt(&STR)), ("created", STR)];

const ORDER_REST: Fields = &[
    ("status", S::Opt(&STR)),
    ("type", S::Nullish(&STR)),
    ("total", INT),
    ("discount", INT),
    ("deliveryDate", S::Nullish(&STR)),
    ("allowAlterOrderLines", S::Bool),
    ("deliveryInfo", S::Null(&DELIVERY_INFO)),
];

const ORDER_SUMMARY: S = S::Obj(&[ORDER_HEAD, &[("displayDate", S::Opt(&STR))], ORDER_REST]);

const ORDER_LINE: S = S::Obj(&[&[
    ("id", INT),
    ("productName", STR),
    ("sku", STR),
    ("quantity", INT),
    ("quantityOrdered", S::Opt(&INT)),
    ("unitPrice", INT),
    ("substitution", S::Opt(&S::Bool)),
    ("substitutionForLineId", S::Null(&INT)),
    ("isMutable", S::Bool),
    ("isLastChance", S::Opt(&S::Bool)),
    ("thumbnail", IMAGE),
    ("total", INT),
]]);

/// The order summary without `displayDate`, with its lines.
pub const ORDER: S = S::Obj(&[ORDER_HEAD, ORDER_REST, &[("lines", S::List(&ORDER_LINE))]]);

pub const ACTIVE_ORDER: S = S::Obj(&[&[
    ("orderToken", STR),
    ("type", STR),
    ("deliveryDate", S::Null(&STR)),
    ("timeStart", S::Null(&STR)),
    ("timeStop", S::Null(&STR)),
    (
        "address",
        S::Null(&S::Obj(&[&[
            ("id", INT),
            ("streetAddress1", STR),
            ("city", STR),
            ("postalCode", STR),
        ]])),
    ),
    ("store", S::Null(&ID_NAME)),
    (
        "lines",
        S::List(&S::Obj(&[&[
            ("sku", STR),
            ("name", STR),
            ("quantity", INT),
            ("unitPrice", INT),
        ]])),
    ),
    ("subtotal", INT),
    ("shippingFee", INT),
    ("serviceFee", INT),
    ("bagFee", INT),
    ("total", INT),
    ("freeShippingCutoff", INT),
    ("neededForFreeShipping", INT),
    ("allowAdditionalOrderLinesUntil", S::Null(&STR)),
    ("authorizedAmount", INT),
    ("capturedAmount", INT),
]]);

pub const LINE_SUMMARY: S = S::Obj(&[&[
    ("nameContains", S::Null(&STR)),
    ("skus", S::Null(&S::List(&STR))),
    ("fromYear", INT),
    ("fromMonth", INT),
    ("toYear", INT),
    ("toMonth", INT),
    ("asOfDate", STR),
    ("totalAmount", INT),
    ("totalQuantity", INT),
    ("orderCount", INT),
    (
        "months",
        S::List(&S::Obj(&[&[
            ("year", INT),
            ("month", INT),
            ("amount", INT),
            ("quantity", INT),
            ("orderCount", INT),
        ]])),
    ),
    ("matchedProductCount", INT),
    (
        "matchedProducts",
        S::List(&S::Obj(&[&[
            ("sku", STR),
            ("name", STR),
            ("amount", INT),
            ("quantity", INT),
            ("orderCount", INT),
        ]])),
    ),
]]);

const PURCHASE_STAT: S = S::Obj(&[&[
    ("id", INT),
    ("product", PRODUCT),
    ("purchaseCount", S::Opt(&INT)),
    ("quantityPurchased", S::Opt(&INT)),
    ("averagePurchaseQuantity", S::Nullish(&NUM)),
    ("lastPurchaseQuantity", S::Opt(&INT)),
    ("averagePurchaseIntervalDays", S::Nullish(&NUM)),
    ("firstPurchaseDate", S::Nullish(&STR)),
    ("lastPurchaseDate", S::Nullish(&STR)),
    ("isIgnored", S::Opt(&S::Bool)),
]]);

pub const SHOPPING_NOTE: S = S::Obj(&[&[
    ("token", STR),
    ("name", STR),
    (
        "lines",
        S::List(&S::Obj(&[&[
            ("token", STR),
            ("text", S::Nullish(&STR)),
            ("quantity", S::Nullish(&INT)),
            (
                "product",
                S::Nullish(&S::Obj(&[&[
                    ("sku", S::Nullish(&STR)),
                    ("name", STR),
                    ("description", S::Opt(&STR)),
                    ("thumbnail", IMAGE),
                ]])),
            ),
            ("placement", S::Opt(&INT)),
            ("isCompleted", S::Opt(&S::Bool)),
        ]])),
    ),
]]);

pub const ARCHIVED_LINES: S = S::List(&S::Obj(&[&[
    ("token", STR),
    ("text", STR),
    ("completedCount", S::Opt(&INT)),
]]));

const PRODUCT_LIST_HEAD: Fields = &[
    ("id", INT),
    ("name", STR),
    ("token", STR),
    ("description", S::Opt(&STR)),
];

const PRODUCT_LIST_SUMMARY: S = S::Obj(&[PRODUCT_LIST_HEAD, &[("hasProducts", S::Bool)]]);

pub const PRODUCT_LIST_DETAIL: S = S::Obj(&[
    PRODUCT_LIST_HEAD,
    &[(
        "items",
        S::List(&S::Obj(&[&[
            ("id", INT),
            ("quantity", INT),
            ("product", PRODUCT),
        ]])),
    )],
]);

const RECIPE_IMAGE: S = S::Obj(&[&[("image", STR), ("alt", S::Opt(&STR))]]);

const RECIPE_FIELDS: Fields = &[
    ("token", STR),
    ("name", STR),
    ("displayName", STR),
    ("slug", STR),
    ("isFeatured", S::Opt(&S::Bool)),
    ("preparationMinutes", S::Opt(&INT)),
    ("cookingMinutes", S::Opt(&INT)),
    ("totalMinutes", INT),
    ("servings", S::Opt(&INT)),
    ("difficulty", S::Null(&NUM)),
    ("mainImage", S::Null(&RECIPE_IMAGE)),
    ("tags", S::List(&ID_NAME)),
    ("ingredientTags", S::List(&ID_NAME)),
    ("cuisineTags", S::List(&ID_NAME)),
    ("occasionTags", S::List(&ID_NAME)),
    ("favorited", S::Bool),
    ("hasVideo", S::Bool),
];

const RECIPE_SUMMARY: S = S::Obj(&[RECIPE_FIELDS]);

const RECIPE_PRODUCT_LINE: S = S::Obj(&[&[
    ("quantity", INT),
    ("comment", S::Opt(&STR)),
    ("product", PRODUCT),
]]);

pub const RECIPE_DETAIL: S = S::Obj(&[
    RECIPE_FIELDS,
    &[
        ("directions", S::Opt(&STR)),
        ("ingredients", S::Opt(&STR)),
        ("videoUrl", S::Nullish(&STR)),
        ("items", S::List(&RECIPE_PRODUCT_LINE)),
        ("essentials", S::List(&RECIPE_PRODUCT_LINE)),
        (
            "recommendations",
            S::List(&S::Obj(&[&[("product", PRODUCT)]])),
        ),
        ("images", S::List(&RECIPE_IMAGE)),
        (
            "directionSteps",
            S::List(&S::Obj(&[&[
                ("name", S::Null(&STR)),
                (
                    "steps",
                    S::List(&S::Obj(&[&[
                        ("number", S::Null(&INT)),
                        ("text", STR),
                        ("ingredients", S::List(&STR)),
                        (
                            "icon",
                            S::Null(&S::Obj(&[&[
                                ("name", S::Opt(&STR)),
                                ("icon", S::Nullish(&STR)),
                            ]])),
                        ),
                    ]])),
                ),
            ]])),
        ),
    ],
]);

pub const RECIPE_SEARCH: S = S::Obj(&[
    PAGE_FIELDS,
    &[
        ("recipes", S::List(&RECIPE_SUMMARY)),
        (
            "availableTags",
            S::Obj(&[&[
                ("tags", S::List(&ID_NAME)),
                ("ingredientTags", S::List(&ID_NAME)),
                ("cuisineTags", S::List(&ID_NAME)),
                ("occasionTags", S::List(&ID_NAME)),
            ]]),
        ),
    ],
]);

pub const CHECKOUT: S = S::Obj(&[&[
    ("token", STR),
    (
        "lines",
        S::List(&S::Obj(&[&[
            ("id", INT),
            ("quantity", INT),
            ("product", PRODUCT),
            ("total", INT),
            ("price", INT),
            ("substitution", S::Opt(&S::Bool)),
        ]])),
    ),
    ("total", INT),
    ("subtotal", INT),
    ("baggingFee", INT),
    ("serviceFee", INT),
    ("shippingFee", INT),
    ("shippingFeeCutoff", INT),
]]);

pub const ADDRESSES: S = S::List(&S::Obj(&[&[
    ("id", INT),
    ("streetAddress1", S::Opt(&STR)),
    ("city", S::Opt(&STR)),
    ("postalCode", S::Opt(&STR)),
    ("comment", S::Opt(&STR)),
    ("lat", S::Null(&NUM)),
    ("lng", S::Null(&NUM)),
    ("dropoffOutside", S::Opt(&S::Bool)),
    ("isDefaultShipping", S::Bool),
]]));

const SLOT_DAY: S = S::Obj(&[&[
    ("day", STR),
    (
        "slots",
        S::List(&S::Obj(&[&[
            ("slotId", INT),
            ("timeStart", STR),
            ("timeStop", STR),
            ("availabilityStatus", INT),
        ]])),
    ),
]]);

pub const DELIVERY_SLOTS: S = S::List(&SLOT_DAY);

pub const PICKUP_SLOTS: S = S::List(&S::Obj(&[&[
    ("storeName", STR),
    ("storeChain", STR),
    ("days", S::List(&SLOT_DAY)),
]]));

pub const PREVIEW: S = S::Obj(&[&[
    (
        "lines",
        S::List(&S::Obj(&[&[
            ("sku", STR),
            ("name", STR),
            ("quantity", INT),
            ("price", INT),
            ("total", INT),
            (
                "status",
                S::Enum(&["ok", "not_found", "temporary_shortage", "unpublished"]),
            ),
            ("reason", S::Null(&STR)),
        ]])),
    ),
    ("estimatedSubtotal", INT),
    ("okCount", INT),
    ("issueCount", INT),
]]);

/// The limit/offset pages Krónan returns; only the presence of `next` is kept.
macro_rules! offset_page {
    ($results:expr) => {
        S::Obj(&[&[
            ("count", INT),
            ("next", S::Nullish(&STR)),
            ("results", S::List(&$results)),
        ]])
    };
}

pub const ORDERS_PAGE: S = offset_page!(ORDER_SUMMARY);

pub const PURCHASE_STATS_PAGE: S = offset_page!(PURCHASE_STAT);

pub const PRODUCT_LISTS_PAGE: S = offset_page!(PRODUCT_LIST_SUMMARY);

pub const RECIPES_PAGE: S = offset_page!(RECIPE_SUMMARY);

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn shapes_parse_like_zod() {
        let product = json!({
            "upstreamOnly": 1, "brand": null, "categoryPath": null, "temporaryShortage": false,
            "pricePerKilo": null, "priceInfo": "x", "onSale": true, "discountPercent": 2.5,
            "discountedPrice": 4, "price": 5, "thumbnail": null, "name": "n", "sku": "s",
        });
        assert_eq!(
            parse(&PRODUCT, &product).unwrap().to_string(),
            r#"{"sku":"s","name":"n","thumbnail":null,"price":5,"discountedPrice":4,"discountPercent":2.5,"onSale":true,"priceInfo":"x","pricePerKilo":null,"temporaryShortage":false,"categoryPath":null,"brand":null}"#
        );
        let mut fractional = product.clone();
        fractional["price"] = json!(5.5);
        assert!(parse(&PRODUCT, &fractional).is_none());
        let mut unsafe_int = product;
        unsafe_int["price"] = json!(9_007_199_254_740_992.0);
        assert!(parse(&PRODUCT, &unsafe_int).is_none());

        let nutrition = S::Record(&NUTRITION_VALUE);
        assert_eq!(
            parse(
                &nutrition,
                &json!({"a": "1", "b": 2, "c": null, "__proto__": 3})
            ),
            Some(json!({"a": "1", "b": 2, "c": null}))
        );
        assert!(parse(&nutrition, &json!({"a": {"b": 1}})).is_none());
        assert!(parse(&nutrition, &json!([])).is_none());
        assert!(
            parse(
                &ARCHIVED_LINES,
                &json!([{"token": "t", "text": "x", "completedCount": null}])
            )
            .is_none()
        );
    }
}
