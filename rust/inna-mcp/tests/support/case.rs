//! What tests/ts/integration.test.ts's `fixture` and the rust-inna.ts drop-ins gave each case: a
//! scratch home holding an imported session (`INNA_SESSION_FILE` beside the store), the case's
//! provider, and clients. As the drop-in `InnaClient`, each client is one `inna-mcp serve` with its
//! own loopback upstream, which answers as the shared provider or as a case's wrapper around it, and
//! the keep-alive ticks only on SIGUSR1 (INNA_TEST_KEEP_ALIVE).

use std::sync::{Arc, Condvar, Mutex};

use serde_json::{Value, json};

use super::provider::Provider;
use super::{Home, Mcp, PATIENCE, Reply, Request, Run, Upstream, cli};

/// integration.test.ts's `fixture` cookie export.
pub const EXPORT: &str = r#"[{"name":"SESSION","value":"synthetic-session","domain":"nam.inna.is","path":"/","secure":true},{"name":"XSRF-TOKEN","value":"synthetic-xsrf","domain":"nam.inna.is","path":"/","secure":true}]"#;

pub struct Case {
    pub home: Home,
    pub provider: Provider,
    pub upstream: Upstream,
    writes: bool,
}

impl Case {
    /// `fixture(allowAbsenceWrites)`: the provider, and its session imported.
    pub fn new(name: &str, writes: bool) -> Self {
        let case = Self::empty(name, writes);
        case.home.write("cookies.json", EXPORT, 0o600);
        let source = case.home.path("cookies.json").display().to_string();
        let run = case.cli(&["auth", "import", &source]);
        assert_eq!(run.code, Some(0), "import: {run:?}");
        case
    }

    /// The provider and the home, with nothing imported.
    pub fn empty(name: &str, writes: bool) -> Self {
        let provider = Provider::default();
        let upstream = provider.upstream();
        Self {
            home: Home::new(name),
            provider,
            upstream,
            writes,
        }
    }

    /// The drop-in harness's environment besides the home's own.
    pub fn env(&self) -> Vec<(String, String)> {
        vec![
            (
                "INNA_SESSION_FILE".into(),
                self.home.path("session.json").display().to_string(),
            ),
            ("INNA_TEST_KEEP_ALIVE".into(), "1".into()),
        ]
    }

    /// One `inna-mcp` command line against the case's upstream.
    pub fn cli(&self, args: &[&str]) -> Run {
        cli(&self.home, &self.upstream.origin, &self.env(), args, None)
    }

    /// A client on the case's own upstream.
    pub fn client(&self) -> Client {
        self.client_on(None)
    }

    /// A client whose upstream answers with `handler` (a case's fetch around the provider).
    pub fn client_with(
        &self,
        handler: impl Fn(&Request) -> Reply + Send + Sync + 'static,
    ) -> Client {
        self.client_on(Some(Upstream::new(handler)))
    }

    /// A client without `--allow-absence-writes`, whatever the case allows.
    pub fn read_only_client(&self) -> Client {
        let (mcp, _) = Mcp::start(&self.home, &self.upstream.origin, &self.env(), &[]);
        Client {
            mcp,
            _upstream: None,
        }
    }

    fn client_on(&self, upstream: Option<Upstream>) -> Client {
        let origin = upstream.as_ref().unwrap_or(&self.upstream).origin.clone();
        let args: &[&str] = match self.writes {
            true => &["--allow-absence-writes"],
            false => &[],
        };
        let (mcp, _) = Mcp::start(&self.home, &origin, &self.env(), args);
        Client {
            mcp,
            _upstream: upstream,
        }
    }

    /// The text of the absence record beside the session file, if any.
    pub fn journal(&self) -> Option<String> {
        std::fs::read_to_string(self.home.path("session.json.absence.json")).ok()
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        if !std::thread::panicking() {
            self.provider.finish("the case's provider");
        }
    }
}

/// One `serve`, as a drop-in `InnaClient`.
pub struct Client {
    pub mcp: Mcp,
    _upstream: Option<Upstream>,
}

impl Client {
    /// A tool's structured content, or its error text (a tool error or a protocol error).
    pub fn call(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let answer = self.mcp.call(name, arguments);
        let value = answer.value();

        if let Some(error) = value.get("error") {
            return Err(error["message"].as_str().unwrap_or_default().to_owned());
        }
        answer.outcome()
    }

    /// `prepareAbsence(input)`.
    pub fn prepare(&mut self, input: Value) -> Result<Value, String> {
        self.call("inna_prepare_absence", input)
    }

    /// `submitAbsence(operationId, true)`.
    pub fn submit(&mut self, operation_id: &str) -> Result<Value, String> {
        self.call(
            "inna_submit_absence",
            json!({"operationId": operation_id, "confirm": true}),
        )
    }

    /// `absenceStatus()`.
    pub fn status(&mut self) -> Value {
        self.call("inna_absence_status", json!({})).unwrap()
    }
}

/// Fails unless `outcome` is an error whose text contains `part`.
#[track_caller]
pub fn refused(outcome: Result<Value, String>, part: &str) -> String {
    match outcome {
        Err(text) if text.contains(part) => text,
        other => panic!("expected a refusal with {part:?}, got {other:?}"),
    }
}

/// A request held at the upstream until released: `hold` runs in the upstream's handler.
#[derive(Clone, Default)]
pub struct Gate(Arc<(Mutex<(bool, bool)>, Condvar)>);

impl Gate {
    /// In the handler: say the request has come, and wait for `release`.
    pub fn hold(&self) {
        let (lock, changed) = &*self.0;
        let mut state = lock.lock().unwrap();
        state.0 = true;
        changed.notify_all();

        while !state.1 {
            state = changed.wait(state).unwrap();
        }
    }

    /// Wait until the held request has come.
    pub fn reached(&self) {
        let (lock, changed) = &*self.0;
        let state = lock.lock().unwrap();
        let (state, timeout) = changed
            .wait_timeout_while(state, PATIENCE, |state| !state.0)
            .unwrap();
        drop(state);
        assert!(!timeout.timed_out(), "the held request never came");
    }

    pub fn release(&self) {
        let (lock, changed) = &*self.0;
        lock.lock().unwrap().1 = true;
        changed.notify_all();
    }
}
