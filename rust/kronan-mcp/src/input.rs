//! Tool input validation with the TypeScript server's results: the same accepted values,
//! defaults, and zod 4 issue messages, order and abort rules, so an invalid call gets the same
//! text. The advertised JSON Schemas are the TypeScript server's own (`surface.json`). Each
//! parse returns what the client sends: a request body in schema key order, defaults included,
//! or path segments and query pairs.

pub use mcp_runtime::input::empty;
use mcp_runtime::input::{Parse, object, optional};
use serde_json::{Map, Value, json};

// Number.MAX_SAFE_INTEGER, the bound of zod's `int()`.
const SAFE: f64 = 9_007_199_254_740_991.0;

const SKU_PATTERN: &str = "/^[A-Za-z0-9._-]+$/";

const SLUG_PATTERN: &str = r"/^[\p{L}\p{N}_.-]+$/u";

const TOKEN_PATTERN: &str = "/^[A-Za-z0-9_-]+$/";

/// Query pairs in the order the TypeScript client builds its URL.
pub type Query = Vec<(&'static str, String)>;

/// A limit/offset window.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Window {
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum ProductKey {
    Sku(String),
    Barcode(String),
}

/// Bare dot segments would be collapsed by URL parsing into a different endpoint.
fn dot_segment(text: &str) -> bool {
    text == "." || text == ".."
}

/// `\p{L}`: a letter of any script, by Unicode general category.
fn letter(c: char) -> bool {
    use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
    GeneralCategoryGroup::Letter
        .contains(icu_properties::CodePointMapData::<GeneralCategory>::new().get(c))
}

/// `\p{N}`: a number of any script, by Unicode general category.
fn numeral(c: char) -> bool {
    use icu_properties::props::{GeneralCategory, GeneralCategoryGroup};
    GeneralCategoryGroup::Number
        .contains(icu_properties::CodePointMapData::<GeneralCategory>::new().get(c))
}

/// Krónan's fields, on top of the runtime's strings and arrays.
trait Fields {
    fn int(&mut self, value: Option<&Value>, min: Option<i64>, max: Option<i64>) -> Option<i64>;

    fn int_or(&mut self, value: Option<&Value>, bounds: (i64, i64), default: i64) -> i64;

    fn boolean_or(&mut self, value: Option<&Value>, default: bool) -> bool;

    fn option(&mut self, value: Option<&Value>, options: &[&'static str]) -> Option<&'static str>;

    fn pattern(&mut self, text: Option<&str>, pattern: &str, matches: impl Fn(&str) -> bool);

    fn sku(&mut self, value: Option<&Value>) -> Option<String>;

    fn slug(&mut self, value: Option<&Value>) -> Option<String>;

    fn token(&mut self, value: Option<&Value>) -> Option<String>;

    fn skus(&mut self, value: Option<&Value>, max: usize) -> Option<Vec<String>>;

    fn tag_ids(&mut self, value: Option<&Value>) -> Vec<i64>;

    fn boolean(&mut self, value: Option<&Value>) -> Option<bool>;

    fn confirm(&mut self, value: Option<&Value>);

    fn guid(&mut self, value: Option<&Value>) -> Option<String>;

    fn line_ids(&mut self, value: Option<&Value>) -> Vec<i64>;
}

impl Fields for Parse<'_> {
    /// `z.number().int()` with optional `.min()` and `.max()`.
    fn int(&mut self, value: Option<&Value>, min: Option<i64>, max: Option<i64>) -> Option<i64> {
        let Some(number) = value.and_then(Value::as_f64) else {
            self.wrong_type("number", value);
            return None;
        };

        if number.fract() != 0.0 {
            self.wrong_type("int", value);
            return None;
        }

        if number > SAFE {
            self.issue(format!("Too big: expected int to be <={SAFE}"), true);
        } else if number < -SAFE {
            self.issue(format!("Too small: expected int to be >=-{SAFE}"), true);
        }

        if let Some(min) = min.filter(|min| number < *min as f64) {
            self.issue(format!("Too small: expected number to be >={min}"), true);
        }

        if let Some(max) = max.filter(|max| number > *max as f64) {
            self.issue(format!("Too big: expected number to be <={max}"), true);
        }
        Some(number as i64)
    }

    /// `z.number().int().min(min).max(max).default(default)`.
    fn int_or(&mut self, value: Option<&Value>, (min, max): (i64, i64), default: i64) -> i64 {
        match value {
            None => default,
            Some(_) => self.int(value, Some(min), Some(max)).unwrap_or(default),
        }
    }

    /// `z.boolean().default(default)`.
    fn boolean_or(&mut self, value: Option<&Value>, default: bool) -> bool {
        match value {
            None => default,
            Some(Value::Bool(flag)) => *flag,
            Some(_) => {
                self.wrong_type("boolean", value);
                default
            }
        }
    }

    /// `z.enum(options)`.
    fn option(&mut self, value: Option<&Value>, options: &[&'static str]) -> Option<&'static str> {
        let found = value
            .and_then(Value::as_str)
            .and_then(|text| options.iter().find(|option| **option == text).copied());

        if found.is_none() {
            let listed: Vec<String> = options
                .iter()
                .map(|option| format!("\"{option}\""))
                .collect();
            self.issue(
                format!("Invalid option: expected one of {}", listed.join("|")),
                false,
            );
        }
        found
    }

    /// `.regex(pattern)` on a string that parsed.
    fn pattern(&mut self, text: Option<&str>, pattern: &str, matches: impl Fn(&str) -> bool) {
        if text.is_some_and(|text| !matches(text)) {
            self.issue(
                format!("Invalid string: must match pattern {pattern}"),
                true,
            );
        }
    }

    /// The SKU field: 1 to 40 of `[A-Za-z0-9._-]`, never a bare dot segment.
    fn sku(&mut self, value: Option<&Value>) -> Option<String> {
        let text = self.string(value, (1, 40));
        self.pattern(text.as_deref(), SKU_PATTERN, |text| {
            !text.is_empty()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        });

        if text.as_deref().is_some_and(dot_segment) {
            self.issue("Invalid SKU".to_owned(), true);
        }
        text
    }

    /// A slug: 1 to 128 letters, numbers, `_`, `.` or `-`, never a bare dot segment.
    fn slug(&mut self, value: Option<&Value>) -> Option<String> {
        let text = self.string(value, (1, 128));
        self.pattern(text.as_deref(), SLUG_PATTERN, |text| {
            !text.is_empty()
                && text
                    .chars()
                    .all(|c| letter(c) || numeral(c) || "_.-".contains(c))
        });

        if text.as_deref().is_some_and(dot_segment) {
            self.issue("Invalid slug".to_owned(), true);
        }
        text
    }

    /// An order, checkout or product list token: 1 to 64 of `[A-Za-z0-9_-]`.
    fn token(&mut self, value: Option<&Value>) -> Option<String> {
        let text = self.string(value, (1, 64));
        self.pattern(text.as_deref(), TOKEN_PATTERN, |text| {
            !text.is_empty()
                && text
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
        });
        text
    }

    fn skus(&mut self, value: Option<&Value>, max: usize) -> Option<Vec<String>> {
        self.array(value, (1, max), |parse, item| parse.sku(Some(item)))
    }

    /// `z.array(z.number().int().min(0)).max(20).default([])`.
    fn tag_ids(&mut self, value: Option<&Value>) -> Vec<i64> {
        if value.is_none() {
            return Vec::new();
        }
        self.array(value, (0, 20), |parse, item| {
            parse.int(Some(item), Some(0), None)
        })
        .unwrap_or_default()
    }

    /// `z.boolean()`.
    fn boolean(&mut self, value: Option<&Value>) -> Option<bool> {
        let flag = value.and_then(Value::as_bool);

        if flag.is_none() {
            self.wrong_type("boolean", value);
        }
        flag
    }

    /// `z.literal(true)`: the approval flag.
    fn confirm(&mut self, value: Option<&Value>) {
        if value != Some(&Value::Bool(true)) {
            self.issue("Invalid input: expected true".to_owned(), false);
        }
    }

    /// `z.guid()`: a shopping note line token.
    fn guid(&mut self, value: Option<&Value>) -> Option<String> {
        let text = self.string(value, (0, usize::MAX));
        let groups = [8, 4, 4, 4, 12];
        let valid = text.as_deref().is_some_and(|text| {
            let parts: Vec<&str> = text.split('-').collect();
            parts.len() == groups.len()
                && parts.iter().zip(groups).all(|(part, length)| {
                    part.len() == length && part.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
        });

        if text.is_some() && !valid {
            self.issue("Invalid GUID".to_owned(), true);
        }
        text
    }

    /// `z.array(z.number().int().min(0)).min(1).max(100)`: order line ids.
    fn line_ids(&mut self, value: Option<&Value>) -> Vec<i64> {
        self.array(value, (1, 100), |parse, item| {
            parse.int(Some(item), Some(0), None)
        })
        .unwrap_or_default()
    }
}

/// `page`: 1-based, at most 10000, default 1.
fn page(parse: &mut Parse, args: &Map<String, Value>) -> i64 {
    parse.at("page").int_or(args.get("page"), (1, 10_000), 1)
}

/// `limit` (1 to 100, default 20) and `offset` (0 to 1000000, default 0).
fn window(parse: &mut Parse, args: &Map<String, Value>) -> Window {
    Window {
        limit: parse.at("limit").int_or(args.get("limit"), (1, 100), 20),
        offset: parse
            .at("offset")
            .int_or(args.get("offset"), (0, 1_000_000), 0),
    }
}

/// A required string field.
fn required(
    parse: &mut Parse,
    args: &Map<String, Value>,
    key: &str,
    field: impl FnOnce(&mut Parse, Option<&Value>) -> Option<String>,
) -> String {
    field(&mut parse.at(key), args.get(key)).unwrap_or_default()
}

pub fn search_products(arguments: &Map<String, Value>) -> Result<Value, String> {
    const SHAPE: [&str; 6] = [
        "query",
        "page",
        "pageSize",
        "sortBy",
        "withDetail",
        "includePurchaseHistory",
    ];
    object(
        arguments,
        &SHAPE,
        |parse, args| {
            let mut body = Map::new();
            body.insert(
                "query".to_owned(),
                json!(required(parse, args, "query", |p, v| p.string(v, (1, 64)))),
            );
            body.insert("page".to_owned(), json!(page(parse, args)));
            body.insert(
                "pageSize".to_owned(),
                json!(
                    parse
                        .at("pageSize")
                        .int_or(args.get("pageSize"), (1, 50), 20)
                ),
            );

            if let Some(sort) = optional(parse, args, "sortBy", |p, v| {
                let text = p.string(v, (0, 32));
                p.pattern(text.as_deref(), "/^[a-z_]+$/", |text| {
                    !text.is_empty()
                        && text
                            .bytes()
                            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
                });
                text
            }) {
                body.insert("sortBy".to_owned(), json!(sort));
            }
            body.insert(
                "withDetail".to_owned(),
                json!(
                    parse
                        .at("withDetail")
                        .boolean_or(args.get("withDetail"), false)
                ),
            );
            body.insert(
                "includePurchaseHistory".to_owned(),
                json!(
                    parse
                        .at("includePurchaseHistory")
                        .boolean_or(args.get("includePurchaseHistory"), false)
                ),
            );
            Value::Object(body)
        },
        |_| None,
    )
}

pub fn product(arguments: &Map<String, Value>) -> Result<ProductKey, String> {
    let (sku, barcode) = object(
        arguments,
        &["sku", "barcode"],
        |parse, args| {
            (
                optional(parse, args, "sku", |p, v| p.sku(v)),
                optional(parse, args, "barcode", |p, v| {
                    let text = p.string(v, (4, 20));
                    p.pattern(text.as_deref(), "/^[0-9]+$/", |text| {
                        !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit())
                    });
                    text
                }),
            )
        },
        |_| {
            (args_present(arguments, "sku") == args_present(arguments, "barcode"))
                .then_some("Provide exactly one of sku or barcode")
        },
    )?;
    Ok(match (sku, barcode) {
        (Some(sku), _) => ProductKey::Sku(sku),
        (None, barcode) => ProductKey::Barcode(barcode.unwrap_or_default()),
    })
}

/// Whether a property is present (not `undefined`).
fn args_present(arguments: &Map<String, Value>, key: &str) -> bool {
    arguments.contains_key(key)
}

pub fn lookup_products(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["skus"],
        |parse, args| {
            let skus = parse.at("skus").skus(args.get("skus"), 30);
            json!({ "skus": skus.unwrap_or_default() })
        },
        |_| None,
    )
}

/// A slug and a page: `list_category_products` and `list_products_by_tag`.
pub fn slug_page(arguments: &Map<String, Value>) -> Result<(String, i64), String> {
    object(
        arguments,
        &["slug", "page"],
        |parse, args| {
            (
                required(parse, args, "slug", |p, v| p.slug(v)),
                page(parse, args),
            )
        },
        |_| None,
    )
}

pub fn page_only(arguments: &Map<String, Value>) -> Result<i64, String> {
    object(arguments, &["page"], page, |_| None)
}

pub fn list_orders(arguments: &Map<String, Value>) -> Result<(Window, Query), String> {
    const TYPES: [&str; 4] = ["delivery", "pickup", "scan_n_go", "digital"];
    let (window, year, month, kind) = object(
        arguments,
        &["limit", "offset", "year", "month", "type"],
        |parse, args| {
            (
                window(parse, args),
                optional(parse, args, "year", |p, v| p.int(v, Some(2000), Some(2100))),
                optional(parse, args, "month", |p, v| p.int(v, Some(1), Some(12))),
                optional(parse, args, "type", |p, v| p.option(v, &TYPES)),
            )
        },
        |_| {
            (args_present(arguments, "year") != args_present(arguments, "month"))
                .then_some("Provide year and month together")
        },
    )?;
    let mut query = Query::new();
    query.extend(year.map(|year| ("year", year.to_string())));
    query.extend(month.map(|month| ("month", month.to_string())));
    query.extend(kind.map(|kind| ("type", kind.to_owned())));
    Ok((window, query))
}

/// A resource token: `get_order` and `get_product_list`.
pub fn token(arguments: &Map<String, Value>) -> Result<String, String> {
    object(
        arguments,
        &["token"],
        |parse, args| required(parse, args, "token", |p, v| p.token(v)),
        |_| None,
    )
}

const RANGE_TOGETHER: &str =
    "Provide fromYear, fromMonth, toYear, and toMonth together, or none of them";

const ONE_FILTER: &str = "Provide exactly one of nameContains or skus";

/// Both refinements failed: zod reports both, each at the root, joined as one text.
const RANGE_AND_FILTER: &str = "Provide fromYear, fromMonth, toYear, and toMonth together, or none of them, Provide exactly one of nameContains or skus";

pub fn summarize_order_lines(arguments: &Map<String, Value>) -> Result<Query, String> {
    const RANGE: [&str; 4] = ["fromYear", "fromMonth", "toYear", "toMonth"];
    let (range, name, skus) = object(
        arguments,
        &[
            "fromYear",
            "fromMonth",
            "toYear",
            "toMonth",
            "nameContains",
            "skus",
        ],
        |parse, args| {
            let year = |parse: &mut Parse, key| {
                optional(parse, args, key, |p, v| p.int(v, Some(2000), Some(2100)))
            };
            let month = |parse: &mut Parse, key| {
                optional(parse, args, key, |p, v| p.int(v, Some(1), Some(12)))
            };
            let range = [
                year(parse, "fromYear"),
                month(parse, "fromMonth"),
                year(parse, "toYear"),
                month(parse, "toMonth"),
            ];
            (
                range,
                optional(parse, args, "nameContains", |p, v| p.string(v, (2, 100))),
                optional(parse, args, "skus", |p, v| p.skus(v, 10)),
            )
        },
        |_| {
            let given = RANGE
                .iter()
                .filter(|key| args_present(arguments, key))
                .count();
            let range = given != 0 && given != RANGE.len();
            let filter = args_present(arguments, "nameContains") == args_present(arguments, "skus");

            match (range, filter) {
                (true, true) => Some(RANGE_AND_FILTER),
                (true, false) => Some(RANGE_TOGETHER),
                (false, true) => Some(ONE_FILTER),
                (false, false) => None,
            }
        },
    )?;
    // Krónan reads snake_case query names; the input validated that the range is all-or-nothing.
    let mut query = Query::new();

    for (name, part) in ["from_year", "from_month", "to_year", "to_month"]
        .into_iter()
        .zip(range)
    {
        query.extend(part.map(|part| (name, part.to_string())));
    }
    query.extend(name.map(|name| ("name_contains", name)));
    query.extend(skus.into_iter().flatten().map(|sku| ("skus", sku)));
    Ok(query)
}

pub fn purchase_stats(arguments: &Map<String, Value>) -> Result<(Window, Query), String> {
    const SORTS: [&str; 4] = ["recent", "oldest", "most_frequent", "most_quantity"];
    object(
        arguments,
        &["limit", "offset", "sort", "includeIgnored"],
        |parse, args| {
            let window = window(parse, args);
            let sort = match args.get("sort") {
                None => "recent",
                value => parse.at("sort").option(value, &SORTS).unwrap_or_default(),
            };
            let ignored = parse
                .at("includeIgnored")
                .boolean_or(args.get("includeIgnored"), false);
            (
                window,
                vec![
                    ("sort", sort.to_owned()),
                    ("include_ignored", ignored.to_string()),
                ],
            )
        },
        |_| None,
    )
}

pub fn offset(arguments: &Map<String, Value>) -> Result<Window, String> {
    object(arguments, &["limit", "offset"], window, |_| None)
}

pub fn search_recipes(arguments: &Map<String, Value>) -> Result<Value, String> {
    const ORDERS: [&str; 3] = ["default", "top", "cooking_time"];
    const SHAPE: [&str; 7] = [
        "query",
        "tags",
        "ingredientTags",
        "cuisineTags",
        "occasionTags",
        "page",
        "orderBy",
    ];
    object(
        arguments,
        &SHAPE,
        |parse, args| {
            let mut body = Map::new();
            let query = match args.get("query") {
                None => String::new(),
                value => parse.at("query").string(value, (0, 64)).unwrap_or_default(),
            };
            body.insert("query".to_owned(), json!(query));

            for key in ["tags", "ingredientTags", "cuisineTags", "occasionTags"] {
                body.insert(key.to_owned(), json!(parse.at(key).tag_ids(args.get(key))));
            }
            body.insert("page".to_owned(), json!(page(parse, args)));
            let order = match args.get("orderBy") {
                None => "default",
                value => parse
                    .at("orderBy")
                    .option(value, &ORDERS)
                    .unwrap_or_default(),
            };
            body.insert("orderBy".to_owned(), json!(order));
            Value::Object(body)
        },
        |_| None,
    )
}

pub fn delivery_slots(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["addressId"],
        |parse, args| json!({ "addressId": parse.at("addressId").int(args.get("addressId"), Some(0), None) }),
        |_| None,
    )
}

pub fn pickup_slots(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["chain"],
        |parse, args| {
            let chain = match args.get("chain") {
                None => "kronan",
                value => parse
                    .at("chain")
                    .option(value, &["kronan", "pikkolo"])
                    .unwrap_or_default(),
            };
            json!({ "chain": chain })
        },
        |_| None,
    )
}

pub fn recipe(arguments: &Map<String, Value>) -> Result<String, String> {
    object(
        arguments,
        &["slug"],
        |parse, args| required(parse, args, "slug", |p, v| p.slug(v)),
        |_| None,
    )
}

pub fn preview_checkout_lines(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["lines"],
        |parse, args| {
            let lines = parse
                .at("lines")
                .array(args.get("lines"), (1, 100), |parse, item| {
                    let Some(line) = item.as_object() else {
                        parse.wrong_type("object", Some(item));
                        return None;
                    };
                    Some(line_of(parse, line, &["sku", "quantity"], (1, 500)))
                });
            json!({ "lines": lines.unwrap_or_default() })
        },
        |_| None,
    )
}

/// One checkout line inside an array: a strict object of `sku` and `quantity` (default 1).
fn line_of(
    parse: &mut Parse,
    line: &Map<String, Value>,
    shape: &[&str],
    quantity: (i64, i64),
) -> Value {
    let sku = required(parse, line, "sku", |p, v| p.sku(v));
    let count = parse
        .at("quantity")
        .int_or(line.get("quantity"), quantity, 1);
    unknown_keys(parse, line, shape);
    json!({ "sku": sku, "quantity": count })
}

/// A nested strict object's unknown keys, as zod reports them at the object's path.
fn unknown_keys(parse: &mut Parse, line: &Map<String, Value>, shape: &[&str]) {
    let unknown: Vec<String> = crate::js::order(line.clone())
        .keys()
        .filter(|key| !shape.contains(&key.as_str()))
        .map(|key| Value::String(key.clone()).to_string())
        .collect();

    if !unknown.is_empty() {
        let plural = if unknown.len() > 1 { "s" } else { "" };
        parse.issue(
            format!("Unrecognized key{plural}: {}", unknown.join(", ")),
            true,
        );
    }
}

// Write inputs. Gate fields such as confirm and the expected values never leave this server.

/// What the user approved for a money tool, checked against the live checkout before sending.
#[derive(Debug, Clone, PartialEq)]
pub struct Approval {
    pub total: i64,
    pub checkout_token: String,
}

/// Whether a property is present with a value of the wrong type, which aborts an object's
/// refinement.
fn mistyped(line: &Map<String, Value>, key: &str, expected: fn(&Value) -> bool) -> bool {
    line.get(key).is_some_and(|value| !expected(value))
}

/// One shopping note line inside an array: exactly one of `text` or `sku` (at most 32
/// characters), and an optional quantity.
fn note_line(parse: &mut Parse, line: &Map<String, Value>) -> Value {
    let text = optional(parse, line, "text", |p, v| p.string(v, (1, 255)));
    let sku = optional(parse, line, "sku", |p, v| {
        let sku = p.sku(v);
        p.length(v, (0, 32));
        sku
    });
    let quantity = optional(parse, line, "quantity", |p, v| {
        p.int(v, Some(0), Some(10_000))
    });
    unknown_keys(parse, line, &["text", "sku", "quantity"]);
    let aborted = mistyped(line, "text", Value::is_string)
        || mistyped(line, "sku", Value::is_string)
        || mistyped(line, "quantity", |value| {
            value.as_f64().is_some_and(|number| number.fract() == 0.0)
        });

    if !aborted && args_present(line, "text") == args_present(line, "sku") {
        parse.issue(
            "Provide exactly one of text or sku per line".to_owned(),
            true,
        );
    }
    let mut body = Map::new();
    body.extend(text.map(|text| ("text".to_owned(), json!(text))));
    body.extend(sku.map(|sku| ("sku".to_owned(), json!(sku))));
    body.extend(quantity.map(|quantity| ("quantity".to_owned(), json!(quantity))));
    Value::Object(body)
}

pub fn add_shopping_note_lines(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["lines"],
        |parse, args| {
            let lines = parse
                .at("lines")
                .array(args.get("lines"), (1, 30), |parse, item| {
                    let Some(line) = item.as_object() else {
                        parse.wrong_type("object", Some(item));
                        return None;
                    };
                    Some(note_line(parse, line))
                });
            json!({ "lines": lines.unwrap_or_default() })
        },
        |_| None,
    )
}

