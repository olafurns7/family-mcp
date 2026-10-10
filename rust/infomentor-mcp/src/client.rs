//! packages/infomentor-mcp/src/client.ts's `InfoMentorClient`: one queue of account operations per
//! MCP connection. Each read holds the store lock, proves the session on the parent page, and
//! writes changed cookies back before the next read.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use family_store::{Cancel, KeyProvider};
use serde_json::{Value, json};
use tokio::sync::Mutex;

use crate::collection::{Source, collect_updates};
use crate::error::{Code, Fail, Result};
use crate::http::{Http, Parent};
use crate::input::{CollectRequest, MessagesRequest, NotificationsRequest};
use crate::js;
use crate::session::{SavedSession, capture, session_path};
use crate::shapes::{self, Feed, MessagesPage};
use crate::signal::{Controller, Signal};
use crate::store::{Held, with_session};
use crate::upstream::Net;

const COLLECTION_TIMEOUT: Duration = Duration::from_secs(5 * 60);

const OVERVIEW_MAX_UNITS: usize = 40_000;

/// `SessionOptions`.
#[derive(Default)]
pub struct Options {
    /// `--session`, resolved.
    pub session_file: Option<PathBuf>,
    /// `--credentials`, resolved.
    #[expect(dead_code, reason = "login uses it from slice 3")]
    pub credentials_file: Option<PathBuf>,
    /// The store's keys; `None` uses the default provider.
    pub keys: Option<Arc<dyn KeyProvider>>,
}

/// What a read sees besides the HTTP session.
pub struct Context<'a> {
    pub signal: &'a Signal,
    /// `signal`, as the store's cancel flag.
    pub cancel: &'a Cancel,
    /// How the session is stored, for the status tool.
    pub storage: &'static str,
}

/// The HTTP session built from the saved one, and that saved session's JSON.
struct Active {
    http: Http,
    serialized: String,
}

pub struct Client {
    options: Options,
    net: Net,
    /// The queue: one operation at a time, in call order, holding the cached session.
    active: Arc<Mutex<Option<Active>>>,
    lifetime: Controller,
    closed: AtomicBool,
    /// A login or import is running.
    setup: AtomicBool,
    logging_out: AtomicBool,
}

/// `sessionFromHttp`: the jar's cookies, the verified account and selected child, and an active
/// rate-limit pause.
pub fn session_from_http(http: &Http) -> Result<SavedSession> {
    let mut session = capture(&http.jar)?;

    if let Some(parent) = &http.parent {
        session.account_id = Some(parent.account_id.clone());
        let mut selected = parent.pupils.iter().filter(|pupil| pupil.selected);

        if let (Some(only), None) = (selected.next(), selected.next()) {
            session.selected_child_id = Some(only.id.clone());
        }
    }

    if http.rate_limited_until() > js::now_ms() {
        session.rate_limited_until = Some(js::iso_string(http.rate_limited_until()));
    }
    Ok(session)
}

/// `saveActive`: persist the session when a request changed it, never for another account.
fn save_active(
    active: &mut Active,
    previous: &SavedSession,
    held: &mut Held,
) -> Result<SavedSession> {
    let mut current = session_from_http(&active.http)?;

    if let (Some(previous), Some(current)) = (&previous.account_id, &current.account_id)
        && previous != current
    {
        return Err(Fail::new(
            Code::InvalidSession,
            "Refusing to replace the verified account during a school-data request. Sign in explicitly to change accounts.",
        ));
    }

    if current.account_id.is_none() {
        current.account_id.clone_from(&previous.account_id);
    }

    if current.selected_child_id.is_none() {
        current
            .selected_child_id
            .clone_from(&previous.selected_child_id);
    }

    if current.comparable() == previous.comparable() {
        active.serialized = previous.to_json().to_string();
        return Ok(previous.clone());
    }
    held.save(&current)?;
    active.serialized = current.to_json().to_string();
    Ok(current)
}

fn timetable(http: &mut Http, signal: &Signal) -> Result<Feed> {
    http.read_app_data(
        "timetable/timetable/appData",
        &[],
        signal,
        shapes::timetable_response,
    )
}

fn messages_page(
    http: &mut Http,
    signal: &Signal,
    folder: &str,
    page: i64,
    page_size: i64,
    search: &str,
) -> Result<MessagesPage> {
    http.read_app_data(
        "Message/message/GetMessages",
        &[
            ("page", page.to_string()),
            ("pageSize", page_size.to_string()),
            ("messageText", search.to_owned()),
            ("inbox", (folder == "inbox").to_string()),
            ("sentItems", (folder == "sent").to_string()),
        ],
        signal,
        shapes::messages_response,
    )
}

fn message(http: &mut Http, signal: &Signal, id: i64) -> Result<Value> {
    http.read_app_data(
        "Message/message/GetMessage",
        &[("id", id.to_string())],
        signal,
        shapes::message_detail,
    )
}

fn notifications(http: &mut Http, signal: &Signal) -> Result<Feed> {
    http.read_app_data(
        "NotificationApp/NotificationApp/appData",
        &[],
        signal,
        shapes::notifications_response,
    )
}

