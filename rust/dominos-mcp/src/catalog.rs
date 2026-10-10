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
