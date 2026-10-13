//! Upstream text is untrusted: HTML becomes plain text, and nothing that renders as HTML or as a
//! Markdown link or image reaches a tool result. Every string is bounded.

/// Tags that end a line of text.
const BLOCK_TAGS: [&str; 21] = [
    "p",
    "div",
    "br",
    "li",
    "ul",
    "ol",
    "tr",
    "table",
    "tbody",
    "thead",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "figure",
    "figcaption",
    "blockquote",
    "section",
    "article",
];

/// Elements whose content is never text.
const SKIPPED_ELEMENTS: [&str; 6] = ["script", "style", "template", "noscript", "svg", "iframe"];

/// The name of the tag that starts `tag` (the text after `<`), lowercased, and whether it closes.
fn tag_name(tag: &str) -> (String, bool) {
    let closing = tag.starts_with('/');
    let name = tag
        .trim_start_matches('/')
        .chars()
        .take_while(char::is_ascii_alphanumeric)
        .collect::<String>()
        .to_ascii_lowercase();
    (name, closing)
}

/// The byte offset just past the case-insensitive `</name ...>` in `html` from `from`, or the end.
fn past_closing(html: &str, from: usize, name: &str) -> usize {
    let needle = format!("</{name}");
    let found = html.as_bytes()[from..]
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle.as_bytes()));

    match found {
        Some(at) => {
            let after = from + at;
            html[after..]
                .find('>')
                .map_or(html.len(), |end| after + end + 1)
        }
        None => html.len(),
    }
}

fn entity(name: &str) -> Option<char> {
    if let Some(number) = name.strip_prefix('#') {
        let code = match number.strip_prefix(['x', 'X']) {
            Some(hex) => u32::from_str_radix(hex, 16).ok()?,
            None => number.parse().ok()?,
        };
        return char::from_u32(code);
    }
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        "nbsp" => ' ',
        "ndash" => '–',
        "mdash" => '—',
        "hellip" => '…',
        "deg" => '°',
        "laquo" => '«',
        "raquo" => '»',
        "bdquo" => '„',
        "ldquo" => '“',
        "rdquo" => '”',
        "lsquo" => '‘',
        "rsquo" => '’',
        "aacute" => 'á',
        "Aacute" => 'Á',
        "eacute" => 'é',
        "Eacute" => 'É',
        "iacute" => 'í',
        "Iacute" => 'Í',
        "oacute" => 'ó',
        "Oacute" => 'Ó',
        "uacute" => 'ú',
        "Uacute" => 'Ú',
        "yacute" => 'ý',
        "Yacute" => 'Ý',
        "eth" => 'ð',
        "ETH" => 'Ð',
        "thorn" => 'þ',
        "THORN" => 'Þ',
        "aelig" => 'æ',
        "AElig" => 'Æ',
        "ouml" => 'ö',
        "Ouml" => 'Ö',
        _ => return None,
    })
}