pub fn change_shopping_note_line(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["token", "text", "quantity"],
        |parse, args| {
            let mut body = Map::new();
            body.insert(
                "token".to_owned(),
                json!(required(parse, args, "token", |p, v| p.guid(v))),
            );

            if let Some(text) = optional(parse, args, "text", |p, v| p.string(v, (1, 255))) {
                body.insert("text".to_owned(), json!(text));
            }

            if let Some(quantity) = optional(parse, args, "quantity", |p, v| {
                p.int(v, Some(0), Some(10_000))
            }) {
                body.insert("quantity".to_owned(), json!(quantity));
            }
            Value::Object(body)
        },
        // Krónan deletes the line when both are absent; deletion has its own tool.
        |_| {
            (!args_present(arguments, "text") && !args_present(arguments, "quantity"))
                .then_some("Provide text, quantity, or both")
        },
    )
}

/// A shopping note line token: `toggle_shopping_note_line_complete` and
/// `delete_shopping_note_line`.
pub fn line_token(arguments: &Map<String, Value>) -> Result<String, String> {
    object(
        arguments,
        &["token"],
        |parse, args| required(parse, args, "token", |p, v| p.guid(v)),
        |_| None,
    )
}

pub fn clear_shopping_note(arguments: &Map<String, Value>) -> Result<(), String> {
    object(
        arguments,
        &["confirm"],
        |parse, args| parse.at("confirm").confirm(args.get("confirm")),
        |_| None,
    )
}

