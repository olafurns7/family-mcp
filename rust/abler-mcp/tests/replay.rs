//! The frozen TypeScript outcomes of every tests/ts/parity.ts scenario, replayed through this
//! binary step by step (fixtures/parity, PROVENANCE.md beside them). Each scenario runs in one
//! fresh home against a scripted fake Abler, which serves the recorded responses in order and
//! requires each request to equal the recorded one whole (method, path with its query, the four
//! headers parity.ts recorded, body). The binary may add no request: parity.ts compared the two
//! request lists whole, so a refresh, a retry or a read the TypeScript side did not send fails the
//! step it arrives in, and a request it did send but the binary skips fails the same way. Each CLI
//! run compares its exit code, stdout and stderr; each tool call its raw JSON-RPC answer, key order
//! included; each `serve` its exit code and stderr once its input closed; each scenario ends by
//! comparing the decrypted stored session, every path left with its mode, and the text of every
//! file but the store's encrypted record and key. Token rotation timing, a restart or kill
//! mid-write and lock takeover are not replayed: session.rs and persistence.rs execute them. No
//! output may hold a cookie value. Needs no Bun; needs the `test-origin` feature.
#![cfg(feature = "test-origin")]

mod support;

use std::fs;
use std::path::Path;

use serde_json::{Value, json};
use support::{Home, Mcp, Names, Script, cli, no_leak, unpack};

/// tests/ts/parity.ts's scenarios, one file each; its two loops (`refresh-${mode}`,
/// `graphql-${mode}`) one file per value.
const SCENARIOS: [&str; 36] = [
    "surface",
    "no-session",
    "tools",
    "inputs",
    "cli",
    "import-errors",
    "verification",
    "expired-import",
    "migrate",
    "migrate-candidate",
    "legacy-rotation",
    "session-file-env",
    "collision",
    "refresh-refresh401",
    "refresh-refresh403",
    "refresh-refresh500",
    "refresh-refreshNotJson",
    "refresh-refreshError",
    "refresh-refreshNoIdToken",
    "refresh-refreshRedirect",
    "refresh-badCookieDomain",
    "graphql-graphql401Once",
    "graphql-unauthenticatedOnce",
    "graphql-graphqlErrors",
    "graphql-errorsCodeNumber",
    "graphql-graphql500",
    "graphql-noData",
    "graphql-badJson",
    "graphql-bigBody",
    "graphql-badShape",
    "graphql-meNull",
    "graphql-stuckCursor",
    "graphql-incompleteCursor",
    "graphql-eventMissing",
    "graphql-eventMismatch",
    "graphql-protoChild",
];

/// The package version the freeze recorded, in `--version`'s and `-v`'s stdout and in
/// `initialize`'s `serverInfo.version`. A release changes the binary's, so the replay requires the
/// binary to print its own (`CARGO_PKG_VERSION`) in exactly those two fields, in the recorded
/// format, and compares them as the recorded one; every other field is compared as recorded
/// (lead, taskr 82600; the_version_is_named_only_in_the_two_recorded_fields checks it).
const FROZEN_VERSION: &str = "0.7.1";

/// A version command's stdout, which must be `version` and a newline, as the frozen one; any other
/// command's stdout as it is.
fn recorded_version_stdout(args: &[&str], stdout: &str, version: &str) -> String {
    match args {
        ["--version"] | ["-v"] => {
            assert_eq!(
                stdout,
                format!("{version}\n"),
                "{args:?}: the binary's version"
            );
            format!("{FROZEN_VERSION}\n")
        }
        _ => stdout.to_owned(),
    }
}

/// An `initialize` answer line, whose `serverInfo.version` must be `version`, with the frozen one
/// in its place; nothing else changes.
fn recorded_server_version(line: &str, version: &str) -> String {
    let mut answer: Value = serde_json::from_str(line).unwrap();
    let recorded = &mut answer["result"]["serverInfo"]["version"];
    assert_eq!(
        recorded,
        &json!(version),
        "initialize: the binary's version"
    );
    *recorded = json!(FROZEN_VERSION);
    answer.to_string()
}

fn frozen(set: &str, name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set)
        .join(format!("{name}.json"));
    unpack(serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap())
}

/// What the replay covered: CLI runs, tool results, those with structured content, and requests.
#[derive(Default, Debug, PartialEq)]
struct Coverage {
    cli: usize,
    tools: usize,
    structured: usize,
    requests: usize,
}

/// A JSON-RPC answer line without its envelope: `{result}` or `{error}`.
fn envelope(names: &Names, line: &str) -> Value {
    let message: Value = serde_json::from_str(&names.fresh(line)).unwrap();
    let mut answer = message.as_object().unwrap().clone();
    assert_eq!(answer.remove("jsonrpc"), Some(json!("2.0")));
    assert!(answer.remove("id").is_some());
    Value::Object(answer)
}