fn text<'v>(value: &'v Value, key: &str) -> &'v str {
    value[key].as_str().unwrap_or_default()
}

/// The overview of the selected child, after selecting `child_id` when given.
fn overview(http: &mut Http, signal: &Signal, child_id: Option<&str>) -> Result<Value> {
    let mut read = || -> Result<Value> {
        let parent = match (child_id, &http.parent) {
            (None, Some(parent)) => parent.clone(),
            _ => http.read_parent(signal, child_id)?,
        };
        let (timetable, skipped) = match parent.has_timetable() {
            true => {
                let feed = timetable(http, signal)?;
                (Some(feed.items), feed.skipped)
            }
            false => (None, 0),
        };
        let mut lines: Vec<String> = parent
            .pupils
            .iter()
            .map(|pupil| {
                format!(
                    "{}{}",
                    pupil.name,
                    if pupil.selected { " (selected)" } else { "" }
                )
            })
            .collect();

        for item in timetable.iter().flatten() {
            lines.push(format!(
                "{}: {} ({}–{})",
                text(item, "start"),
                text(item, "title"),
                text(item, "startTime"),
                text(item, "endTime")
            ));
        }
        let text = lines.join("\n");
        Ok(json!({
            "title": "InfoMentor parent overview",
            "text": js::slice_units(&text, OVERVIEW_MAX_UNITS),
            "truncated": js::units(&text) > OVERVIEW_MAX_UNITS,
            "children": parent
                .pupils
                .iter()
                .map(|pupil| json!({"id": pupil.id, "name": pupil.name, "selected": pupil.selected}))
                .collect::<Vec<_>>(),
            "timetable": timetable,
            "skipped": skipped,
            "retrievedAt": js::iso_string(js::now_ms()),
        }))
    };

    match (read(), child_id) {
        (Err(fail), Some(_)) => Err(fail.rewrap(
            "InfoMentor could not load the selected child. Selection may have changed; refresh infomentor_get_overview before continuing.",
        )),
        (outcome, _) => outcome,
    }
}

/// A collection's reads through the session; the parent page the read already verified is used
/// once, as the first parent read.
struct Reads<'h> {
    http: &'h mut Http,
    cached: Option<Parent>,
}

impl Source for Reads<'_> {
    fn get_parent(&mut self, signal: &Signal) -> Result<Parent> {
        match self.cached.take() {
            Some(parent) => Ok(parent),
            None => self.http.read_parent(signal, None),
        }
    }

    fn select_child(&mut self, child_id: &str, signal: &Signal) -> Result<Parent> {
        self.http.read_parent(signal, Some(child_id))
    }

    fn read_timetable(&mut self, parent: &Parent, signal: &Signal) -> Result<Option<Feed>> {
        match parent.has_timetable() {
            true => timetable(self.http, signal).map(Some),
            false => Ok(None),
        }
    }

    fn get_messages(&mut self, folder: &str, page: i64, signal: &Signal) -> Result<MessagesPage> {
        messages_page(self.http, signal, folder, page, 100, "")
    }

    fn get_message(&mut self, id: i64, signal: &Signal) -> Result<Value> {
        message(self.http, signal, id)
    }

    fn get_notifications(&mut self, signal: &Signal) -> Result<Feed> {
        notifications(self.http, signal)
    }
}

impl Client {
    /// `None` outside a Tokio runtime or when no HTTP client can be built.
    pub fn new(options: Options) -> Option<Self> {
        Some(Self {
            options,
            net: Net::new()?,
            active: Arc::default(),
            lifetime: Controller::default(),
            closed: AtomicBool::new(false),
            setup: AtomicBool::new(false),
            logging_out: AtomicBool::new(false),
        })
    }

    /// Queue `read` behind earlier operations and run it on a blocking thread with the session
    /// held: verified on the parent page first, and saved again afterwards when it changed.
    async fn read<T: Send + 'static>(
        self: &Arc<Self>,
        signal: Signal,
        read: impl FnOnce(&mut Http, &Context) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let signal = signal.any(&self.lifetime.signal());
        // A local queue preserves call order; the store lock also excludes other MCP processes.
        let mut active = self.active.clone().lock_owned().await;
        let client = self.clone();

