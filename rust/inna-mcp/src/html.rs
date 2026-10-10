//! packages/inna-mcp/src/schemas.ts's `plainText`: the WHATWG tokenizer of html5gum under
//! htmlparser2 12's tree rules in HTML mode (implied closes, void elements, an ignored nested
//! form, foreign content, end-of-input closes), so the same open, close and text callbacks arrive
//! as in TypeScript. The tree rules are rust/infomentor-mcp/src/html.rs's, which its parity suite
//! checks against htmlparser2. Nothing here runs or evaluates school content.

use html5gum::emitters::callback::{CallbackEmitter, CallbackEvent};
use html5gum::{Span, State, Tokenizer};

/// One tokenizer event, owned.
enum Event {
    Open(String),
    Attribute(String),
    Value(String),
    Close { self_closing: bool },
    End(String),
    Text(String),
}

/// htmlparser2's callbacks: `onopentag`, `onclosetag` and `ontext`.
trait Handler {
    fn open(&mut self, name: &str, attributes: &[(String, String)]);
    fn close(&mut self, name: &str);
    fn text(&mut self, text: &str);
}

const FORM_TAGS: &[&str] = &[
    "input", "option", "optgroup", "select", "button", "datalist", "textarea",
];

const HEADINGS: &[&str] = &["h1", "h2", "h3", "h4", "h5", "h6", "p"];

/// htmlparser2's `openImpliesClose`: opening a key closes these while one is the current element.
fn implied_closes(name: &str) -> &'static [&'static str] {
    match name {
        "tr" => &["tr", "th", "td"],
        "th" => &["th"],
        "td" => &["thead", "th", "td"],
        "body" => &["head", "link", "script"],
        "a" => &["a"],
        "li" => &["li"],
        "p" | "address" | "article" | "aside" | "blockquote" | "details" | "div" | "dl"
        | "fieldset" | "figcaption" | "figure" | "footer" | "form" | "header" | "hr" | "main"
        | "nav" | "ol" | "pre" | "section" | "table" | "ul" => &["p"],
        "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => HEADINGS,
        "select" | "input" | "output" | "button" | "datalist" | "textarea" => FORM_TAGS,
        "option" => &["option"],
        "optgroup" => &["optgroup", "option"],
        "dd" | "dt" => &["dd", "dt"],
        "rt" | "rp" => &["rt", "rp"],
        "tbody" | "tfoot" => &["thead", "tbody"],
        _ => &[],
    }
}

fn is_void(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "basefont"
            | "br"
            | "col"
            | "command"
            | "embed"
            | "frame"
            | "hr"
            | "img"
            | "input"
            | "isindex"
            | "keygen"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

fn is_integration(name: &str) -> bool {
    matches!(
        name,
        "mi" | "mo" | "mn" | "ms" | "mtext" | "annotation-xml" | "foreignObject" | "desc" | "title"
    )
}

/// htmlparser2's `svgTagNameAdjustments`.
fn svg_name(name: &str) -> Option<&'static str> {
    Some(match name {
        "altglyph" => "altGlyph",
        "altglyphdef" => "altGlyphDef",
        "altglyphitem" => "altGlyphItem",
        "animatecolor" => "animateColor",
        "animatemotion" => "animateMotion",
        "animatetransform" => "animateTransform",
        "clippath" => "clipPath",
        "feblend" => "feBlend",
        "fecolormatrix" => "feColorMatrix",
        "fecomponenttransfer" => "feComponentTransfer",
        "fecomposite" => "feComposite",
        "feconvolvematrix" => "feConvolveMatrix",
        "fediffuselighting" => "feDiffuseLighting",
        "fedisplacementmap" => "feDisplacementMap",
        "fedistantlight" => "feDistantLight",
        "fedropshadow" => "feDropShadow",
        "feflood" => "feFlood",
        "fefunca" => "feFuncA",
        "fefuncb" => "feFuncB",
        "fefuncg" => "feFuncG",
        "fefuncr" => "feFuncR",
        "fegaussianblur" => "feGaussianBlur",
        "feimage" => "feImage",
        "femerge" => "feMerge",
        "femergenode" => "feMergeNode",
        "femorphology" => "feMorphology",
        "feoffset" => "feOffset",
        "fepointlight" => "fePointLight",
        "fespecularlighting" => "feSpecularLighting",
        "fespotlight" => "feSpotLight",
        "fetile" => "feTile",
        "feturbulence" => "feTurbulence",
        "foreignobject" => "foreignObject",
        "glyphref" => "glyphRef",
        "lineargradient" => "linearGradient",
        "radialgradient" => "radialGradient",
        "textpath" => "textPath",
        _ => return None,
    })
}

