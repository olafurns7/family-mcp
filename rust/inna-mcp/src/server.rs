//! The MCP surface of packages/inna-mcp/src/server.ts. tools/list replays the TypeScript server's
//! advertised tools (src/surface.json, generated with absence writes allowed and checked by a
//! test), so names, descriptions, schemas and annotations match exactly. Without
//! `--allow-absence-writes` the two write tools are neither listed nor callable, as there.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use mcp_runtime::{Cancelled, Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::client::Client;
use crate::error::{Fail, Result};
use crate::input;
use crate::keep_alive::{self, KeepAlive};
use crate::signal::Controller;

/// The tools `createServer` registers only with `allowAbsenceWrites`.
const WRITE_TOOLS: [&str; 2] = ["inna_prepare_absence", "inna_submit_absence"];

fn surface(allow_absence_writes: bool) -> &'static Surface {
    static ALL: OnceLock<Surface> = OnceLock::new();
    static READ: OnceLock<Surface> = OnceLock::new();
    let all = ALL.get_or_init(|| Surface::parse(include_str!("surface.json")));

    if allow_absence_writes {
        return all;
    }
    READ.get_or_init(|| Surface {
        instructions: all.instructions.clone(),
        tools: all
            .tools
            .iter()
            .filter(|tool| !WRITE_TOOLS.contains(&tool.name.as_ref()))
            .cloned()
            .collect(),
    })
}

pub struct Inna {
    client: Arc<Client>,
    keep_alive: Option<KeepAlive>,
    /// Aborts every call in flight once the server closes, as the TypeScript SDK's close aborts
    /// each handler's signal.
    closing: Controller,
}

impl Inna {
    /// Always renew while serving; the flag changes the cadence after the first renewal.
    pub fn new(client: Client, keep_alive: bool) -> Self {
        let client = Arc::new(client);
        let cadence = keep_alive::interval(keep_alive);
        let keep_alive = Some({
            let warned = Arc::new(AtomicBool::new(false));
            let client = client.clone();
            KeepAlive::start(keep_alive::retry_interval(), move |signal| {
                let client = client.clone();
                let warned = warned.clone();
                async move {
                    let status = client
                        .run(signal, |client, signal, cancel| {
                            Ok(client.keep_alive(signal, cancel))
                        })
                        .await
                        .unwrap_or("failed");
                    report(status);
                    if status == "kept" {
                        warned.store(false, Ordering::Relaxed);
                    } else if (status == "signInRequired"
                        || (status == "failed" && client.renewal_overdue()))
                        && !warned.swap(true, Ordering::Relaxed)
                    {
                        eprintln!(
                            "{}",
                            if status == "signInRequired" {
                                "Inna sign-in is required. Run auth login or import a fresh private cookie export."
                            } else {
                                "Inna renewal failed. School requests require successful renewal."
                            }
                        );
                    }
                    if status == "kept" {
                        cadence
                    } else {
                        keep_alive::retry_interval()
                    }
                }
            })
        });
        #[cfg(feature = "test-origin")]
        if let Some(keep_alive) = &keep_alive {
            test_ticks(keep_alive);
        }
        Self {
            client,
            keep_alive,
            closing: Controller::default(),
        }
    }

    fn stop_keep_alive(&self) {
        if let Some(keep_alive) = &self.keep_alive {
            keep_alive.stop();
        }
    }
}

/// Nothing is logged; a test build with INNA_TEST_KEEP_ALIVE reports each status on stderr.
fn report(_status: &str) {
    #[cfg(feature = "test-origin")]
    if std::env::var_os("INNA_TEST_KEEP_ALIVE").is_some() {
        eprintln!("keep-alive: {_status}");
    }
}

/// A test build with INNA_TEST_KEEP_ALIVE ticks on SIGUSR1, as the TypeScript tests fire their
/// injected timer.
#[cfg(feature = "test-origin")]
fn test_ticks(keep_alive: &KeepAlive) {
    use tokio::signal::unix::{SignalKind, signal};

    if std::env::var_os("INNA_TEST_KEEP_ALIVE").is_none() {
        return;
    }
    let fire = keep_alive.fire_handle();
    let mut ticks = signal(SignalKind::user_defined1()).expect("a SIGUSR1 handler");
    tokio::spawn(async move {
        while ticks.recv().await.is_some() {
            fire.notify_one();
        }
    });
}

impl Server for Inna {
    type Fail = Fail;

    const NAME: &'static str = "inna-mcp";

    const VERSION: &'static str = env!("CARGO_PKG_VERSION");

