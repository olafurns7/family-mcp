//! The JavaScript semantics the TypeScript server inherits from its runtime and zod.

fn is_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `String.prototype.trim`, whose white space differs from Rust's (U+0085, U+FEFF).
pub fn trim(text: &str) -> &str {
    text.trim_matches(is_space)
}

/// `Number(text)`: decimal, or `0x`, `0o` and `0b` integers; anything else is NaN.
pub fn number(text: &str) -> f64 {
    let text = trim(text);
    let radix = |prefix: [&str; 2], radix| {
        prefix
            .iter()
            .find_map(|prefix| text.strip_prefix(prefix))
            .map(|digits| match digits {
                "" => f64::NAN,
                _ => u128::from_str_radix(digits, radix).map_or(f64::NAN, |n| n as f64),
            })
    };
    radix(["0x", "0X"], 16)
        .or_else(|| radix(["0o", "0O"], 8))
        .or_else(|| radix(["0b", "0B"], 2))
        .unwrap_or_else(|| match text {
            "" => 0.0,
            "Infinity" | "+Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            // Rust also reads "inf" and "nan"; JavaScript reads neither.
            _ if text
                .bytes()
                .all(|b| b.is_ascii_digit() || b"+-.eE".contains(&b)) =>
            {
                text.parse().unwrap_or(f64::NAN)
            }
            _ => f64::NAN,
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn javascript_semantics() {
        assert_eq!(trim("\u{feff} a\u{85}"), "a\u{85}");

        for (text, value) in [
            ("  5 ", 5.0),
            ("0x10", 16.0),
            ("0b11", 3.0),
            ("1e3", 1000.0),
            ("+7", 7.0),
            ("5.", 5.0),
            (".5", 0.5),
            ("", 0.0),
            (" \n", 0.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(number(text), value, "{text}");
        }

        for text in ["inf", "nan", "0x", "1_0", "--1", "1e", "0x-1", "Infinityx"] {
            assert!(number(text).is_nan(), "{text}");
        }
    }
}
