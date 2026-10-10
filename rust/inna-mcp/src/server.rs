//! The MCP surface of packages/inna-mcp/src/server.ts. tools/list replays the TypeScript server's
//! advertised tools (src/surface.json, generated with absence writes allowed and checked by a
//! test), so names, descriptions, schemas and annotations match exactly. Without
//! `--allow-absence-writes` the two write tools are neither listed nor callable, as there.

use std::sync::{Arc, OnceLock};

use mcp_runtime::{Server, Surface};
use rmcp::model::JsonObject;
use serde_json::Value;

use crate::client::Client;
use crate::error::{Fail, Result};
use crate::input;
use crate::keep_alive::{INTERVAL, KeepAlive};
use crate::signal::Signal;

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
}

impl Inna {
    /// The server, and unless `--no-keep-alive` the keep-alive, which starts now.
    pub fn new(client: Client, keep_alive: bool) -> Self {
        let client = Arc::new(client);
        let keep_alive = keep_alive.then(|| {
            let client = client.clone();
            KeepAlive::start(INTERVAL, move |signal| {
                let client = client.clone();
                async move {
                    let status = client
                        .run(signal, |client, signal, cancel| {
                            Ok(client.keep_alive(signal, cancel))
                        })
                        .await
                        .unwrap_or("failed");
                    report(status);
                }
            })
        });
        #[cfg(feature = "test-origin")]
        if let Some(keep_alive) = &keep_alive {
            test_ticks(keep_alive);
        }
        Self { client, keep_alive }
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

    // The runtime passes no per-request cancellation; a call runs to its end, as the TypeScript
    // tool callbacks do once started.
    async fn call(
        &self,
        name: &str,
        arguments: &JsonObject,
    ) -> std::result::Result<Result<Value>, String> {
        let client = &self.client;
        let signal = Signal::default();

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

    /// TypeScript closes on stdin's end, which stops the keep-alive.
    fn stdin_ended(&self) {
        self.stop_keep_alive();
    }

    /// The keep-alive stops and its tick in flight is aborted; requests in flight run to their
    /// end and write back their cookies, as the TypeScript process stays alive for them.
    async fn close(&self) {
        self.stop_keep_alive();
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
