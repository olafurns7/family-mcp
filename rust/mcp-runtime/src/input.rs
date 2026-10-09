//! The server-independent parts of zod 4 input validation: issue messages, order and abort rules
//! of strict objects, strings and arrays, so an invalid call gets the TypeScript server's text.
//! A server adds its own field checks on [`Parse`] and passes them to [`object`].

use serde_json::{Map, Value};

struct Issue {
    path: Vec<String>,
    message: String,
    /// zod's `continue`: a failed check keeps later checks and refinements running; a wrong type
    /// does not.
    continues: bool,
}

/// The issues of one parse, at one path.
pub struct Parse<'a> {
    issues: &'a mut Vec<Issue>,
    path: Vec<String>,
}

/// The type name zod reports for a value it received.
pub fn kind(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// A string's length as zod 4.6 checks it: Unicode code points, not UTF-16 units.
fn length(text: &str) -> usize {
    text.chars().count()
}

/// A key `JSON.parse` and object literals order first: a canonical array index below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    let index: u32 = key.parse().ok()?;
    (index != u32::MAX && index.to_string() == key).then_some(index)
}

/// The keys in JavaScript order: integer-like keys first in ascending order, then the rest in
/// insertion order.
fn ordered_keys(map: &Map<String, Value>) -> Vec<&String> {
    let (mut indexed, named): (Vec<_>, Vec<_>) =
        map.keys().partition(|key| array_index(key).is_some());
    indexed.sort_by_key(|key| array_index(key));
    indexed.into_iter().chain(named).collect()
}

impl Parse<'_> {
    /// The parse of a property or element.
    pub fn at(&mut self, key: &str) -> Parse<'_> {
        let mut path = self.path.clone();
        path.push(key.to_owned());
        Parse {
            issues: self.issues,
            path,
        }
    }

    /// An issue at this path; `continues` is zod's `continue`.
    pub fn issue(&mut self, message: String, continues: bool) {
        self.issues.push(Issue {
            path: self.path.clone(),
            message,
            continues,
        });
    }

    pub fn wrong_type(&mut self, expected: &str, value: Option<&Value>) {
        self.issue(
            format!(
                "Invalid input: expected {expected}, received {}",
                kind(value)
            ),
            false,
        );
    }

    /// zod's length checks run on anything with a length, even after a wrong type. An object
    /// with its own `length` property is not counted here.
    pub fn length(&mut self, value: Option<&Value>, (min, max): (usize, usize)) {
        let (origin, unit, length) = match value {
            Some(Value::String(text)) => ("string", "characters", length(text)),
            Some(Value::Array(items)) => ("array", "items", items.len()),
            _ => return,
        };

        if length < min {
            self.issue(
                format!("Too small: expected {origin} to have >={min} {unit}"),
                true,
            );
        }

        if length > max {
            self.issue(
                format!("Too big: expected {origin} to have <={max} {unit}"),
                true,
            );
        }
    }

    /// `z.string().min(min).max(max)`.
    pub fn string(&mut self, value: Option<&Value>, bounds: (usize, usize)) -> Option<String> {
        let text = value.and_then(Value::as_str).map(str::to_owned);

        if text.is_none() {
            self.wrong_type("string", value);
        }
        self.length(value, bounds);
        text
    }

    /// `z.array(element).min(min).max(max)`. Every element is checked, so each failed element
    /// reports its issues in order, as zod does.
    pub fn array<T>(
        &mut self,
        value: Option<&Value>,
        bounds: (usize, usize),
        mut element: impl FnMut(&mut Parse, &Value) -> Option<T>,
    ) -> Option<Vec<T>> {
        let parsed = match value {
            Some(Value::Array(items)) => {
                let parsed: Vec<_> = items
                    .iter()
                    .enumerate()
                    .map(|(index, item)| element(&mut self.at(&index.to_string()), item))
                    .collect();
                parsed.into_iter().collect()
            }
            _ => {
                self.wrong_type("array", value);
                None
            }
        };
        self.length(value, bounds);
        parsed
    }
}