/// One checkout line to set: `sku`, `quantity` (0 to 500, default 1) and optional
/// `substitution`.
fn checkout_line(parse: &mut Parse, line: &Map<String, Value>) -> Value {
    let sku = required(parse, line, "sku", |p, v| p.sku(v));
    let quantity = parse
        .at("quantity")
        .int_or(line.get("quantity"), (0, 500), 1);
    let substitution = optional(parse, line, "substitution", |p, v| p.boolean(v));
    unknown_keys(parse, line, &["sku", "quantity", "substitution"]);
    let mut body = Map::new();
    body.insert("sku".to_owned(), json!(sku));
    body.insert("quantity".to_owned(), json!(quantity));
    body.extend(substitution.map(|flag| ("substitution".to_owned(), json!(flag))));
    Value::Object(body)
}

pub fn set_checkout_lines(arguments: &Map<String, Value>) -> Result<Value, String> {
    object(
        arguments,
        &["lines", "replace"],
        |parse, args| {
            let lines = parse
                .at("lines")
                .array(args.get("lines"), (1, 100), |parse, item| {
                    let Some(line) = item.as_object() else {
                        parse.wrong_type("object", Some(item));
                        return None;
                    };
                    Some(checkout_line(parse, line))
                });
            let replace = parse.at("replace").boolean(args.get("replace"));
            json!({ "lines": lines.unwrap_or_default(), "replace": replace })
        },
        |_| None,
    )
}