/// The tokenizer state after a text-only start tag outside foreign content.
fn text_state(name: &str) -> Option<State> {
    match name {
        "script" => Some(State::ScriptData),
        "style" | "xmp" | "iframe" | "noembed" | "noframes" => Some(State::RawText),
        "title" | "textarea" => Some(State::RcData),
        "plaintext" => Some(State::PlainText),
        _ => None,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Foreign {
    None,
    Svg,
    MathMl,
}

/// The start tag being read: its name ("" for an ignored nested form) and first attributes.
struct Pending {
    name: String,
    attributes: Vec<(String, String)>,
    /// The attribute a value belongs to; `None` after a duplicate name.
    current: Option<usize>,
    /// Whether the tag began in foreign content, where no tag is text-only.
    foreign: bool,
    raw: String,
}

/// htmlparser2's `Parser` stack, foreign-context stack and callbacks.
struct Tree<'h> {
    stack: Vec<String>,
    foreign: Vec<Foreign>,
    handler: &'h mut dyn Handler,
}

impl Tree<'_> {
    fn in_foreign(&self) -> bool {
        self.foreign.last() != Some(&Foreign::None)
    }

    /// `readTagName` for an already lowercased name.
    fn tag_name(&self, name: &str) -> String {
        if self.foreign.last() == Some(&Foreign::Svg) {
            return svg_name(name).unwrap_or(name).to_owned();
        }

        if self.foreign.len() > 1
            && let Some(adjusted) = svg_name(name)
            && self.stack.iter().any(|open| open == adjusted)
        {
            return adjusted.to_owned();
        }

        match (self.in_foreign(), name) {
            (false, "image") => "img".to_owned(),
            _ => name.to_owned(),
        }
    }

    fn pop(&mut self) {
        let Some(element) = self.stack.pop() else {
            return;
        };

        if matches!(element.as_str(), "math" | "svg") || is_integration(&element) {
            self.foreign.pop();
        }
        self.handler.close(&element);
    }

    /// `emitOpenTag`: "" when a form is already open, as the spec ignores a nested one.
    fn emit_open(&mut self, name: String) -> String {
        if name == "form" && self.stack.iter().any(|open| open == "form") {
            return String::new();
        }
        let closes = implied_closes(&name);

        while self
            .stack
            .last()
            .is_some_and(|top| closes.contains(&top.as_str()))
        {
            self.pop();
        }

        if !is_void(&name) {
            self.stack.push(name.clone());

            match name.as_str() {
                "svg" => self.foreign.push(Foreign::Svg),
                "math" => self.foreign.push(Foreign::MathMl),
                _ if is_integration(&name) => self.foreign.push(Foreign::None),
                _ => {}
            }
        }
        name
    }

    /// `endOpenTag`: the open callback, then the close of a void element.
    fn end_open(&mut self, name: &str, attributes: &[(String, String)]) {
        if name.is_empty() {
            return;
        }
        self.handler.open(name, attributes);

        if is_void(name) {
            self.handler.close(name);
        }
    }

    /// `onclosetag`.
    fn end_tag(&mut self, raw: &str) {
        let name = self.tag_name(raw);

        if !is_void(&name) {
            if let Some(at) = self.stack.iter().rposition(|open| *open == name) {
                while self.stack.len() > at {
                    self.pop();
                }
            } else if name == "p" {
                let name = self.emit_open(name);
                self.end_open(&name, &[]);

                if self.stack.last() == Some(&name) {
                    self.pop();
                }
            }
        } else if name == "br" {
            self.handler.open("br", &[]);
            self.handler.close("br");
        }
    }
}

