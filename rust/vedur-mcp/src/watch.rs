//! `get_weather_watch`: the duty forecasters' Veðurvakt posts from the vaktin RSS feed.
//! Editorial commentary, never an official warning.

use chrono::{DateTime, Utc};
use mcp_runtime::Fail;
use roxmltree::{Document, Node};
use serde_json::{Value, json};

use crate::http::{Fetched, GOTTVEDUR};
use crate::output::{Output, envelope, timestamp};
use crate::text;

pub const SHAPE: Fail = Fail::Safe(
    "The gottvedur.is vaktin feed was not readable RSS. The feed may have changed; no posts were read.",
);

pub const REFUSED: Fail = Fail::Safe("gottvedur.is refused the vaktin feed request.");

pub const MAX_BYTES: usize = 4 * 1024 * 1024;

const CATEGORY: &str = "Veðurvakt";

const CONTENT: &str = "http://purl.org/rss/1.0/modules/content/";

const MAX_TEXT: usize = 2000;

const NOTE: &str = "Editorial commentary from IMO's duty forecasters (category Veðurvakt), not an official warning. An old post does not mean a warning is active; use get_weather_alerts for official warnings.";

/// With its trailing slash: the address without one answers 308 to this one, and redirects are
/// not followed.
pub fn url() -> String {
    format!("{GOTTVEDUR}/rss.xml/vaktin/")
}

fn child_text<'a>(item: Node<'a, '_>, name: &str, namespace: Option<&str>) -> Option<&'a str> {
    item.children()
        .find(|child| {
            child.is_element()
                && child.tag_name().name() == name
                && child.tag_name().namespace() == namespace
        })
        .and_then(|child| child.text())
}

/// Characters that can start or end a Markdown link or image, percent-encoded in a passed link.
const MARKDOWN: [(char, &str); 4] = [('[', "%5B"), (']', "%5D"), ('(', "%28"), (')', "%29")];

/// Only links to IMO's own sites are passed on, with no Markdown-active brackets or parentheses.
fn imo_link(link: &str) -> Value {
    let Ok(url) = reqwest::Url::parse(link.trim()) else {
        return Value::Null;
    };
    let own = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && matches!(
            url.host_str(),
            Some("gottvedur.is" | "www.gottvedur.is" | "vedur.is" | "www.vedur.is" | "en.vedur.is")
        );
    if !own || link.len() > 500 {
        return Value::Null;
    }
    let mut serialized = String::from(url);

    for (character, encoded) in MARKDOWN {
        serialized = serialized.replace(character, encoded);
    }
    json!(serialized)
}

pub fn shape(fetched: &Fetched, limit: i64) -> Output {
    let source = std::str::from_utf8(&fetched.body).map_err(|_| SHAPE)?;
    let document = Document::parse(source).map_err(|_| SHAPE)?;
    let channel = document
        .root_element()
        .children()
        .find(|node| node.has_tag_name("channel"))
        .filter(|_| document.root_element().has_tag_name("rss"))
        .ok_or(SHAPE)?;
    let mut posts = Vec::new();

    for item in channel.children().filter(|node| node.has_tag_name("item")) {
        let categories: Vec<String> = item
            .children()
            .filter(|node| node.has_tag_name("category"))
            .filter_map(|node| node.text())
            .map(|category| text::clean(category, 100))
            .take(20)
            .collect();

        if !categories.iter().any(|category| category == CATEGORY) {
            continue;
        }
        let published = child_text(item, "pubDate", None).unwrap_or_default();
        let published_at = DateTime::parse_from_rfc2822(published.trim())
            .ok()
            .map(|time| time.with_timezone(&Utc));
        let body = child_text(item, "encoded", Some(CONTENT))
            .or_else(|| child_text(item, "description", None))
            .unwrap_or_default();
        let (plain, truncated) = text::plain_text(body, MAX_TEXT);
        let summary =
            child_text(item, "description", None).map(|summary| text::clean(summary, 500));

        posts.push((
            published_at,
            json!({
                "title": text::clean(child_text(item, "title", None).unwrap_or_default(), 300),
                "published": text::clean(published, 60),
                "published_utc": published_at.map(timestamp),
                "link": child_text(item, "link", None).map_or(Value::Null, imo_link),
                "categories": categories,
                "summary": summary,
                "text": plain,
                "text_truncated": truncated,
            }),
        ));
    }
    // Newest first; posts without a readable date go last, in feed order.
    posts.sort_by(|(left, _), (right, _)| right.cmp(left));
    let matching = posts.len();
    let url = url();
    let mut output = envelope(
        "gottvedur.is vaktin RSS feed (Veðurvakt)",
        "gottvedur.is RSS feed",
        &[&url],
        &[fetched],
    );
    output.insert("note".into(), json!(NOTE));
    output.insert("matching_posts".into(), json!(matching));
    output.insert(
        "posts".into(),
        Value::Array(
            posts
                .into_iter()
                .take(limit as usize)
                .map(|(_, post)| post)
                .collect(),
        ),
    );
    Ok(Value::Object(output))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_imo_https_links_pass() {
        assert_eq!(
            imo_link("https://gottvedur.is/vaktin/x/"),
            json!("https://gottvedur.is/vaktin/x/")
        );
        for link in [
            "http://gottvedur.is/vaktin/x/",
            "https://gottvedur.is.evil.example/",
            "https://user@gottvedur.is/",
            "https://gottvedur.is:8443/",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(imo_link(link), Value::Null, "{link}");
        }
        assert_eq!(
            imo_link("https://gottvedur.is/[a](b)?q=[c]#[d]"),
            json!("https://gottvedur.is/%5Ba%5D%28b%29?q=%5Bc%5D#%5Bd%5D")
        );
    }
}