        tokio::task::spawn_blocking(move || client.held_read(&mut active, &signal, read))
            .await
            .unwrap_or(Err(Fail::Unknown))
    }

    fn held_read<T>(
        &self,
        active: &mut Option<Active>,
        signal: &Signal,
        read: impl FnOnce(&mut Http, &Context) -> Result<T>,
    ) -> Result<T> {
        signal.check()?;

        if self.closed.load(Ordering::SeqCst) {
            return Err(Fail::new(
                Code::Cancelled,
                "This InfoMentor client has been closed.",
            ));
        }

        if self.setup.load(Ordering::SeqCst) || self.logging_out.load(Ordering::SeqCst) {
            return Err(Fail::new(
                Code::OperationInProgress,
                "Account setup is in progress. Check infomentor_setup_status before reading school data.",
            ));
        }
        let file = session_path(self.options.session_file.as_deref())?;
        let bridge = signal.store_cancel(&self.net.handle);

        with_session(&file, &bridge.cancel, self.options.keys.clone(), |held| {
            let mut saved = held.session.clone();
            let serialized = saved.to_json().to_string();

            if active
                .as_ref()
                .is_none_or(|active| active.serialized != serialized)
            {
                *active = None;
            }
            let active = active.get_or_insert_with(|| Active {
                http: Http::new(saved.jar(), saved.cooldown(), self.net.clone()),
                serialized,
            });
            let mut preserve = false;
            let attempt = || -> Result<T> {
                // A verified parent page proves authentication and is reused by the read below.
                let parent = active.http.read_parent(signal, None)?;

                if saved
                    .account_id
                    .as_ref()
                    .is_some_and(|account| *account != parent.account_id)
                {
                    return Err(Fail::new(
                        Code::InvalidSession,
                        "The saved session no longer matches its verified account. Sign in explicitly before continuing.",
                    ));
                }
                saved = save_active(active, &saved, held)?;
                let context = Context {
                    signal,
                    cancel: &bridge.cancel,
                    storage: held.storage,
                };
                let output = read(&mut active.http, &context)?;
                signal.check()?;
                Ok(output)
            };
            let outcome = attempt();

            if outcome
                .as_ref()
                .is_err_and(|fail| fail.is(Code::LoginRequired))
            {
                preserve = true;
            }

            if !preserve && !signal.aborted() {
                save_active(active, &saved, held)?;
            }
            outcome
        })
    }

    pub async fn overview(self: &Arc<Self>, signal: Signal) -> Result<Value> {
        self.read(signal, |http, context| overview(http, context.signal, None))
            .await
    }

    pub async fn select_child(self: &Arc<Self>, child_id: String, signal: Signal) -> Result<Value> {
        self.read(signal, move |http, context| {
            overview(http, context.signal, Some(&child_id))
        })
        .await
    }

    pub async fn messages(
        self: &Arc<Self>,
        input: MessagesRequest,
        signal: Signal,
    ) -> Result<Value> {
        self.read(signal, move |http, context| {
            let page = messages_page(
                http,
                context.signal,
                input.folder,
                input.page,
                input.page_size,
                &input.search,
            )?;
            // The live endpoint reports page: 0 even when it correctly applies a requested page.
            Ok(json!({
                "items": page.items,
                "skipped": page.skipped,
                "more": page.more,
                "page": input.page,
                "pageSize": input.page_size,
                "folder": input.folder,
                "retrievedAt": js::iso_string(js::now_ms()),
            }))
        })
        .await
    }

    pub async fn message(self: &Arc<Self>, id: i64, signal: Signal) -> Result<Value> {
        self.read(signal, move |http, context| {
            Ok(json!({
                "message": message(http, context.signal, id)?,
                "retrievedAt": js::iso_string(js::now_ms()),
            }))
        })
        .await
    }

    pub async fn notifications(
        self: &Arc<Self>,
        input: NotificationsRequest,
        signal: Signal,
    ) -> Result<Value> {
        self.read(signal, move |http, context| {
            let feed = notifications(http, context.signal)?;
            let shown: Vec<Value> = feed
                .items
                .into_iter()
                .filter(|item| {
                    (input.include_cleared || item["state"] != "Cleared")
                        && (!input.selected_child_only
                            || item["currentlySelectedPupil"] == Value::Bool(true))
                })
                .collect();
            Ok(json!({
                "notifications": shown,
                "skipped": feed.skipped,
                "selectedChildOnly": input.selected_child_only,
                "includeCleared": input.include_cleared,
                "retrievedAt": js::iso_string(js::now_ms()),
            }))
        })
        .await
    }

    pub async fn collect(self: &Arc<Self>, input: CollectRequest, signal: Signal) -> Result<Value> {
        let signal = signal.any(&Signal::timeout(COLLECTION_TIMEOUT));
        let session_file = self.options.session_file.clone();

        self.read(signal, move |http, context| {
            let file = session_path(session_file.as_deref())?;
            let cached = http.parent.clone();
            let mut reads = Reads { http, cached };
            collect_updates(&input, &file, context.signal, context.cancel, &mut reads)
        })
        .await
    }

    /// `getSessionStatus`: an expired or missing session is a status, not a failure.
    pub async fn session_status(self: &Arc<Self>, signal: Signal) -> Result<Value> {
        let status = self
            .read(signal, |_, context| {
                Ok(json!({"authenticated": true, "storage": context.storage}))
            })
            .await;

        match status {
            Err(Fail::Im {
                code: Code::LoginRequired,
                message,
                ..
            }) => Ok(json!({"authenticated": false, "nextStep": message})),
            other => other,
        }
    }

    /// Stop every operation: queued and running reads end with a cancellation.
    pub fn abort(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.lifetime.abort();
    }

    /// `close`: abort, then wait for the running operation to end.
    pub async fn close(&self) {
        self.abort();
        *self.active.lock().await = None;
    }
}