/// `ordered`: also compare key order, part of a tool answer's contract. `initialize` and
/// `tools/list` parity.ts read through the SDK client, which rebuilds them in its schemas' key
/// order, so there only the values were ever compared.
fn same_answer(names: &Names, got: &str, frozen: &Value, at: &str, ordered: bool) {
    let frozen_answer = envelope(names, frozen.as_str().unwrap());
    let got = envelope(names, got);
    assert_eq!(got, frozen_answer, "{at}");

    if ordered {
        assert_eq!(
            got.to_string(),
            frozen_answer.to_string(),
            "{at}: key order"
        );
    }
}

fn replay_case(set: &str, name: &str, coverage: &mut Coverage) {
    let case = frozen(set, name);
    assert_eq!(case["id"], format!("abler/{set}/{name}"));
    let home = Home::new(name);
    let names = Names::new(&home);
    let script = Script::new(names.clone());
    let upstream = script.upstream();
    let origin = upstream.origin.clone();
    let extra: Vec<(String, String)> = case
        .get("env")
        .and_then(Value::as_object)
        .map(|env| {
            env.iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
                .collect()
        })
        .unwrap_or_default();

    for (index, step) in case["steps"].as_array().unwrap().iter().enumerate() {
        let at = format!("{name} step {index}");

        if step.get("mode").is_some() {
            // The recorded exchanges carry what the fake answered in that mode.
        } else if let Some(args) = step["cli"].as_array() {
            coverage.cli += 1;
            let args: Vec<&str> = args.iter().map(|arg| arg.as_str().unwrap()).collect();
            script.expect(&step["exchanges"]);
            let stdin = step["stdin"].as_str().map(str::as_bytes);
            let run = cli(&home, &origin, &extra, &args, stdin);
            script.finish(&format!("{at} {args:?}"));
            no_leak(&format!("{}{}", run.stdout, run.stderr), &at);
            let stdout = recorded_version_stdout(&args, &run.stdout, env!("CARGO_PKG_VERSION"));
            assert_eq!(
                json!({"code": run.code, "stdout": names.fresh(&stdout), "stderr": names.fresh(&run.stderr)}),
                json!({"code": step["code"], "stdout": step["stdout"], "stderr": step["stderr"]}),
                "{at} {args:?}"
            );
        } else if step.get("serve").is_some() {
            let (mut mcp, initialized) = Mcp::start(&home, &origin, &extra);

            if let Some(expected) = step.get("initialize") {
                same_answer(
                    &names,
                    &recorded_server_version(&initialized.line, env!("CARGO_PKG_VERSION")),
                    expected,
                    &format!("{at} initialize"),
                    false,
                );
                let listed = mcp.request("tools/list", json!({}));
                same_answer(
                    &names,
                    &listed.line,
                    &step["list"],
                    &format!("{at} tools/list"),
                    false,
                );
            }
            for (number, result) in step["results"].as_array().unwrap().iter().enumerate() {
                let at = format!("{at} call {number} {}", result["call"][0]);
                one_call(&names, &script, &mut mcp, result, &at, coverage);
            }
            let (code, stderr) = mcp.close();
            no_leak(&stderr, &at);
            assert_eq!(
                json!({"code": code, "stderr": names.fresh(&stderr)}),
                json!({"code": step["code"], "stderr": step["stderr"]}),
                "{at} exit"
            );
        } else if let Some(file) = step["file"].as_str() {
            let mode = step
                .get("permissions")
                .and_then(Value::as_u64)
                .unwrap_or(0o600);
            home.write(file, step["text"].as_str().unwrap(), mode as u32);
        } else {
            panic!("{at}: unknown step {step}");
        }
    }
    let served = script.served();
    assert_eq!(
        served as u64,
        case["requests"].as_u64().unwrap(),
        "{name}: requests"
    );
    assert_eq!(upstream.count(), served, "{name}: requests sent");
    coverage.requests += served;
    assert_eq!(home.files(&names), case["files"], "{name}: files");
    assert_eq!(home.texts(&names), case["texts"], "{name}: file texts");
    let frozen_store = match (case.get("record"), case.get("error")) {
        (Some(record), _) => json!({ "record": record }),
        (None, Some(code)) => json!({ "error": code }),
        (None, None) => json!({ "store": case["store"] }),
    };
    assert_eq!(home.stored(&names), frozen_store, "{name}: store");
}

