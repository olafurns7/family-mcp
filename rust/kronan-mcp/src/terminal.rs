//! The CLI's input, as packages/kronan-mcp/src/cli.ts reads it: the token from a file, standard
//! input, or a hidden terminal prompt, and one y/N answer line. Everything here blocks.

use std::io::{IsTerminal, Read, Write};
use std::path::Path;

use rustix::termios::{
    InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex, Termios, tcgetattr,
    tcsetattr,
};

use crate::auth::{self, TOKEN_MAX_BYTES};
use crate::error::{Fail, Result};
use crate::js;

/// Ctrl-C and Ctrl-D, which the raw terminal delivers as bytes.
const END_OF_TEXT: u16 = 3;

const END_OF_TRANSMISSION: u16 = 4;

const DELETE: u16 = 127;

const BACKSPACE: u16 = 8;

/// Restores the terminal mode on every path out of the prompt.
struct Raw {
    saved: Termios,
}

impl Raw {
    /// libuv's raw mode, as Node's `setRawMode(true)` sets it.
    fn enter() -> Option<Self> {
        let stdin = std::io::stdin();
        let saved = tcgetattr(&stdin).ok()?;
        let mut raw = saved.clone();
        raw.input_modes -= InputModes::BRKINT
            | InputModes::ICRNL
            | InputModes::INPCK
            | InputModes::ISTRIP
            | InputModes::IXON;
        raw.output_modes |= OutputModes::ONLCR;
        raw.local_modes -=
            LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG;
        raw.special_codes[SpecialCodeIndex::VMIN] = 1;
        raw.special_codes[SpecialCodeIndex::VTIME] = 0;
        tcsetattr(&stdin, OptionalActions::Now, &raw).ok()?;
        Some(Self { saved })
    }
}

impl Drop for Raw {
    fn drop(&mut self) {
        // The terminal may already be gone; the prompt's outcome stands either way.
        let _ = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.saved);
    }
}

/// Read one line from a terminal without echoing it, so the token stays out of scrollback. The
/// line is kept in UTF-16 units, so Backspace removes one unit as `String.prototype.slice` does.
fn read_hidden_line() -> Result<String> {
    let closed = Fail::Safe("Cancelled: the terminal input closed.");
    eprint!("Paste the Krónan access token (input hidden) and press Enter: ");
    // Like `setRawMode` throwing: nothing is read while the terminal would echo it.
    let raw = Raw::enter().ok_or(Fail::Unknown)?;
    let mut line: Vec<u16> = Vec::new();
    let mut chunk = [0u8; 4096];
    let mut stdin = std::io::stdin().lock();

    let outcome = loop {
        let read = match stdin.read(&mut chunk) {
            Ok(0) | Err(_) => break Err(closed),
            Ok(read) => read,
        };
        // Each chunk is decoded on its own, as Node decodes each `data` Buffer.
        let text = String::from_utf8_lossy(&chunk[..read]);
        let mut done = None;

        for unit in text.encode_utf16() {
            match unit {
                END_OF_TEXT | END_OF_TRANSMISSION => done = Some(Err(Fail::Safe("Cancelled."))),
                0x0d | 0x0a => done = Some(Ok(())),
                DELETE | BACKSPACE => {
                    line.pop();
                }
                unit => line.push(unit),
            }

            if done.is_some() {
                break;
            }
        }

        if let Some(done) = done {
            break done;
        }
    };
    drop(raw);
    eprintln!();
    outcome.map(|()| String::from_utf16_lossy(&line))
}

/// The terminal mode before the hidden prompt, for a signal that ends `auth set` while the prompt's
/// read blocks and its `Raw` guard can no longer run.
pub struct Saved(Termios);

impl Saved {
    /// Give the terminal back its mode and end as the TypeScript CLI's runtime does on SIGTERM or
    /// SIGINT, with the shell's status for that signal.
    pub fn restore_and_exit(&self, signal: i32) -> ! {
        let _ = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.0);
        std::process::exit(128 + signal)
    }
}

/// The current terminal mode when `source` means the hidden prompt.
pub fn prompt_mode(source: Option<&str>) -> Option<Saved> {
    let prompt = source.is_none_or(|source| source == "-") && std::io::stdin().is_terminal();
    prompt
        .then(|| tcgetattr(std::io::stdin()).ok().map(Saved))
        .flatten()
}

/// `-` and no argument both mean standard input; a terminal gets the hidden prompt either way.
pub fn read_token_input(source: Option<&str>) -> Result<String> {
    if let Some(source) = source.filter(|source| *source != "-") {
        return auth::read_token_source(Path::new(source));
    }

    if std::io::stdin().is_terminal() {
        return read_hidden_line();
    }
    // Every UTF-8 sequence, valid or not, decodes to at least one UTF-16 unit per three bytes, so
    // more bytes than this are always over the limit.
    let cap = 3 * TOKEN_MAX_BYTES + 4;
    let mut raw = Vec::new();
    std::io::stdin()
        .lock()
        .take(cap as u64)
        .read_to_end(&mut raw)
        .map_err(|_| Fail::Unknown)?;
    let text = String::from_utf8_lossy(&raw);

    if raw.len() == cap || text.encode_utf16().count() > TOKEN_MAX_BYTES {
        return Err(Fail::Safe(
            "Standard input is too large to hold one access token.",
        ));
    }
    Ok(text.into_owned())
}

/// One answer line from the terminal or standard input; end of input counts as no.
pub fn read_answer(prompt: &str) -> String {
    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    let mut line = Vec::new();

    for byte in std::io::stdin().lock().bytes() {
        match byte {
            Ok(b'\n' | b'\r') | Err(_) => break,
            Ok(byte) => line.push(byte),
        }
    }
    js::trim(&String::from_utf8_lossy(&line)).to_owned()
}