/// `confirm`, `expectedTotal` and `expectedCheckoutToken`, in that order after a body's fields.
fn approval(parse: &mut Parse, args: &Map<String, Value>) -> Approval {
    parse.at("confirm").confirm(args.get("confirm"));
    let total = parse
        .at("expectedTotal")
        .int(args.get("expectedTotal"), Some(0), None);
    let checkout_token = required(parse, args, "expectedCheckoutToken", |p, v| p.token(v));
    Approval {
        total: total.unwrap_or_default(),
        checkout_token,
    }
}

const GATE: [&str; 3] = ["confirm", "expectedTotal", "expectedCheckoutToken"];

/// A slot reservation or checkout completion: the body sent to Krónan and the approval.
fn placement(
    arguments: &Map<String, Value>,
    address: Option<bool>,
) -> Result<(Approval, Value), String> {
    let mut shape = vec!["slotId"];
    shape.extend(address.map(|_| "addressId"));
    shape.push("returnBags");
    shape.extend(GATE);
    object(
        arguments,
        &shape,
        |parse, args| {
            let mut body = Map::new();
            let slot = parse.at("slotId").int(args.get("slotId"), Some(0), None);
            body.insert("slotId".to_owned(), json!(slot));
            let address = match address {
                Some(true) => Some(
                    parse
                        .at("addressId")
                        .int(args.get("addressId"), Some(0), None),
                ),
                Some(false) => {
                    optional(parse, args, "addressId", |p, v| p.int(v, Some(0), None)).map(Some)
                }
                None => None,
            };
            body.extend(address.map(|id| ("addressId".to_owned(), json!(id))));
            let bags = parse.at("returnBags").boolean(args.get("returnBags"));
            body.insert("returnBags".to_owned(), json!(bags));
            (approval(parse, args), Value::Object(body))
        },
        |_| None,
    )
}

