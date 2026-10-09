//! Local record of every charge-bearing request, so one approval produces at most one attempt even
//! across restarts and several MCP hosts, with packages/kronan-mcp/src/attempts.ts's file, rules
//! and messages: either implementation reads and honours the other's record. Only the CLI clears
//! it; no MCP tool can. Everything here blocks.
// The order tools that claim attempts are not served yet; until then only tests claim.
#![cfg_attr(not(test), allow(dead_code))]

use std::cell::Cell;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use family_store::{
    Cancel, Code, DEFAULT_SWEEP_AGE, DEFAULT_WAIT, Error as StoreError, LockOptions,
    read_private_file, sweep_temp, with_file_lock, write_private_file,
};
use serde_json::{Value, json};

use crate::auth;
use crate::error::{Fail, Result};
use crate::js;
use crate::shapes::{self, S};

const MAX_BYTES: usize = 1_048_576;

/// Accepted records only guard their own checkout; unresolved records are never pruned.
const ACCEPTED_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

pub const MONEY_TOOLS: [&str; 4] = [
    "reserve_delivery_slot",
    "reserve_pickup_slot",
    "complete_checkout",
    "add_checkout_to_order",
];

/// An accepted call from these tools consumed the checkout contents for every money tool.
const CONSUMING_TOOLS: [&str; 2] = ["complete_checkout", "add_checkout_to_order"];

const STR: S = S::Str;

/// zod's `z.object`: unknown keys are dropped and the rest kept in this order.
const ATTEMPT: S = S::Obj(&[&[
    ("id", STR),
    ("tool", S::Enum(&MONEY_TOOLS)),
    ("checkoutToken", STR),
    ("fingerprint", STR),
    ("total", S::Int),
    ("state", S::Enum(&["submitting", "accepted", "unknown"])),
    ("orderToken", S::Null(&STR)),
    ("createdAt", STR),
    ("updatedAt", STR),
]]);

const ATTEMPTS: S = S::List(&ATTEMPT);

pub const ATTEMPT_UNRESOLVED: Fail = Fail::Safe(
    "An earlier order call for this checkout is still unresolved (submitting or unknown). Nothing was sent to Krónan. Reconcile it with get_active_order and list_orders and ask the user what happened; this is not permission to retry.",
);

pub const ATTEMPT_ACCEPTED: Fail = Fail::Safe(
    "Krónan already accepted this order call for this exact checkout (same lines and total). Nothing was sent to Krónan. Check get_active_order; a new order needs a changed checkout and a new approval.",
);

pub const ATTEMPTS_BUSY: Fail = Fail::Safe(
    "Another Krónan order call is in progress, or the local order-attempt record cannot be locked. Nothing was sent to Krónan. Check get_active_order before anything else.",
);

pub const ATTEMPT_RACED: Fail = Fail::Safe(
    "Another Krónan order call ran at the same time and changed the local order-attempt record. Nothing was sent to Krónan. Read get_active_order before anything else.",
);

pub const ATTEMPTS_INVALID: Fail = Fail::Safe(
    "The local order-attempt record is unreadable or unsafe. Nothing was sent to Krónan. Check get_active_order and list_orders; the user can inspect the record with kronan-mcp orders clear-attempts.",
);

/// The record beside the legacy token file, whether or not the token was migrated.
pub fn attempts_path() -> Result<PathBuf> {
    Ok(auth::journal_of(&auth::token_path()?))
}