/// `text` with character references decoded; an unknown or unterminated one stays as written.
fn decode_entities(text: &str, out: &mut String) {
    let mut rest = text;

    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        rest = &rest[at..];
        let decoded = rest[1..]
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| Some((entity(&rest[1..=end])?, end + 2)));

        match decoded {
            Some((character, length)) => {
                out.push(character);
                rest = &rest[length..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
}

/// HTML as text: tags removed, block tags as line breaks, scripts, styles and comments dropped,
/// character references decoded. A `<` that opens no tag is dropped.
fn strip_tags(html: &str) -> String {
    let mut out = String::with_capacity(html.len().min(64 * 1024));
    let mut at = 0;

    while at < html.len() {
        let Some(open) = html[at..].find('<') else {
            decode_entities(&html[at..], &mut out);
            break;
        };
        decode_entities(&html[at..at + open], &mut out);
        let start = at + open;

        if html[start..].starts_with("<!--") {
            at = html[start..]
                .find("-->")
                .map_or(html.len(), |end| start + end + 3);
            continue;
        }

        let Some(close) = html[start..].find('>') else {
            // An unterminated tag: drop the rest, it is markup or junk.
            break;
        };
        let tag = &html[start + 1..start + close];
        let (name, closing) = tag_name(tag);
        at = start + close + 1;

        if !closing && SKIPPED_ELEMENTS.contains(&name.as_str()) && !tag.ends_with('/') {
            at = past_closing(html, at, &name);
        } else if BLOCK_TAGS.contains(&name.as_str()) {
            out.push('\n');
        } else if matches!(name.as_str(), "td" | "th") {
            out.push(' ');
        }
    }
    out
}

/// Characters that never reach a result: controls (except line breaks), bidirectional overrides
/// and zero-width marks.
fn hidden(character: char) -> bool {
    (character.is_control() && character != '\n')
        || matches!(character, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// Plain text without markup: angle brackets become guillemet-like quotes, Markdown link and
/// image openers are broken, whitespace collapses, and blank lines are dropped.
fn neutralise(text: &str) -> String {
    let mut lines = Vec::new();

    for line in text.split('\n') {
        let mut clean = String::with_capacity(line.len());

        for character in line.chars() {
            if hidden(character) {
                continue;
            }
            match character {
                '<' => clean.push('‹'),
                '>' => clean.push('›'),
                '\t' | '\u{A0}' => clean.push(' '),
                _ => clean.push(character),
            }
        }
        let clean = clean
            .split(' ')
            .filter(|word| !word.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
            .replace("](", "] (")
            .replace("![", "! [");

        if !clean.is_empty() {
            lines.push(clean);
        }
    }
    lines.join("\n")
}

/// At most `max_chars` characters; a cut text ends with `…`.
fn bound(text: String, max_chars: usize) -> (String, bool) {
    match text.char_indices().nth(max_chars) {
        None => (text, false),
        Some((cut, _)) => {
            let mut short = text[..cut].trim_end().to_owned();
            short.push('…');
            (short, true)
        }
    }
}

/// An HTML fragment as bounded plain text, and whether it was cut.
pub fn plain_text(html: &str, max_chars: usize) -> (String, bool) {
    bound(neutralise(&strip_tags(html)), max_chars)
}

/// A short upstream string (a name, headline or label) as bounded plain text.
pub fn clean(text: &str, max_chars: usize) -> String {
    plain_text(text, max_chars).0.replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markup_becomes_plain_text() {
        let html = r#"<p><a href="https://gottvedur.is/vidvaranir/">Sjá viðvaranir</a></p><p>Hiti &amp; vindur:&nbsp;13,6&deg;</p><h2>Stormur</h2><ul><li>Norðan</li><li>Snjór</li></ul>"#;
        assert_eq!(
            plain_text(html, 1000),
            (
                "Sjá viðvaranir\nHiti & vindur: 13,6°\nStormur\nNorðan\nSnjór".to_owned(),
                false
            )
        );
    }

    #[test]
    fn scripts_styles_comments_and_images_leave_nothing() {
        let html = "a<script>alert('x')</script>b<STYLE>p{}</style >c<!-- note -->d<img src=x onerror=alert(1)>e<script/>f";
        assert_eq!(plain_text(html, 100).0, "abcdef");
        assert_eq!(plain_text("x<script>never closed", 100).0, "x");
        assert_eq!(plain_text("x<!-- never closed", 100).0, "x");
    }

    #[test]
    fn decoded_markup_cannot_render() {
        let (text, _) = plain_text(
            "&lt;script&gt;alert(1)&lt;/script&gt; [click](https://evil.example) ![i](https://t.example/p.png)",
            200,
        );
        assert!(!text.contains('<') && !text.contains('>'), "{text}");
        assert!(!text.contains("]("), "{text}");
        assert!(!text.contains("!["), "{text}");
        assert_eq!(
            text,
            "‹script›alert(1)‹/script› [click] (https://evil.example) ! [i] (https://t.example/p.png)"
        );
    }

    #[test]
    fn unterminated_and_unknown_references_stay_safe() {
        assert_eq!(plain_text("a < b", 100).0, "a");
        assert_eq!(
            plain_text("R&D &bogus; &#0x; &#128512; &", 100).0,
            "R&D &bogus; &#0x; 😀 &"
        );
        assert_eq!(plain_text("x]]>y", 100).0, "x]]›y");
    }

    #[test]
    fn controls_and_overrides_are_removed_and_whitespace_collapses() {
        assert_eq!(
            plain_text("a\u{0}b\u{202E}c\u{200B}d \t\r e\n\n\n\nf\n", 100).0,
            "abcd e\nf"
        );
        assert_eq!(
            clean("  Reykjavík\n- Bústaðavegur ", 100),
            "Reykjavík - Bústaðavegur"
        );
    }

    #[test]
    fn long_text_is_cut_on_a_character_boundary() {
        let (text, cut) = plain_text(&"þ".repeat(50), 10);
        assert!(cut);
        assert_eq!(text, format!("{}…", "þ".repeat(10)));
        assert_eq!(plain_text("short", 5), ("short".to_owned(), false));
        assert_eq!(clean(&"x".repeat(300), 200).chars().count(), 201);
    }
}