pub fn reserve_delivery_slot(arguments: &Map<String, Value>) -> Result<(Approval, Value), String> {
    placement(arguments, Some(true))
}

pub fn reserve_pickup_slot(arguments: &Map<String, Value>) -> Result<(Approval, Value), String> {
    placement(arguments, None)
}

pub fn complete_checkout(arguments: &Map<String, Value>) -> Result<(Approval, Value), String> {
    placement(arguments, Some(false))
}

/// The approval and the approved active order token.
pub fn add_checkout_to_order(arguments: &Map<String, Value>) -> Result<(Approval, String), String> {
    let mut shape = GATE.to_vec();
    shape.push("expectedOrderToken");
    object(
        arguments,
        &shape,
        |parse, args| {
            let approval = approval(parse, args);
            let order = required(parse, args, "expectedOrderToken", |p, v| p.token(v));
            (approval, order)
        },
        |_| None,
    )
}

/// A placed-order change: the order token and the body. `quantity` adds the new quantity for
/// `lower_order_line_quantities`; `confirm` is required for the destructive changes.
fn order_change(
    arguments: &Map<String, Value>,
    quantity: bool,
    confirm: bool,
) -> Result<(String, Value), String> {
    let mut shape = vec!["lineIds"];
    shape.extend(quantity.then_some("quantity"));
    shape.push("orderToken");
    shape.extend(confirm.then_some("confirm"));
    object(
        arguments,
        &shape,
        |parse, args| {
            let mut body = Map::new();
            let ids = parse.at("lineIds").line_ids(args.get("lineIds"));
            body.insert("lineIds".to_owned(), json!(ids));

            if quantity {
                let count = parse
                    .at("quantity")
                    .int(args.get("quantity"), Some(0), Some(10_000));
                body.insert("quantity".to_owned(), json!(count));
            }
            let token = required(parse, args, "orderToken", |p, v| p.token(v));

            if confirm {
                parse.at("confirm").confirm(args.get("confirm"));
            }
            (token, Value::Object(body))
        },
        |_| None,
    )
}

