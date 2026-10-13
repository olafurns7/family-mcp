//! Explicit local-session sign-in; reads never call this path.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use tokio::sync::{Mutex, oneshot};
use tokio::task::JoinHandle;

use crate::client::{Client, PAUSED};
use crate::error::{Fail, Result};
use crate::js;
use crate::login::login_with_electronic_id;
use crate::session::locked;
use crate::signal::Signal;

const DAY: f64 = 86_400_000.0;
const COOLDOWN: f64 = 60_000.0;
const LEASE: f64 = 240_000.0;
const LIMIT: usize = 10;

fn timeout() -> Duration {
    #[cfg(feature = "test-origin")]
    if let Ok(ms) = std::env::var("INNA_TEST_SIGN_IN_MS") {
        return Duration::from_millis(ms.parse().expect("test sign-in timeout"));
    }
    Duration::from_secs(180)
}
const NO_PHONE: &str =
    "Run inna-mcp auth login once in a terminal to store the electronic-ID phone number.";

#[derive(Clone, Default)]
pub struct Guard {
    pub phone: Option<String>,
    starts: Vec<f64>,
    pending_until: f64,
    cooldown_until: f64,
}

impl Guard {
    pub fn parse(value: &Value) -> Option<Self> {
        let phone = match value.get("phone") {
            None => None,
            Some(value) => Some(value.as_str()?.to_owned()),
        };
        if phone.as_ref().is_some_and(|phone| {
            phone.len() != 7 || !phone.bytes().all(|byte| byte.is_ascii_digit())
        }) {
            return None;
        }
        let starts = value
            .get("starts")?
            .as_array()?
            .iter()
            .map(Value::as_f64)
            .collect::<Option<Vec<_>>>()?;
        (starts.len() <= LIMIT && starts.iter().all(|time| *time >= 0.0)).then_some(())?;
        let pending_until = value.get("pendingUntil")?.as_f64()?;
        let cooldown_until = value.get("cooldownUntil")?.as_f64()?;
        (pending_until >= 0.0 && cooldown_until >= 0.0).then_some(())?;
        Some(Self {
            phone,
            starts,
            pending_until,
            cooldown_until,
        })
    }

    pub fn to_json(&self) -> Value {
        let mut value = json!({"starts": self.starts, "pendingUntil": self.pending_until, "cooldownUntil": self.cooldown_until});
        if let Some(phone) = &self.phone {
            value["phone"] = json!(phone);
        }
        value
    }

    fn reserve(&mut self, now: f64) -> Result<bool> {
        if self.pending_until > now {
            return Ok(false);
        }
        if self.pending_until > 0.0 {
            self.cooldown_until = self.cooldown_until.max(self.pending_until + COOLDOWN);
            self.pending_until = 0.0;
        }
        if self.cooldown_until > now {
            return Err(Fail::Safe(
                "Inna sign-in is cooling down after a failure. Wait one minute before trying again.",
            ));
        }
        self.starts.retain(|time| *time > now - DAY);
        if self.starts.len() >= LIMIT {
            return Err(Fail::Safe(
                "Inna sign-in limit reached: at most 10 starts in a rolling 24 hours.",
            ));
        }
        self.starts.push(now);
        self.pending_until = now + LEASE;
        Ok(true)
    }
}

fn status(state: &str, code: Option<&str>) -> Value {
    let message = match state {
        "pending" => {
            "Approve on your phone; then call inna_sign_in_status. Compare the verification code and enter your PIN only on your phone."
        }
        "approved" => "Signed in.",
        "failed" => "Inna sign-in failed. Wait one minute before calling inna_sign_in again.",
        "expired" => "Inna sign-in expired. Wait one minute before calling inna_sign_in again.",
        _ => "No Inna sign-in is in progress.",
    };
    let mut value = json!({"status": state, "message": message});
    if let Some(code) = code {
        value["code"] = json!(code);
    }
    value
}

pub struct SignIn {
    gate: Mutex<()>,
    state: Arc<Mutex<Value>>,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Default for SignIn {
    fn default() -> Self {
        Self {
            gate: Mutex::new(()),
            state: Arc::new(Mutex::new(status("none", None))),
            task: Mutex::new(None),
        }
    }
}

impl SignIn {
    async fn current(&self) -> Value {
        self.state.lock().await.clone()
    }

    pub async fn status(&self, client: &Arc<Client>, signal: Signal) -> Result<Value> {
        let current = self.current().await;
        if current["status"] != "none" {
            return Ok(current);
        }
        client
            .run(signal, |client, _, cancel| {
                locked(client.path(), cancel, |held| {
                    let pending = held
                        .read()?
                        .and_then(|saved| saved.sign_in)
                        .map_or(0.0, |guard| guard.pending_until);
                    Ok(if pending > js::client_now() {
                        status("pending", None)
                    } else if pending > 0.0 {
                        status("expired", None)
                    } else {
                        status("none", None)
                    })
                })
            })
            .await
    }

