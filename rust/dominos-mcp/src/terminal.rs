//! One readline interface for both hidden inputs; raw mode stays in effect until sign-in ends.
use crate::error::{Fail, Result};
use rustix::termios::{
    InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex, Termios, tcgetattr,
    tcsetattr,
};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, IsTerminal, Read};

struct Raw(Termios);
impl Raw {
    fn enter() -> Result<Self> {
        let saved = tcgetattr(std::io::stdin()).map_err(|_| Fail::Unknown)?;
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
        tcsetattr(std::io::stdin(), OptionalActions::Now, &raw).map_err(|_| Fail::Unknown)?;
        Ok(Self(saved))
    }
}
impl Drop for Raw {
    fn drop(&mut self) {
        let _ = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.0);
    }
}
pub struct Saved(Termios);
impl Saved {
    pub fn current() -> Option<Self> {
        std::io::stdin()
            .is_terminal()
            .then(|| tcgetattr(std::io::stdin()).ok().map(Self))
            .flatten()
    }
    pub fn restore_and_exit(&self, signal: i32) -> ! {
        let _ = tcsetattr(std::io::stdin(), OptionalActions::Now, &self.0);
        std::process::exit(128 + signal);
    }
}
pub struct Input {
    raw: Option<Raw>,
    stdin: BufReader<std::io::Stdin>,
    pending: VecDeque<char>,
    utf8: Vec<u8>,
    closed: bool,
    escape: String,
    history: String,
}
impl Input {
    pub fn new() -> Result<Self> {
        let raw = if std::io::stdin().is_terminal() {
            Some(Raw::enter()?)
        } else {
            None
        };
        Ok(Self {
            raw,
            stdin: BufReader::new(std::io::stdin()),
            pending: VecDeque::new(),
            utf8: Vec::new(),
            closed: false,
            escape: String::new(),
            history: String::new(),
        })
    }
    pub fn line(&mut self) -> Result<String> {
        let cancelled = Fail::Safe("Sign-in cancelled.");
        if self.closed {
            return Err(cancelled);
        }
        if self.raw.is_none() {
            let mut bytes = Vec::new();
            // An I/O error is the CLI's generic failure, not EOF.
            if self
                .stdin
                .read_until(b'\n', &mut bytes)
                .map_err(|_| Fail::Unknown)?
                == 0
            {
                self.closed = true;
                return Err(cancelled);
            }
            if bytes.last() == Some(&b'\n') {
                bytes.pop();
            }
            if bytes.last() == Some(&b'\r') {
                bytes.pop();
            }
            return Ok(String::from_utf8_lossy(&bytes).into_owned());
        }
        let mut line = String::new();
        let mut right = Vec::new();
        loop {
            if self.pending.is_empty() {
                let mut chunk = [0u8; 4096];
                match self.stdin.read(&mut chunk) {
                    Ok(0) => {
                        self.closed = true;
                        return Err(cancelled);
                    }
                    Err(_) => return Err(Fail::Unknown),
                    Ok(read) => {
                        self.utf8.extend_from_slice(&chunk[..read]);
                        loop {
                            match std::str::from_utf8(&self.utf8) {
                                Ok(text) => {
                                    self.pending.extend(text.chars());
                                    self.utf8.clear();
                                    break;
                                }
                                Err(error) => {
                                    let valid = error.valid_up_to();
                                    self.pending.extend(
                                        String::from_utf8_lossy(&self.utf8[..valid]).chars(),
                                    );
                                    if let Some(skip) = error.error_len() {
                                        self.pending.push_back('\u{fffd}');
                                        self.utf8.drain(..valid + skip);
                                    } else {
                                        self.utf8.drain(..valid);
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            let Some(c) = self.pending.pop_front() else {
                continue;
            };
            if !self.escape.is_empty() {
                self.escape.push(c);
                if c.is_ascii_alphabetic() || c == '~' {
                    match self.escape.as_str() {
                        "\u{1b}[A" => {
                            line = self.history.clone();
                            right.clear();
                        }
                        "\u{1b}[B" => {
                            line.clear();
                            right.clear();
                        }
                        "\u{1b}[D" => {
                            if let Some(c) = line.pop() {
                                right.push(c);
                            }
                        }
                        "\u{1b}[C" => {
                            if let Some(c) = right.pop() {
                                line.push(c);
                            }
                        }
                        "\u{1b}[H" | "\u{1b}[1~" => {
                            right.extend(line.chars().rev());
                            line.clear();
                        }
                        "\u{1b}[F" | "\u{1b}[4~" => {
                            line.extend(right.drain(..).rev());
                        }
                        "\u{1b}[3~" => {
                            right.pop();
                        }
                        _ => {}
                    }
                    self.escape.clear();
                }
                continue;
            }
            match c {
                '\u{1b}' => self.escape.push(c),
                '\u{3}' => {
                    self.closed = true;
                    return Err(cancelled);
                }
                '\u{4}' if line.is_empty() && right.is_empty() => {
                    self.closed = true;
                    return Err(cancelled);
                }
                '\r' | '\n' => {
                    if c == '\r' && self.pending.front() == Some(&'\n') {
                        self.pending.pop_front();
                    }
                    line.extend(right.drain(..).rev());
                    self.history = line.clone();
                    return Ok(line);
                }
                '\u{8}' | '\u{7f}' => {
                    line.pop();
                }
                '\u{15}' => line.clear(),
                '\u{1}' => {
                    right.extend(line.chars().rev());
                    line.clear();
                }
                '\u{5}' => line.extend(right.drain(..).rev()),
                '\u{b}' => right.clear(),
                '\u{4}' => {
                    right.pop();
                }
                '\u{10}' => {
                    line = self.history.clone();
                    right.clear();
                }
                '\u{e}' => {
                    line.clear();
                    right.clear();
                }
                c if !c.is_control() => line.push(c),
                _ => {}
            }
        }
    }
}