pub fn delete_order_lines(arguments: &Map<String, Value>) -> Result<(String, Value), String> {
    order_change(arguments, false, true)
}

pub fn lower_order_line_quantities(
    arguments: &Map<String, Value>,
) -> Result<(String, Value), String> {
    order_change(arguments, true, true)
}

pub fn toggle_order_line_substitution(
    arguments: &Map<String, Value>,
) -> Result<(String, Value), String> {
    order_change(arguments, false, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn bodies_keep_schema_order_and_defaults() {
        assert_eq!(
            search_products(&args(json!({"withDetail": true, "query": "milk"})))
                .unwrap()
                .to_string(),
            r#"{"query":"milk","page":1,"pageSize":20,"withDetail":true,"includePurchaseHistory":false}"#
        );
        assert_eq!(
            search_recipes(&args(json!({"tags": [1]})))
                .unwrap()
                .to_string(),
            r#"{"query":"","tags":[1],"ingredientTags":[],"cuisineTags":[],"occasionTags":[],"page":1,"orderBy":"default"}"#
        );
        assert_eq!(
            summarize_order_lines(&args(json!({"skus": ["A", "B"], "fromYear": 2025, "fromMonth": 1, "toYear": 2025, "toMonth": 6}))).unwrap(),
            vec![
                ("from_year", "2025".to_owned()),
                ("from_month", "1".to_owned()),
                ("to_year", "2025".to_owned()),
                ("to_month", "6".to_owned()),
                ("skus", "A".to_owned()),
                ("skus", "B".to_owned()),
            ]
        );
    }

    #[test]
    fn slugs_take_letters_and_numbers_of_any_script() {
        assert!(recipe(&args(json!({"slug": "mjólk-٣_x.y"}))).is_ok());
        for invalid in ["a/b", "..", "\u{24b6}", "a\u{345}", ""] {
            assert!(
                recipe(&args(json!({ "slug": invalid }))).is_err(),
                "{invalid}"
            );
        }
    }
}