/// Run `html` through the tokenizer and the tree rules.
fn parse(html: &str, handler: &mut dyn Handler) {
    let emitter = CallbackEmitter::new(|event: CallbackEvent<'_>, _: Span<()>| {
        let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();
        Some(match event {
            CallbackEvent::OpenStartTag { name } => Event::Open(text(name)),
            CallbackEvent::AttributeName { name } => Event::Attribute(text(name)),
            CallbackEvent::AttributeValue { value } => Event::Value(text(value)),
            CallbackEvent::CloseStartTag { self_closing } => Event::Close { self_closing },
            CallbackEvent::EndTag { name } => Event::End(text(name)),
            CallbackEvent::String { value } => Event::Text(text(value)),
            _ => return None,
        })
    });
    let mut tokenizer = Tokenizer::new_with_emitter(html, emitter);
    let mut tree = Tree {
        stack: Vec::new(),
        foreign: vec![Foreign::None],
        handler,
    };
    let mut pending: Option<Pending> = None;

    // Each event arrives before the tokenizer reads past it, so a text-only start tag switches
    // the state before its content is read.
    while let Some(Ok(event)) = tokenizer.next() {
        match event {
            Event::Open(raw) => {
                let foreign = tree.in_foreign();
                let name = tree.tag_name(&raw);
                let name = tree.emit_open(name);
                pending = Some(Pending {
                    name,
                    attributes: Vec::new(),
                    current: None,
                    foreign,
                    raw,
                });
            }
            // An end tag's attributes are read and dropped.
            Event::Attribute(name) => {
                if let Some(tag) = &mut pending {
                    // The first of duplicate attributes wins.
                    tag.current = match tag.attributes.iter().any(|(known, _)| *known == name) {
                        true => None,
                        false => {
                            tag.attributes.push((name, String::new()));
                            Some(tag.attributes.len() - 1)
                        }
                    };
                }
            }
            Event::Value(value) => {
                if let Some(Pending {
                    attributes,
                    current: Some(at),
                    ..
                }) = &mut pending
                {
                    attributes[*at].1 = value;
                }
            }
            Event::Close { self_closing } => {
                let Some(tag) = pending.take() else {
                    continue;
                };

                // Self-closing is honoured only in foreign content.
                if self_closing && tree.in_foreign() {
                    tree.end_open(&tag.name, &tag.attributes);

                    if !tag.name.is_empty() && tree.stack.last() == Some(&tag.name) {
                        tree.pop();
                    }
                } else {
                    tree.end_open(&tag.name, &tag.attributes);
                }

                if !tag.foreign
                    && let Some(state) = text_state(&tag.raw)
                {
                    tokenizer.set_state(state);
                }
            }
            Event::End(name) => {
                pending = None;
                tree.end_tag(&name);
            }
            Event::Text(text) => tree.handler.text(&text),
        }
    }

    // `onend`: every element still open is closed, innermost first.
    while let Some(element) = tree.stack.pop() {
        tree.handler.close(&element);
    }
}

/// `plainText`'s callbacks: text outside script and style, with a line break for each line-level
/// element.
#[derive(Default)]
struct Plain {
    text: String,
    hidden: i64,
}

impl Handler for Plain {
    fn open(&mut self, name: &str, _attributes: &[(String, String)]) {
        if name == "script" || name == "style" {
            self.hidden += 1;
        }

        if self.hidden == 0 && matches!(name, "br" | "p" | "div" | "li" | "tr") {
            self.text.push('\n');
        }
    }

    fn close(&mut self, name: &str) {
        if name == "script" || name == "style" {
            self.hidden -= 1;
        }

        if self.hidden == 0 && matches!(name, "p" | "div" | "li" | "tr") {
            self.text.push('\n');
        }
    }

    fn text(&mut self, text: &str) {
        if self.hidden == 0 {
            self.text.push_str(text);
        }
    }
}

/// `plainText(html)`: school HTML as text. Runs of spaces and tabs become one space, a line does
/// not start with them, at most one blank line separates paragraphs, and the ends are trimmed.
pub fn plain_text(html: &str) -> String {
    let mut plain = Plain::default();
    parse(html, &mut plain);
    let mut spaced = String::with_capacity(plain.text.len());

    // /[ \t]+/g -> ' ', then /\n[ \t]+/g -> '\n'.
    for c in plain.text.chars() {
        if c == ' ' || c == '\t' {
            if !spaced.ends_with(' ') {
                spaced.push(' ');
            }
            continue;
        }
        spaced.push(c);
    }
    let mut lines = String::with_capacity(spaced.len());
    let mut chars = spaced.chars().peekable();

    while let Some(c) = chars.next() {
        lines.push(c);

        if c == '\n' && chars.peek() == Some(&' ') {
            chars.next();
        }
    }
    // /\n{3,}/g -> '\n\n'.
    let mut text = String::with_capacity(lines.len());
    let mut breaks = 0;

    for c in lines.chars() {
        breaks = if c == '\n' { breaks + 1 } else { 0 };

        if breaks <= 2 {
            text.push(c);
        }
    }
    crate::js::trim(&text).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_matches_htmlparser2() {
        for (html, text) in [
            (
                "<p>Instructions</p><script>discard()</script>",
                "Instructions",
            ),
            ("<p>Hello &amp; welcome</p>", "Hello & welcome"),
            ("<p>Synthetic notice</p>", "Synthetic notice"),
            ("a<br>b<br/>c", "a\nb\nc"),
            ("<div>  x \t y </div><div>\n\n\n\nz</div>", "x y \n\nz"),
            ("<style>p{}</style><ul><li>one<li>two</ul>", "one\n\ntwo"),
            ("<table><tr><td>a</td></tr></table>", "a"),
            ("<p>open", "open"),
            ("</p>x", "x"),
            ("<script>never", ""),
            ("<!-- c -->t<![CDATA[x]]>", "t"),
            // The TypeScript case 'dates and plain text fail safely on malformed inputs'.
            (
                "<p>A &amp; B</p><style>hidden</style><script>hidden</script><p>C</p>",
                "A & B\n\nC",
            ),
        ] {
            assert_eq!(plain_text(html), text, "{html:?}");
        }
    }
}