/// A strict object: properties in schema order, then unknown keys, then the refinement when
/// nothing aborted. Returns the zod error text, as `path: message` joined with `, `.
pub fn object<T>(
    arguments: &Map<String, Value>,
    shape: &[&str],
    parse: impl FnOnce(&mut Parse, &Map<String, Value>) -> T,
    refine: impl FnOnce(&T) -> Option<&'static str>,
) -> Result<T, String> {
    let mut issues = Vec::new();
    let mut root = Parse {
        issues: &mut issues,
        path: Vec::new(),
    };
    let parsed = parse(&mut root, arguments);
    let unknown: Vec<String> = ordered_keys(arguments)
        .into_iter()
        .filter(|key| !shape.contains(&key.as_str()))
        .map(|key| Value::String(key.clone()).to_string())
        .collect();

    if !unknown.is_empty() {
        let plural = if unknown.len() > 1 { "s" } else { "" };
        root.issue(
            format!("Unrecognized key{plural}: {}", unknown.join(", ")),
            true,
        );
    }

    if issues.iter().all(|issue| issue.continues)
        && let Some(message) = refine(&parsed)
    {
        issues.push(Issue {
            path: Vec::new(),
            message: message.to_owned(),
            continues: true,
        });
    }

    if issues.is_empty() {
        return Ok(parsed);
    }
    Err(issues
        .iter()
        .map(|issue| match issue.path.is_empty() {
            true => issue.message.clone(),
            false => format!("{}: {}", issue.path.join("."), issue.message),
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// An optional property: parsed at its key when present.
pub fn optional<'a, T>(
    parse: &mut Parse,
    arguments: &'a Map<String, Value>,
    key: &str,
    field: impl FnOnce(&mut Parse, Option<&'a Value>) -> Option<T>,
) -> Option<T> {
    let value = arguments.get(key)?;
    field(&mut parse.at(key), Some(value))
}

/// `z.object({}).strict()`: a tool without arguments.
pub fn empty(arguments: &Map<String, Value>) -> Result<(), String> {
    object(arguments, &[], |_, _| (), |_| None)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn args(value: Value) -> Map<String, Value> {
        match value {
            Value::Object(map) => map,
            _ => unreachable!(),
        }
    }

    #[test]
    fn unknown_keys_follow_javascript_order() {
        assert_eq!(empty(&args(json!({}))), Ok(()));
        assert_eq!(
            empty(&args(json!({"a": 1}))).unwrap_err(),
            r#"Unrecognized key: "a""#
        );
        assert_eq!(
            empty(&args(json!({"zzz": 1, "10": 2, "2": 3, "01": 4, "\"": 5}))).unwrap_err(),
            r#"Unrecognized keys: "2", "10", "zzz", "01", "\"""#
        );
    }

    fn named(
        arguments: &Map<String, Value>,
    ) -> Result<(Option<String>, Option<Vec<String>>), String> {
        object(
            arguments,
            &["name", "tags"],
            |parse, args| {
                (
                    parse.at("name").string(args.get("name"), (1, 3)),
                    optional(parse, args, "tags", |p, v| {
                        p.array(v, (1, 2), |p, item| p.string(Some(item), (1, 2)))
                    }),
                )
            },
            |(name, _)| (name.as_deref() == Some("no")).then_some("name must not be no"),
        )
    }

    #[test]
    fn issues_are_joined_with_their_paths() {
        assert_eq!(
            named(&args(json!({"name": "abc", "tags": ["a"]}))),
            Ok((Some("abc".to_owned()), Some(vec!["a".to_owned()])))
        );
        assert_eq!(
            named(&args(json!({"tags": ["abc", 1], "x": 0}))).unwrap_err(),
            "name: Invalid input: expected string, received undefined, tags.0: Too big: expected string to have <=2 characters, tags.1: Invalid input: expected string, received number, Unrecognized key: \"x\""
        );
        assert_eq!(
            named(&args(
                json!({"name": "\u{1F642}\u{1F642}\u{1F642}", "tags": []})
            ))
            .unwrap_err(),
            "tags: Too small: expected array to have >=1 items"
        );
        assert_eq!(
            named(&args(json!({"name": "no"}))).unwrap_err(),
            "name must not be no"
        );
        // A wrong type aborts the refinement; a failed check does not.
        assert_eq!(
            named(&args(json!({"name": "no", "tags": "a"}))).unwrap_err(),
            "tags: Invalid input: expected array, received string"
        );
        assert_eq!(
            named(&args(json!({"name": "no", "tags": []}))).unwrap_err(),
            "tags: Too small: expected array to have >=1 items, name must not be no"
        );
    }

    /// `z.object({ ids: z.array(z.string().min(1).max(256)).min(1).max(50).optional() })`.
    fn ids(arguments: Value) -> Result<Option<Vec<String>>, String> {
        object(
            &args(arguments),
            &["ids"],
            |parse, args| {
                optional(parse, args, "ids", |p, v| {
                    p.array(v, (1, 50), |p, item| p.string(Some(item), (1, 256)))
                })
            },
            |_| None,
        )
    }

    #[test]
    fn every_array_element_is_checked() {
        // Texts from zod 4.6.2's safeParse of the same schema.
        let long = "x".repeat(300);
        let wrong = "Invalid input: expected string, received number";
        let too_big = "Too big: expected string to have <=256 characters";
        assert_eq!(
            ids(json!({"ids": [1, long]})).unwrap_err(),
            format!("ids.0: {wrong}, ids.1: {too_big}")
        );
        assert_eq!(
            ids(json!({"ids": [1, 2]})).unwrap_err(),
            format!("ids.0: {wrong}, ids.1: {wrong}")
        );
        assert_eq!(
            ids(json!({"ids": [long, 1]})).unwrap_err(),
            format!("ids.0: {too_big}, ids.1: {wrong}")
        );
        let mut many = vec![json!(1), json!(2)];
        many.extend(std::iter::repeat_n(json!("a"), 49));
        assert_eq!(
            ids(json!({"ids": many})).unwrap_err(),
            format!(
                "ids.0: {wrong}, ids.1: {wrong}, ids: Too big: expected array to have <=50 items"
            )
        );
        assert_eq!(
            ids(json!({"ids": ["a", "b"]})),
            Ok(Some(vec!["a".to_owned(), "b".to_owned()]))
        );
    }
}