/// The checkout contents an approval covers: line SKUs and quantities, sorted, and the total, of
/// a checkout parsed by its schema (so numbers print as JavaScript prints them).
pub fn fingerprint(checkout: &Value) -> String {
    let mut lines: Vec<String> = checkout["lines"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .map(|line| {
            let sku = line["product"]["sku"].as_str().unwrap_or_default();
            format!("{sku}\u{0}{}", line["quantity"])
        })
        .collect();
    // `Array.prototype.toSorted` compares UTF-16 code units.
    lines.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    let text = json!({ "lines": lines, "total": checkout["total"] }).to_string();
    let digest = aws_lc_rs::digest::digest(&aws_lc_rs::digest::SHA256, text.as_bytes());
    digest
        .as_ref()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// A failure inside the attempts lock: a reviewed refusal, or a store failure TypeScript reports
/// as busy.
pub enum Held {
    Fail(Fail),
    Store(StoreError),
}

impl From<StoreError> for Held {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<Fail> for Held {
    fn from(fail: Fail) -> Self {
        Self::Fail(fail)
    }
}

/// The attempts file's `{version: 1, attempts}`, parsed like `attemptsFileSchema`.
fn parse_file(raw: &str) -> Option<Vec<Value>> {
    let file = js::parse(raw.as_bytes())?;
    (file.get("version")?.as_f64()? == 1.0).then_some(())?;
    match shapes::parse(&ATTEMPTS, file.get("attempts")?)? {
        Value::Array(attempts) => Some(attempts),
        _ => None,
    }
}

/// Returns the recorded attempts; a missing file has none, any other problem is an error.
pub fn read_attempts(path: &Path) -> Result<Vec<Value>> {
    match read_private_file(path, MAX_BYTES) {
        Err(error) if error.code == Code::NotFound => Ok(Vec::new()),
        Err(_) => Err(ATTEMPTS_INVALID),
        Ok(raw) => parse_file(&raw).ok_or(ATTEMPTS_INVALID),
    }
}

fn write_attempts(path: &Path, attempts: Vec<Value>) -> std::result::Result<(), StoreError> {
    let cutoff = js::now() - ACCEPTED_RETENTION_MS;
    let kept: Vec<Value> = attempts
        .into_iter()
        .filter(|attempt| {
            attempt["state"] != "accepted"
                || attempt["updatedAt"]
                    .as_str()
                    .and_then(js::date_parse)
                    .is_some_and(|updated| updated >= cutoff)
        })
        .collect();
    let text = json!({ "version": 1, "attempts": kept }).to_string() + "\n";
    write_private_file(path, text.as_bytes(), &Cancel::default())
}

/// Why a new attempt must not be sent, or `None` when it may.
fn blocker(
    attempts: &[Value],
    tool: &str,
    checkout_token: &str,
    print: Option<&str>,
) -> Option<Fail> {
    let same_checkout: Vec<&Value> = attempts
        .iter()
        .filter(|attempt| attempt["checkoutToken"] == checkout_token)
        .collect();

    if same_checkout
        .iter()
        .any(|attempt| attempt["state"] != "accepted")
    {
        return Some(ATTEMPT_UNRESOLVED);
    }
    let print = print?;

    // An accepted reserve still allows complete_checkout: the live reserve/complete sequence is unverified.
    let consumed = same_checkout.iter().any(|attempt| {
        attempt["fingerprint"] == print
            && (attempt["tool"] == tool
                || CONSUMING_TOOLS
                    .iter()
                    .any(|consuming| attempt["tool"] == *consuming))
    });
    consumed.then_some(ATTEMPT_ACCEPTED)
}

/// Runs work while holding the attempts lock; injectable so tests can simulate a takeover.
pub trait Lock {
    fn hold<T>(
        &self,
        path: &Path,
        cancel: &Cancel,
        work: impl FnOnce() -> std::result::Result<T, Held>,
    ) -> std::result::Result<T, Held>;
}

pub struct FileLock;

impl Lock for FileLock {
    fn hold<T>(
        &self,
        path: &Path,
        cancel: &Cancel,
        work: impl FnOnce() -> std::result::Result<T, Held>,
    ) -> std::result::Result<T, Held> {
        let options = LockOptions {
            cancel: cancel.clone(),
            wait: DEFAULT_WAIT,
        };
        with_file_lock(path, &options, work)
    }
}

/// Full-content identity, so any change by another holder is detected.
fn identity(attempts: &[Value]) -> String {
    Value::Array(attempts.to_vec()).to_string()
}

/// The live checkout a gate verified.
pub struct Checkout {
    pub token: String,
    pub total: i64,
    pub print: String,
}

pub struct Claim<'a, T> {
    pub tool: &'static str,
    pub expected_checkout_token: &'a str,
    pub cancel: &'a Cancel,
    /// Reads and verifies the live checkout; fails with a fixed refusal before anything is recorded.
    pub gate: Box<dyn FnOnce() -> Result<Checkout> + 'a>,
    /// Sends the one charge-bearing request; any failure is an unknown outcome.
    pub send: Box<dyn FnOnce() -> Result<T> + 'a>,
    pub order_token: fn(&T) -> String,
}

/// Holds the attempts lock across the record check, gate, `submitting` write, request, and final
/// state, so concurrent or repeated calls for one approval send at most one request. Returns
/// `None` when the outcome is unknown, including every local failure after the request may have
/// left.
///
/// The lock does not fence a holder that lost it, so the record is also compared and swapped: the
/// snapshot must be unchanged after the gate, the `submitting` entry must be present after its
/// write, and the final write updates only this attempt's entry in freshly read content.
pub fn claim_attempt<T>(path: &Path, claim: Claim<'_, T>, lock: &impl Lock) -> Result<Option<T>> {
    // Set inside the locked work immediately before sending; once true, the request may have left.
    let sending = Cell::new(false);
    let Claim {
        tool,
        expected_checkout_token,
        cancel,
        gate,
        send,
        order_token,
    } = claim;

    let held = lock.hold(path, cancel, || {
        sweep_temp(path, DEFAULT_SWEEP_AGE)?;
        let snapshot = read_attempts(path)?;

        if let Some(early) = blocker(&snapshot, tool, expected_checkout_token, None) {
            return Err(early.into());
        }
        let checkout = gate()?;

        // Another holder may have written while the gate waited on Krónan; nothing is sent then.
        let fresh = read_attempts(path)?;

        if identity(&fresh) != identity(&snapshot) {
            return Err(ATTEMPT_RACED.into());
        }

        if let Some(late) = blocker(&fresh, tool, &checkout.token, Some(&checkout.print)) {
            return Err(late.into());
        }
        let now = js::iso_string(js::now());
        let id = uuid().ok_or(Held::Fail(Fail::Unknown))?;
        let attempt = json!({
            "id": id,
            "tool": tool,
            "checkoutToken": checkout.token,
            "fingerprint": checkout.print,
            "total": checkout.total,
            "state": "submitting",
            "orderToken": null,
            "createdAt": now,
            "updatedAt": now,
        });

        // Commit intent before the network call; a crash or timeout must never allow a second charge.
        let mut next = fresh;
        next.push(attempt.clone());
        write_attempts(path, next)?;
        let committed = read_attempts(path)?
            .iter()
            .any(|entry| entry["id"] == id && entry["state"] == "submitting");

        if !committed {
            return Err(ATTEMPT_RACED.into());
        }
        sending.set(true);
        let value = send().ok();
        let mut last = attempt;
        last["state"] = json!(if value.is_some() {
            "accepted"
        } else {
            "unknown"
        });
        last["orderToken"] = json!(value.as_ref().map(order_token));
        last["updatedAt"] = json!(js::iso_string(js::now()));

        // Every other entry is kept as it is now, including entries another holder added meanwhile.
        let mut current = read_attempts(path)?;

        match current.iter_mut().find(|entry| entry["id"] == id) {
            Some(entry) => *entry = last,
            None => current.push(last),
        }
        write_attempts(path, current)?;
        Ok(value)
    });

    match held {
        Ok(value) => Ok(value),
        Err(_) if sending.get() => Ok(None),
        Err(Held::Fail(fail @ Fail::Safe(_))) => Err(fail),
        Err(_) => Err(ATTEMPTS_BUSY),
    }
}

/// A random version 4 UUID, as `crypto.randomUUID`.
fn uuid() -> Option<String> {
    let mut bytes = [0u8; 16];
    getrandom::fill(&mut bytes).ok()?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    Some(format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    ))
}

/// For the CLI: the current records, or `None` when the file cannot be parsed or trusted.
pub fn list_attempts(path: &Path) -> Option<Vec<Value>> {
    read_attempts(path).ok()
}

/// For the CLI, after the human confirmed: removes the record only if its full content still
/// equals what was shown. Returns false when it changed meanwhile. Lock failures keep the store's
/// own fixed messages, as the TypeScript CLI prints them.
pub fn clear_attempts(path: &Path, shown: Option<&[Value]>) -> Result<bool> {
    let locked = with_file_lock(path, &LockOptions::default(), || {
        let current = list_attempts(path);

        if current.as_deref().map(identity) != shown.map(identity) {
            return Ok(false);
        }

        match fs::remove_file(path) {
            Err(error) if error.kind() != ErrorKind::NotFound => {
                return Err(Held::Fail(Fail::Unknown));
            }
            _ => {}
        }
        sweep_temp(path, DEFAULT_SWEEP_AGE)?;
        Ok(true)
    });

    match locked {
        Ok(cleared) => Ok(cleared),
        Err(Held::Fail(fail)) => Err(fail),
        Err(Held::Store(error)) => Err(Fail::Safe(error.message)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    const CHECKOUT_TOKEN: &str = "123e4567-e89b-12d3-a456-426614174006";

    const LIST_TOKEN: &str = "123e4567-e89b-12d3-a456-426614174002";

    const RACED: &str = "Another Krónan order call ran at the same time";

    /// Grants the lock at once: a second holder that acquired the lock after the first holder's
    /// lock directory was removed while that holder was still running.
    struct TakenOver;

    impl Lock for TakenOver {
        fn hold<T>(
            &self,
            _: &Path,
            _: &Cancel,
            work: impl FnOnce() -> std::result::Result<T, Held>,
        ) -> std::result::Result<T, Held> {
            work()
        }
    }

    /// family-store reports LOCK_LOST only after the work finished, as this lock does.
    struct LostAfterWork;

    impl Lock for LostAfterWork {
        fn hold<T>(
            &self,
            _: &Path,
            _: &Cancel,
            work: impl FnOnce() -> std::result::Result<T, Held>,
        ) -> std::result::Result<T, Held> {
            work()?;
            Err(StoreError::new(
                Code::LockLost,
                "Another process took over the session lock.",
            )
            .into())
        }
    }

    const FINGERPRINT: &str = "d8d7a09f6cd23efbb004614267c9c9f9142c44df6271f40fa5ad8cdea9e54e07";

    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            let directory =
                std::env::temp_dir().join(format!("kronan-attempts-{name}-{}", uuid().unwrap()));
            fs::create_dir_all(&directory).unwrap();
            Self(directory)
        }

        fn file(&self) -> PathBuf {
            self.0.join("session.json.order-attempts.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn approved(token: &str, total: i64, print: &str) -> Result<Checkout> {
        Ok(Checkout {
            token: token.to_owned(),
            total,
            print: print.to_owned(),
        })
    }

    /// A direct claim for the fixture checkout; each test overrides gate, send, and lock.
    fn claim<'a>(
        cancel: &'a Cancel,
        gate: impl FnOnce() -> Result<Checkout> + 'a,
        send: impl FnOnce() -> Result<String> + 'a,
    ) -> Claim<'a, String> {
        Claim {
            tool: "complete_checkout",
            expected_checkout_token: CHECKOUT_TOKEN,
            cancel,
            gate: Box::new(gate),
            send: Box::new(send),
            order_token: String::clone,
        }
    }

    fn message(outcome: Result<Option<String>>) -> &'static str {
        match outcome {
            Err(Fail::Safe(text)) => text,
            _ => panic!("expected a refusal"),
        }
    }

    fn states(path: &Path) -> Vec<String> {
        let mut states: Vec<String> = read_attempts(path)
            .unwrap()
            .iter()
            .map(|record| {
                format!(
                    "{} {} {}",
                    record["checkoutToken"], record["state"], record["orderToken"]
                )
            })
            .collect();
        states.sort();
        states
    }

    #[test]
    fn a_holder_whose_lock_is_taken_over_during_its_gate_sends_nothing() {
        let scratch = Scratch::new("takeover");
        let path = scratch.file();
        let (entered, gate_entered) = mpsc::channel();
        let (open, gate_open) = mpsc::channel::<()>();
        let sends = std::sync::Mutex::new(Vec::new());

        std::thread::scope(|scope| {
            // A holds the real file lock and waits in its checkout read.
            let a = scope.spawn(|| {
                let cancel = Cancel::default();
                claim_attempt(
                    &path,
                    claim(
                        &cancel,
                        move || {
                            entered.send(()).unwrap();
                            gate_open.recv().unwrap();
                            approved(CHECKOUT_TOKEN, 1489, "approved-lines")
                        },
                        || {
                            sends.lock().unwrap().push("A");
                            Ok("order-a".to_owned())
                        },
                    ),
                    &FileLock,
                )
            });
            gate_entered.recv().unwrap();

            // B took over the lock and completes the same approval while A is still in its gate.
            let cancel = Cancel::default();
            let b = claim_attempt(
                &path,
                claim(
                    &cancel,
                    || approved(CHECKOUT_TOKEN, 1489, "approved-lines"),
                    || {
                        sends.lock().unwrap().push("B");
                        Ok("order-b".to_owned())
                    },
                ),
                &TakenOver,
            );
            assert_eq!(b.ok().flatten().as_deref(), Some("order-b"));
            open.send(()).unwrap();
            assert!(message(a.join().unwrap()).starts_with(RACED));
        });

        assert_eq!(*sends.lock().unwrap(), ["B"]);
        let records = read_attempts(&path).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0]["tool"], "complete_checkout");
        assert_eq!(records[0]["state"], "accepted");
        assert_eq!(records[0]["orderToken"], "order-b");
    }

    #[test]
    fn a_record_written_by_another_holder_during_the_gate_stops_the_send() {
        let scratch = Scratch::new("gate-write");
        let path = scratch.file();
        let other = json!({
            "id": "other-holder",
            "tool": "reserve_pickup_slot",
            "checkoutToken": LIST_TOKEN,
            "fingerprint": "other-lines",
            "total": 1,
            "state": "unknown",
            "orderToken": null,
            "createdAt": "2026-09-25T00:00:00.000Z",
            "updatedAt": "2026-09-25T00:00:00.000Z",
        });
        let cancel = Cancel::default();
        let outcome = claim_attempt(
            &path,
            claim(
                &cancel,
                || {
                    let text = json!({ "version": 1, "attempts": [other] }).to_string();
                    write_private_file(&path, text.as_bytes(), &Cancel::default()).unwrap();
                    approved(CHECKOUT_TOKEN, 1489, "approved-lines")
                },
                || panic!("nothing may be sent"),
            ),
            &FileLock,
        );

        assert!(message(outcome).starts_with(RACED));
        assert_eq!(read_attempts(&path).unwrap(), [other]);
    }

    #[test]
    fn lock_loss_after_the_send_is_an_unknown_outcome_and_the_record_still_blocks() {
        let scratch = Scratch::new("lost");
        let path = scratch.file();
        let cancel = Cancel::default();
        let outcome = claim_attempt(
            &path,
            claim(
                &cancel,
                || approved(CHECKOUT_TOKEN, 1489, "approved-lines"),
                || Ok("order-a".to_owned()),
            ),
            &LostAfterWork,
        );

        assert_eq!(outcome.ok(), Some(None));
        assert_eq!(
            states(&path),
            [format!("\"{CHECKOUT_TOKEN}\" \"accepted\" \"order-a\"")]
        );
        let repeat = claim_attempt(
            &path,
            claim(
                &cancel,
                || approved(CHECKOUT_TOKEN, 1489, "approved-lines"),
                || panic!("nothing may be sent"),
            ),
            &FileLock,
        );
        assert!(message(repeat).contains("already accepted"));
    }

    #[test]
    fn records_written_while_a_send_is_pending_survive_the_final_write() {
        let scratch = Scratch::new("pending");
        let path = scratch.file();
        let (entered, post_entered) = mpsc::channel();
        let (open, post_open) = mpsc::channel::<()>();

        std::thread::scope(|scope| {
            let a = scope.spawn(|| {
                let cancel = Cancel::default();
                claim_attempt(
                    &path,
                    claim(
                        &cancel,
                        || approved(CHECKOUT_TOKEN, 1489, "approved-lines"),
                        move || {
                            entered.send(()).unwrap();
                            post_open.recv().unwrap();
                            Ok("order-a".to_owned())
                        },
                    ),
                    &FileLock,
                )
            });
            post_entered.recv().unwrap();

            // B took over the lock and records an unknown attempt for a different checkout.
            let cancel = Cancel::default();
            let mut other = claim(
                &cancel,
                || approved(LIST_TOKEN, 1, "other-lines"),
                || Err(Fail::Unknown),
            );
            other.tool = "reserve_pickup_slot";
            other.expected_checkout_token = LIST_TOKEN;
            assert_eq!(claim_attempt(&path, other, &TakenOver).ok(), Some(None));
            open.send(()).unwrap();
            assert_eq!(a.join().unwrap().ok().flatten().as_deref(), Some("order-a"));
        });

        assert_eq!(
            states(&path),
            [
                format!("\"{LIST_TOKEN}\" \"unknown\" null"),
                format!("\"{CHECKOUT_TOKEN}\" \"accepted\" \"order-a\""),
            ]
        );

        // A stale writer that dropped this attempt's entry: the final write re-adds it, keeping
        // the others.
        let third = LIST_TOKEN.replace('2', "9");
        let cancel = Cancel::default();
        let mut stale = claim(
            &cancel,
            || approved(&third, 2, "third"),
            || {
                let other = read_attempts(&path).unwrap()[1].clone();
                let text = json!({ "version": 1, "attempts": [other] }).to_string();
                write_private_file(&path, text.as_bytes(), &Cancel::default()).unwrap();
                Ok("order-c".to_owned())
            },
        );
        stale.expected_checkout_token = &third;
        assert_eq!(
            claim_attempt(&path, stale, &FileLock)
                .ok()
                .flatten()
                .as_deref(),
            Some("order-c")
        );
        let mut orders: Vec<String> = read_attempts(&path)
            .unwrap()
            .iter()
            .map(|record| format!("{} {}", record["orderToken"], record["state"]))
            .collect();
        orders.sort();
        assert_eq!(orders, ["\"order-c\" \"accepted\"", "null \"unknown\""]);
    }

    #[test]
    fn records_parse_prune_and_fingerprint_like_the_typescript_module() {
        let scratch = Scratch::new("format");
        let path = scratch.file();
        let old = js::iso_string(js::now() - ACCEPTED_RETENTION_MS - 1000);
        let record = |state: &str, updated: &str| {
            json!({
                "extra": 1, "id": "x", "tool": "complete_checkout", "checkoutToken": "c",
                "fingerprint": "f", "total": 1.0, "state": state, "orderToken": null,
                "createdAt": updated, "updatedAt": updated,
            })
        };
        let text = json!({ "version": 1.0, "attempts": [record("accepted", &old), record("unknown", &old), record("accepted", "garbage")] });
        write_private_file(&path, text.to_string().as_bytes(), &Cancel::default()).unwrap();
        let read = read_attempts(&path).unwrap();
        // Unknown keys are dropped, keys keep the schema order, and numbers print as JavaScript's.
        assert_eq!(
            read[0].to_string(),
            format!(
                r#"{{"id":"x","tool":"complete_checkout","checkoutToken":"c","fingerprint":"f","total":1,"state":"accepted","orderToken":null,"createdAt":"{old}","updatedAt":"{old}"}}"#
            )
        );
        // Accepted records older than 30 days, or with an unreadable date, are pruned on write.
        write_attempts(&path, read).unwrap();
        assert_eq!(states(&path), [r#""c" "unknown" null"#]);

        for invalid in [
            r#"{"version":2,"attempts":[]}"#,
            r#"{"version":1,"attempts":[{"state":"accepted"}]}"#,
            r#"{"version":1}"#,
            "[]",
        ] {
            write_private_file(&path, invalid.as_bytes(), &Cancel::default()).unwrap();
            assert!(
                matches!(read_attempts(&path), Err(ATTEMPTS_INVALID)),
                "{invalid}"
            );
        }

        // node -e "crypto.createHash('sha256').update(JSON.stringify({lines:['SKU-1\u00002','SKU-10\u00001','sku\u00001'],total:1489})).digest('hex')"
        let checkout = json!({
            "total": 1489,
            "lines": [
                { "quantity": 1, "product": { "sku": "sku" } },
                { "quantity": 2, "product": { "sku": "SKU-1" } },
                { "quantity": 1, "product": { "sku": "SKU-10" } },
            ],
        });
        assert_eq!(fingerprint(&checkout), FINGERPRINT);
        assert_eq!(uuid().unwrap().len(), 36);
    }
}
