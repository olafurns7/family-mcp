//! `inna-mcp auth renew`: the keep-alive's one renewal as a command for a system timer, its exit
//! codes and fixed messages, and its hold on the store beside a running `serve`. Needs no Bun;
//! needs the `test-origin` feature.
#![cfg(feature = "test-origin")]

mod support;

use std::io::Read;
use std::process::{Child, Stdio};

use serde_json::{Value, json};
use support::case::{Case, Gate};
use support::provider::{Provider, SIBLING, expect_clean, sibling};
use support::{NOW, PATIENCE, Reply, Request, Run, Upstream, no_leak, waits_for_lock};

const USER_PATH: &str = "/api/UserData/GetLoggedInUser";

const NO_SESSION: &str =
    "No Inna session. Run inna-mcp auth login or auth import with a private cookie export.\n";

const SIGN_IN_REQUIRED: &str =
    "Inna sign-in is required. Run auth login or import a fresh private cookie export.\n";

const NOT_RENEWED: &str = "Inna renewal failed, and Inna did not ask for sign-in. Run inna-mcp auth status in a terminal for details; a later run may succeed.\n";

const SESSION_UNUSABLE: &str = "The saved Inna session cannot be used, because a write to the session store did not complete. Run inna-mcp auth status in a terminal; it says what to remove before you sign in again.\n";

const PAUSED: &str = "Inna requested a pause. Wait before making another request.\n";

const RATE_LIMITED: &str = "Inna rate limited this session. Wait before trying again.\n";

const REFUSED_STORE: &str = "Cannot use the Inna session store. Run inna-mcp auth status in a terminal; it shows what is wrong and where. Do not delete the store first.\n";