    fn surface(&self) -> &Surface {
        surface(self.client.allow_absence_writes)
    }

    /// Each call's signal is TypeScript's `ctx.mcpReq.signal`: it aborts when the host cancels the
    /// call or the server closes, which stops the lock wait, every request and a write in flight.
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
        cancelled: Cancelled,
    ) -> std::result::Result<Result<Value>, String> {
        let client = &self.client;
        // The task owns the controller: a dropped one would never abort the signal.
        let host = Controller::default();
        let signal = host.signal().any(&self.closing.signal());
        tokio::spawn(async move {
            cancelled.await;
            host.abort();
        });

        Ok(match name {
            "inna_session_status" => {
                let key = input::student(arguments)?;
                client
                    .run(signal, move |c, s, x| c.status(s, x, key.as_deref()))
                    .await
            }
            "inna_list_students" => {
                input::empty(arguments)?;
                client.run(signal, |c, s, x| c.list_students(s, x)).await
            }
            "inna_get_overview" => {
                let key = input::student(arguments)?;
                client
                    .run(signal, move |c, s, x| c.overview(s, x, key.as_deref()))
                    .await
            }
            "inna_get_timetable" => {
                let range = input::range(arguments)?;
                client
                    .run(signal, move |c, s, x| c.timetable(s, x, &range))
                    .await
            }
            "inna_get_assignments" => {
                let (kind, key) = input::assignments(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.assignments(s, x, kind, key.as_deref())
                    })
                    .await
            }
            "inna_get_assignment" => {
                let (id, key) = input::assignment(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.assignment(s, x, &id, key.as_deref())
                    })
                    .await
            }
            "inna_get_grades" => {
                let (term, key) = input::term(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.grades(s, x, term.as_deref(), key.as_deref())
                    })
                    .await
            }
            "inna_get_course_grades" => {
                let (group, key) = input::group(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.course_grades(s, x, &group, key.as_deref())
                    })
                    .await
            }
            "inna_get_attendance" => {
                let (term, key) = input::term(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.attendance(s, x, term.as_deref(), key.as_deref())
                    })
                    .await
            }
            "inna_get_materials" => {
                let (group, key) = input::group(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.materials(s, x, &group, key.as_deref())
                    })
                    .await
            }
            "inna_get_messages" => {
                let (rows, key) = input::messages(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.messages(s, x, rows, key.as_deref())
                    })
                    .await
            }
            "inna_get_message" => {
                let ((id, kind), key) = input::message(arguments)?;
                client
                    .run(signal, move |c, s, x| {
                        c.message(s, x, (&id, &kind), key.as_deref())
                    })
                    .await
            }
            "inna_get_absences" => {
                let range = input::range(arguments)?;
                client
                    .run(signal, move |c, s, x| c.absences(s, x, &range))
                    .await
            }
            "inna_absence_status" => {
                input::empty(arguments)?;
                client.run(signal, |c, s, x| c.absence_status(s, x)).await
            }
            "inna_prepare_absence" => {
                let request = input::absence(arguments)?;
                client
                    .run(signal, move |c, s, x| c.prepare_absence(s, x, request))
                    .await
            }
            "inna_submit_absence" => {
                let id = input::submit(arguments)?;
                client
                    .run(signal, move |c, s, x| c.submit_absence(s, x, &id))
                    .await
            }
            // The runtime lists and accepts only the surface's tools.
            _ => Err(Fail::Unknown),
        })
    }

    /// TypeScript closes on stdin's end: the keep-alive stops and calls in flight are aborted at
    /// once. rmcp would cancel them only after waiting up to 5 s for their answers.
    fn stdin_ended(&self) {
        self.stop_keep_alive();
        self.closing.abort();
    }

    /// On SIGINT or SIGTERM, or after stdin's end: the keep-alive stops and its tick in flight is
    /// aborted, calls in flight are aborted, and each writes back its cookies before the process
    /// exits, as the TypeScript process stays alive for them.
    async fn close(&self) {
        self.stop_keep_alive();
        self.closing.abort();
        self.client.idle().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_tools_are_listed_only_when_allowed() {
        let names = |allowed| -> Vec<String> {
            surface(allowed)
                .tools
                .iter()
                .map(|tool| tool.name.to_string())
                .collect()
        };
        assert_eq!(names(true).len(), 16);
        assert_eq!(names(false).len(), 14);
        assert_eq!(names(true)[14..], WRITE_TOOLS);
        assert_eq!(names(true)[..14], names(false));
        assert_eq!(surface(true).instructions, surface(false).instructions);
    }
}