/// One recorded tool call on the open `serve`: its requests, notifications and answer.
fn one_call(
    names: &Names,
    script: &Script,
    mcp: &mut Mcp,
    result: &Value,
    at: &str,
    coverage: &mut Coverage,
) {
    let call = &result["call"];
    script.expect(&result["exchanges"]);
    let got = mcp.call(call[0].as_str().unwrap(), call[1].clone());
    script.finish(at);
    no_leak(&format!("{}{}", got.line, got.notifications.join("")), at);
    let notifications: Vec<Value> = got
        .notifications
        .iter()
        .map(|line| serde_json::from_str(&names.fresh(line)).unwrap())
        .collect();
    let frozen_notifications = result
        .get("notifications")
        .cloned()
        .unwrap_or_else(|| json!([]));
    assert_eq!(
        json!(notifications),
        frozen_notifications,
        "{at}: notifications"
    );
    same_answer(names, &got.line, &result["answer"], at, true);
    let answer: Value = serde_json::from_str(result["answer"].as_str().unwrap()).unwrap();

    if answer["result"].get("content").is_some() {
        coverage.tools += 1;
    }
    if answer["result"].get("structuredContent").is_some() {
        coverage.structured += 1;
    }
}

/// The `.json` files in `fixtures/<set>`, which must be exactly `names`.
fn fixtures_are(set: &str, names: &[&str]) {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures")
        .join(set);
    let mut files: Vec<String> = fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json"))
        .collect();
    files.sort();
    let mut expected: Vec<String> = names.iter().map(|name| format!("{name}.json")).collect();
    expected.sort();
    assert_eq!(files, expected);
}

fn replay(set: &str, names: &[&str]) -> Coverage {
    fixtures_are(set, names);
    let mut coverage = Coverage::default();

    for name in names {
        replay_case(set, name, &mut coverage);
    }
    coverage
}

#[test]
fn every_frozen_parity_scenario_replays() {
    let coverage = replay("parity", &SCENARIOS);
    // What the freeze recorded, so a fixture emptied by mistake fails here.
    assert_eq!(
        coverage,
        Coverage {
            cli: 83,
            tools: 159,
            structured: 58,
            requests: 226,
        }
    );
}

/// The version rule's own check: only a version command's stdout and `initialize`'s
/// `serverInfo.version` are named, a binary printing another version than its package's fails,
/// and the fixtures hold the frozen version in exactly those fields.
#[test]
fn the_version_is_named_only_in_the_two_recorded_fields() {
    let fails =
        |work: &dyn Fn()| std::panic::catch_unwind(std::panic::AssertUnwindSafe(work)).is_err();
    assert_eq!(
        recorded_version_stdout(&["--version"], "9.8.7\n", "9.8.7"),
        format!("{FROZEN_VERSION}\n")
    );
    assert_eq!(
        recorded_version_stdout(&["-v"], "9.8.7\n", "9.8.7"),
        format!("{FROZEN_VERSION}\n")
    );
    // Another command's output keeps a version it prints.
    assert_eq!(
        recorded_version_stdout(&["--help"], "9.8.7\n", "9.8.7"),
        "9.8.7\n"
    );
    assert_eq!(
        recorded_version_stdout(&["-hv"], "9.8.7\n", "9.8.7"),
        "9.8.7\n"
    );
    // A binary whose version is not its package's, or not in the recorded format, fails.
    assert!(fails(&|| {
        recorded_version_stdout(&["--version"], "9.8.6\n", "9.8.7");
    }));
    assert!(fails(&|| {
        recorded_version_stdout(&["-v"], "v9.8.7\n", "9.8.7");
    }));
    let line = r#"{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":"2025-11-25","serverInfo":{"name":"abler-mcp","version":"9.8.7"},"instructions":"9.8.7"}}"#;
    let named: Value = serde_json::from_str(&recorded_server_version(line, "9.8.7")).unwrap();
    let mut expected: Value = serde_json::from_str(line).unwrap();
    expected["result"]["serverInfo"]["version"] = json!(FROZEN_VERSION);
    assert_eq!(named, expected);
    assert!(fails(&|| {
        recorded_server_version(line, "9.8.6");
    }));

    // The frozen version appears in the fixtures only where the rule names it.
    let mut places = Vec::new();

    for name in SCENARIOS {
        let text = fs::read_to_string(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/parity")
                .join(format!("{name}.json")),
        )
        .unwrap();

        for line in text.lines().filter(|line| line.contains(FROZEN_VERSION)) {
            places.push(format!(
                "{name}: {}",
                &line[..line.find(FROZEN_VERSION).unwrap()]
            ));
        }
    }
    assert_eq!(
        places,
        [
            r#"surface: {"serve":true,"initialize":"{\"result\":{\"protocolVersion\":\"2025-11-25\",\"capabilities\":{\"tools\":{\"listChanged\":true}},\"serverInfo\":{\"name\":\"abler-mcp\",\"version\":\""#,
            r#"cli: {"cli":["--version"],"code":0,"stdout":""#,
            r#"cli: {"cli":["-v"],"code":0,"stdout":""#,
        ]
    );
}