/// The value of the saved SESSION cookie.
fn session_cookie(saved: &Value) -> String {
    let jar: Value = serde_json::from_str(saved["jar"].as_str().unwrap()).unwrap();
    jar["cookies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|cookie| cookie["key"] == "SESSION")
        .and_then(|cookie| cookie["value"].as_str())
        .unwrap()
        .to_owned()
}

/// The record without its cookie jar.
fn without_jar(saved: &Value) -> Value {
    let mut saved = saved.clone();
    saved["jar"] = json!("");
    saved
}

/// Fails unless `run` ended with `code`, printed nothing on stdout and exactly `stderr`.
#[track_caller]
fn expect(run: &Run, code: i32, stderr: &str) {
    assert_eq!(run.code, Some(code), "{run:?}");
    assert_eq!(run.stdout, "", "{run:?}");
    assert_eq!(run.stderr, stderr, "{run:?}");
}

/// No output of a renewal holds a cookie, a decoy, or a path.
#[track_caller]
fn clean(case: &Case, run: &Run) {
    let text = format!("{}{}", run.stdout, run.stderr);
    no_leak(&text, "auth renew");
    expect_clean(&text, "auth renew");
    assert!(!text.contains('/'), "a path or URL in {text:?}");
    assert!(!text.contains(&case.home.0.display().to_string()));
}

#[test]
fn help_lists_the_command() {
    let case = Case::empty("help", false);
    let run = case.cli(&["--help"]);
    assert_eq!(run.code, Some(0));
    assert!(
        run.stdout.contains(
            "\n  inna-mcp auth renew                 Renew the saved session once, for a timer; prints nothing on success\n"
        ),
        "{}",
        run.stdout
    );
}

#[test]
fn a_renewal_makes_one_user_request_saves_the_rotated_cookie_and_prints_nothing() {
    let case = Case::new("kept", false);
    let before = case.saved();
    let count = case.provider.state().calls.len();
    case.provider.state().rotation = "synthetic-renewed-once".into();
    let run = case.cli(&["auth", "renew"]);
    expect(&run, 0, "");
    assert_eq!(case.provider.paths(count), [USER_PATH]);
    let after = case.saved();
    assert_eq!(session_cookie(&after), "synthetic-renewed-once");
    assert_ne!(session_cookie(&before), "synthetic-renewed-once");
    assert_eq!(without_jar(&after), without_jar(&before));
    assert_eq!(case.provider.state().switches, 0);
    assert_eq!(case.provider.state().posts, 0);
}

#[test]
fn without_a_session_nothing_is_sent_and_the_code_is_3() {
    let case = Case::empty("none", false);
    let run = case.cli(&["auth", "renew"]);
    expect(&run, 3, NO_SESSION);
    clean(&case, &run);
    assert!(case.provider.state().calls.is_empty());
    assert!(!case.store().exists());

    let signed_out = Case::new("signed-out", false);
    assert_eq!(signed_out.cli(&["auth", "logout"]).code, Some(0));
    let count = signed_out.provider.state().calls.len();
    let run = signed_out.cli(&["auth", "renew"]);
    expect(&run, 3, NO_SESSION);
    assert_eq!(signed_out.provider.state().calls.len(), count);
    assert_eq!(signed_out.home.record().as_deref(), Some("null"));
}

/// Inna's refusal needs an explicit login: code 4. The session stays saved, as `serve` keeps it,
/// and each run asks again: a one-shot command has no memory of refused credentials.
#[test]
fn a_refused_session_exits_4_keeps_the_record_and_each_run_asks_once() {
    let case = Case::new("refused", false);
    let before = case.saved();
    case.provider.state().unauthorized = true;
    let count = case.provider.state().calls.len();

    for run in 1..=2 {
        let outcome = case.cli(&["auth", "renew"]);
        expect(&outcome, 4, SIGN_IN_REQUIRED);
        clean(&case, &outcome);
        assert_eq!(case.provider.paths(count), vec![USER_PATH; run]);
    }
    let after = case.saved();
    assert_eq!(without_jar(&after), without_jar(&before));
    assert_eq!(session_cookie(&after), session_cookie(&before));
}

/// A 429 sends one request and saves the pause (code 5: not renewed, session kept); during the
/// pause nothing is sent (code 6); after it the renewal goes ahead.
#[test]
fn a_rate_limit_saves_the_pause_and_later_runs_send_nothing_until_it_ends() {
    let case = Case::new("paused", false);
    let before = case.saved();
    case.provider.state().rate_limit = true;
    let count = case.provider.state().calls.len();
    let run = case.cli(&["auth", "renew"]);
    expect(&run, 5, RATE_LIMITED);
    assert_eq!(case.provider.paths(count), [USER_PATH]);
    assert_eq!(case.saved()["pauseUntil"], json!(NOW + 60_000));
    assert_eq!(session_cookie(&case.saved()), session_cookie(&before));

    case.provider.state().rate_limit = false;
    let record = case.home.record();
    let run = case.cli(&["auth", "renew"]);
    expect(&run, 6, PAUSED);
    clean(&case, &run);
    assert_eq!(case.provider.state().calls.len(), count + 1);
    assert_eq!(case.home.record(), record);

    case.home.set_clock(NOW + 59_999);
    expect(&case.cli(&["auth", "renew"]), 6, PAUSED);
    case.home.set_clock(NOW + 60_000);
    expect(&case.cli(&["auth", "renew"]), 0, "");
    assert_eq!(case.provider.paths(count), [USER_PATH, USER_PATH]);
}

/// A lost connection or an unexpected answer: code 5, the saved credentials and students kept.
#[test]
fn network_and_service_failures_exit_5_and_keep_the_session() {
    let case = Case::new("failures", false);
    let before = case.saved();

    for (reply, message) in [
        (Reply::dropped(), NOT_RENEWED),
        (Reply::empty(503), NOT_RENEWED),
        (Reply::json(200, &json!({"no": "user"})), NOT_RENEWED),
    ] {
        let upstream = Upstream::new(move |_| reply.clone());
        let run = support::cli(
            &case.home,
            &upstream.origin,
            &case.env(),
            &["auth", "renew"],
            None,
        );
        expect(&run, 5, message);
        clean(&case, &run);
        assert_eq!(upstream.sent(), [format!("GET {USER_PATH}")]);
        let after = case.saved();
        assert_eq!(without_jar(&after), without_jar(&before));
        assert_eq!(session_cookie(&after), session_cookie(&before));
    }
}

/// Inna rotates the cookies but the write-back fails: the rotated credentials must not be offered
/// again, so the record goes; the output says the session cannot be used, without the store's paths.
#[test]
fn a_failed_write_back_of_rotated_cookies_says_the_session_is_unusable_without_a_path() {
    let case = Case::new("write-back", false);
    let marker = case.store().with_extension("enc.marker");
    let provider = case.provider.clone();
    let upstream = Upstream::new(move |request: &Request| {
        // The store's marker becomes a directory, so the write after this answer fails.
        std::fs::remove_file(&marker).unwrap();
        std::fs::create_dir(&marker).unwrap();
        provider.state().rotation = "synthetic-unsaved".into();
        provider.answer(request)
    });
    let run = support::cli(
        &case.home,
        &upstream.origin,
        &case.env(),
        &["auth", "renew"],
        None,
    );
    expect(&run, 5, SESSION_UNUSABLE);
    clean(&case, &run);
    assert!(!run.stderr.contains("Library") && !run.stderr.contains(".config"));
    assert!(!case.store().exists());
    // In a terminal, auth status names the store file that is in the way.
    let status = case.cli(&["auth", "status"]);
    assert_eq!(status.code, Some(1), "{status:?}");
    assert!(status.stderr.contains("session.enc.marker"), "{status:?}");
}

/// The renewal never switches or learns a student, even when Inna's own selection has moved:
/// the saved default student and the learned students stay as they were.
#[test]
fn a_renewal_on_a_session_moved_to_the_sibling_neither_switches_nor_relearns() {
    let case = Case::new("moved", false);
    let before = case.saved();
    {
        let mut state = case.provider.state();
        state.selected = SIBLING.into();
        state.user = sibling();
    }
    let count = case.provider.state().calls.len();
    expect(&case.cli(&["auth", "renew"]), 0, "");
    assert_eq!(case.provider.paths(count), [USER_PATH]);
    assert_eq!(case.provider.state().switches, 0);
    assert_eq!(case.provider.state().selected, SIBLING);
    let after = case.saved();
    assert_eq!(after["account"], before["account"]);
    assert_eq!(after["students"], before["students"]);
}

/// The preflight refusal of every other command names the store's path; `auth renew`, whose
/// output reaches the system log, prints a fixed message instead and sends nothing.
#[test]
fn a_refused_store_prints_a_fixed_message_without_its_path() {
    let case = Case::new("unsafe-store", false);
    case.home.chmod(".config/inna-mcp/session.enc", 0o644);
    let count = case.provider.state().calls.len();
    let status = case.cli(&["auth", "status"]);
    assert_eq!(status.code, Some(1), "{status:?}");
    assert!(status.stderr.contains(&case.home.0.display().to_string()));
    let run = case.cli(&["auth", "renew"]);
    expect(&run, 1, REFUSED_STORE);
    clean(&case, &run);
    assert_eq!(case.provider.state().calls.len(), count);
}

/// An upstream that answers as `provider`, setting the SESSION cookie to `rotation`, and holds
/// its user request at `gate` first when one is given.
fn rotating(provider: &Provider, rotation: &'static str, gate: Option<Gate>) -> Upstream {
    let provider = provider.clone();
    Upstream::new(move |request: &Request| {
        if request.line() == format!("GET {USER_PATH}")
            && let Some(gate) = &gate
        {
            gate.hold();
        }
        provider.state().rotation = rotation.into();
        provider.answer(request)
    })
}

/// `auth renew` started against `upstream`, its output piped.
fn spawn_renew(case: &Case, upstream: &Upstream) -> Child {
    case.home
        .command(&upstream.origin, &case.env(), &["auth", "renew"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

/// Wait until process `pid` waits for the session lock, while `running` says it has not ended.
fn until_waiting(case: &Case, pid: u32, mut running: impl FnMut() -> bool) {
    let session = case.session();
    let deadline = std::time::Instant::now() + PATIENCE;

    while !waits_for_lock(&session, pid) {
        assert!(running(), "it ended before waiting for the lock");
        assert!(
            std::time::Instant::now() < deadline,
            "it never waited for the lock"
        );
        std::thread::yield_now();
    }
    // Still waiting: a lock taken at once also makes its temporary, briefly.
    assert!(running());
    assert!(waits_for_lock(&session, pid));
}

/// The finished renewal's exit code and output.
fn finish(mut child: Child) -> Run {
    let status = support::wait(&mut child, PATIENCE).expect("auth renew finished");
    let mut run = Run {
        code: status.code(),
        stdout: String::new(),
        stderr: String::new(),
    };
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut run.stdout)
        .unwrap();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut run.stderr)
        .unwrap();
    run
}

/// The cookie header of the one user request `upstream` saw.
fn sent_cookie(upstream: &Upstream) -> String {
    let seen = upstream.seen();
    assert_eq!(seen.len(), 1, "{seen:?}");
    seen[0].headers["cookie"].as_str().unwrap().to_owned()
}

/// Both processes rewrite the store after their request. With `serve`'s keep-alive tick holding
/// the session, `auth renew` waits for the lock, then reloads: it sends the cookies the tick
/// saved, and its own write comes last. Two whole writes, nothing lost, a usable record.
#[test]
fn a_renewal_beside_a_serve_tick_waits_for_it_and_keeps_its_cookies() {
    let case = Case::new("after-serve", false);
    let before = case.saved();
    let generation = case.home.generation().unwrap();
    let gate = Gate::default();
    let mut client = case.client_in(
        case.env(),
        Some(rotating(
            &case.provider,
            "synthetic-serve-tick",
            Some(gate.clone()),
        )),
    );
    client.mcp.signal("USR1");
    gate.reached();

    let upstream = rotating(&case.provider, "synthetic-renew-run", None);
    let mut renew = spawn_renew(&case, &upstream);
    let pid = renew.id();
    until_waiting(&case, pid, || renew.try_wait().unwrap().is_none());
    assert!(
        upstream.seen().is_empty(),
        "the renewal sent before the lock"
    );
    gate.release();

    assert!(client.mcp.until_stderr("keep-alive: kept", 1, PATIENCE));
    let run = finish(renew);
    expect(&run, 0, "");
    assert!(sent_cookie(&upstream).contains("SESSION=synthetic-serve-tick"));
    assert!(
        sent_cookie(client.upstream()).contains(&format!("SESSION={}", session_cookie(&before)))
    );
    let after = case.saved();
    assert_eq!(session_cookie(&after), "synthetic-renew-run");
    assert_eq!(without_jar(&after), without_jar(&before));
    assert_eq!(case.home.generation(), Some(generation + 2));

    // The record is whole: the server and a later run both use it.
    assert_eq!(client.keep_alive(), "kept");
    expect(&case.cli(&["auth", "renew"]), 0, "");
    let (code, stderr) = client.mcp.close();
    assert_eq!(code, Some(0));
    expect_clean(&stderr, "serve's stderr");
}

/// The reverse: with `auth renew` holding the session, `serve`'s tick waits for the lock, then
/// sends the cookies the renewal saved.
#[test]
fn a_serve_tick_beside_a_renewal_waits_for_it_and_keeps_its_cookies() {
    let case = Case::new("after-renew", false);
    let before = case.saved();
    let generation = case.home.generation().unwrap();
    let gate = Gate::default();
    let upstream = rotating(&case.provider, "synthetic-renew-held", Some(gate.clone()));
    let renew = spawn_renew(&case, &upstream);
    gate.reached();

    let client = case.client_in(
        case.env(),
        Some(rotating(&case.provider, "synthetic-serve-after", None)),
    );
    client.mcp.signal("USR1");
    let pid = client.mcp.id();
    until_waiting(&case, pid, || client.mcp.statuses().is_empty());
    assert!(
        client.upstream().seen().is_empty(),
        "the tick sent before the lock"
    );
    gate.release();

    let run = finish(renew);
    expect(&run, 0, "");
    assert!(client.mcp.until_stderr("keep-alive: kept", 1, PATIENCE));
    assert!(sent_cookie(&upstream).contains(&format!("SESSION={}", session_cookie(&before))));
    assert!(sent_cookie(client.upstream()).contains("SESSION=synthetic-renew-held"));
    let after = case.saved();
    assert_eq!(session_cookie(&after), "synthetic-serve-after");
    assert_eq!(without_jar(&after), without_jar(&before));
    assert_eq!(case.home.generation(), Some(generation + 2));
    expect(&case.cli(&["auth", "renew"]), 0, "");
    let (code, _) = client.mcp.close();
    assert_eq!(code, Some(0));
}