    pub async fn start(&self, client: Arc<Client>, closing: Signal) -> Result<Value> {
        let _gate = self.gate.lock().await;
        let current = self.current().await;
        if current["status"] == "pending" {
            return Ok(current);
        }
        let reservation = client
            .run(closing.clone(), |client, _, cancel| {
                locked(client.path(), cancel, |held| {
                    // The phone and counters live only in the encrypted record.
                    if !held.decides {
                        return Ok(None);
                    }
                    let Some(mut saved) = held.read()? else {
                        return Ok(None);
                    };
                    if saved.pause_until > js::client_now() {
                        return Err(Fail::Safe(PAUSED));
                    }
                    let Some(guard) = &mut saved.sign_in else {
                        return Ok(None);
                    };
                    let Some(phone) = guard.phone.clone() else {
                        return Ok(None);
                    };
                    if !guard.reserve(js::client_now())? {
                        return Ok(Some((phone, saved.account.user_id, None)));
                    }
                    let lease = guard.pending_until;
                    held.write(&saved)?;
                    Ok(Some((phone, saved.account.user_id, Some(lease))))
                })
            })
            .await?;
        let Some((phone, preferred, lease)) = reservation else {
            return Ok(json!({"status": "none", "message": NO_PHONE}));
        };
        let Some(lease) = lease else {
            return Ok(status("pending", None));
        };
        *self.state.lock().await = status("pending", None);
        let state = self.state.clone();
        let (shown, code) = oneshot::channel();
        let task = tokio::spawn(async move {
            let signal = closing.any(&Signal::timeout(timeout()));
            let outcome = client
                .run(signal.clone(), move |client, signal, cancel| {
                    let jar = login_with_electronic_id(
                        client.net(),
                        &phone,
                        |code| {
                            let _ = shown.send(status("pending", Some(code)));
                        },
                        signal,
                        Some(preferred),
                    )?;
                    client
                        .save_sign_in(jar, false, None, signal, cancel)
                        .map(drop)
                })
                .await;
            let final_state = if outcome.is_ok() {
                "approved"
            } else if signal.aborted() {
                "expired"
            } else {
                "failed"
            };
            // Cleanup uses a fresh signal so cancellation still releases the saved lease.
            let saved = client
                .run(Signal::default(), move |client, _, cancel| {
                    locked(client.path(), cancel, |held| {
                        if let Some(mut saved) = held.read()?
                            && let Some(guard) = &mut saved.sign_in
                            && guard.pending_until == lease
                        {
                            guard.pending_until = 0.0;
                            if final_state != "approved" {
                                guard.cooldown_until = js::client_now() + COOLDOWN;
                            }
                            held.write(&saved)?;
                        }
                        Ok(())
                    })
                })
                .await;
            *state.lock().await = status(
                if saved.is_err() {
                    "failed"
                } else {
                    final_state
                },
                None,
            );
        });
        *self.task.lock().await = Some(task);
        match code.await {
            Ok(pending) => {
                let mut state = self.state.lock().await;
                if state["status"] == "pending" {
                    *state = pending.clone();
                }
                Ok(pending)
            }
            Err(_) => {
                if let Some(task) = self.task.lock().await.take() {
                    let _ = task.await;
                }
                Ok(self.current().await)
            }
        }
    }

    pub async fn close(&self) {
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompts_are_bounded_across_restart_and_pending_calls_reuse_the_lease() {
        let mut guard = Guard::default();
        let now = DAY * 2.0;
        for i in 0..10 {
            let time = now + f64::from(i) * (LEASE + COOLDOWN);
            assert!(guard.reserve(time).unwrap());
            let before = guard.to_json();
            assert!(!guard.reserve(time + 1.0).unwrap());
            assert_eq!(guard.to_json(), before);
            guard = Guard::parse(&guard.to_json()).unwrap();
        }
        assert!(guard.reserve(now + 11.0 * (LEASE + COOLDOWN)).is_err());
        assert!(guard.reserve(now + DAY + LEASE).unwrap());
        guard.pending_until = 0.0;
        guard.cooldown_until = now + DAY + LEASE + COOLDOWN;
        assert!(guard.reserve(now + DAY + LEASE + 1.0).is_err());
    }

    #[test]
    fn fixed_tool_text_preserves_the_code_and_excludes_the_phone() {
        let result = status("pending", Some("0123"));
        assert_eq!(result["code"], "0123");
        for state in ["pending", "approved", "failed", "expired", "none"] {
            assert!(!status(state, None).to_string().contains("5550000"));
        }
    }
}
