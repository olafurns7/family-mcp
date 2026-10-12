//! A broken connection while the host still holds stdin open, as the TypeScript SDK's stdio
//! transport closes it: a failed write to stdout (its `error` event) or an input line over its
//! 10 MiB read buffer. Either stops serving at once, which cancels the calls in flight, then runs
//! the server's `close`, and the process exits 0 without a word on stderr, as the TypeScript
//! server does.

mod support;

use std::io::Write;
use std::time::{Duration, Instant};

use support::{exits_within, send};

/// The SDK's `STDIO_DEFAULT_MAX_BUFFER_SIZE`.
const LIMIT: usize = 10 * 1024 * 1024;

const PING: &str = r#"{"jsonrpc":"2.0","id":3,"method":"ping"}"#;

/// At once: rmcp's drain at stdin's end waits up to 5 s.
const AT_ONCE: Duration = Duration::from_secs(2);

#[test]
fn a_failed_stdout_write_cancels_the_call_in_flight_and_ends_the_process() {
    let mut example = support::hanging();
    // The host closes its read side; the ping's answer is the next write.
    drop(example.stdout);
    let broken = Instant::now();
    send(&mut example.stdin, PING);
    assert_eq!(example.stderr.next(), "CANCELLED\n");
    assert!(broken.elapsed() < AT_ONCE, "{:?}", broken.elapsed());
    assert_eq!(example.stderr.next(), "CLOSE\n");
    assert_eq!(
        exits_within(&mut example.child, Duration::from_secs(5)),
        Some(0)
    );
    assert_eq!(example.stderr.rest(), "");
    // Held open until the process has exited.
    drop(example.stdin);
}

#[test]
fn an_input_line_over_10_mib_cancels_the_call_in_flight_and_ends_the_process() {
    let mut example = support::hanging();
    support::drain(example.stdout);
    example.stdin.write_all(&vec![b' '; LIMIT + 1]).unwrap();
    example.stdin.flush().unwrap();
    let sent = Instant::now();
    assert_eq!(example.stderr.next(), "CANCELLED\n");
    assert!(sent.elapsed() < AT_ONCE, "{:?}", sent.elapsed());
    assert_eq!(example.stderr.next(), "CLOSE\n");
    assert_eq!(
        exits_within(&mut example.child, Duration::from_secs(5)),
        Some(0)
    );
    assert_eq!(example.stderr.rest(), "");
    drop(example.stdin);
}

/// The SDK counts every buffered byte, the newline too: a line of exactly 10 MiB with its newline
/// is read, and one byte more always closes, however the input is split into reads.
#[test]
fn a_line_of_10_mib_with_its_newline_is_read_and_one_byte_more_ends_the_process() {
    let mut example = support::initialized();
    let mut line = vec![b' '; LIMIT - 1];
    line.push(b'\n');
    example.stdin.write_all(&line).unwrap();
    send(&mut example.stdin, PING);
    let reply = example.reply();
    assert!(reply.contains(r#""id":3"#), "{reply}");

    line.insert(0, b' ');
    example.stdin.write_all(&line).unwrap();
    example.stdin.flush().unwrap();
    assert_eq!(example.stderr.next(), "CLOSE\n");
    assert_eq!(
        exits_within(&mut example.child, Duration::from_secs(5)),
        Some(0)
    );
    assert_eq!(example.stderr.rest(), "");
    assert_eq!(example.reply(), "");
    drop(example.stdin);
}
