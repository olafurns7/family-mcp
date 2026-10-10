//! packages/infomentor-mcp/src/collection.ts: one scan of every child's timetable, messages and
//! notifications, compared with the snapshot a cursor names. Snapshots hold fingerprints only:
//! hashes of the parsed items, never school text. The format and hashes are the TypeScript
//! server's, so a cursor works across both builds.

use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use family_store::{Cancel, ensure_private_dir, read_private_file, write_private_file};
use serde_json::{Map, Value, json};

use crate::error::{Code, Fail, Result};
use crate::http::Parent;
use crate::input::CollectRequest;
use crate::js;
use crate::session::PARENT_URL;
use crate::shapes::{self, Feed, MessagesPage};
use crate::signal::Signal;

const MAX_BYTES: usize = 8 * 1024 * 1024;

const RETENTION: Duration = Duration::from_secs(90 * 24 * 60 * 60);

/// `DEFAULT_SWEEP_AGE_MS`: temporaries younger than this may belong to a running write.
const TEMPORARY_AGE: Duration = Duration::from_secs(300);

const RESTORE_TIMEOUT: Duration = Duration::from_secs(20);

const FOLDERS: [&str; 2] = ["inbox", "sent"];

const CHANGED_SELECTION: Fail = Fail::new(
    Code::UnexpectedPage,
    "The InfoMentor account or selected child changed during collection. No cursor was advanced. Check the overview and retry.",
);

const CURSOR_ERROR: Fail = Fail::config(
    "The collection cursor is unavailable, expired, invalid, or belongs to another account. Omit it to establish a new baseline.",
);

const TOO_LARGE: Fail = Fail::new(
    Code::UnexpectedPage,
    "The collection exceeds the supported response size. No cursor was advanced.",
);

/// What a collection reads, so the scan can be tested without InfoMentor.
pub trait Source {
    fn get_parent(&mut self, signal: &Signal) -> Result<Parent>;

    fn select_child(&mut self, child_id: &str, signal: &Signal) -> Result<Parent>;

    /// `None` when the account has no timetable app.
    fn read_timetable(&mut self, parent: &Parent, signal: &Signal) -> Result<Option<Feed>>;

    fn get_messages(&mut self, folder: &str, page: i64, signal: &Signal) -> Result<MessagesPage>;

    /// A message, as `messageDetailSchema` parses it.
    fn get_message(&mut self, id: i64, signal: &Signal) -> Result<Value>;

    fn get_notifications(&mut self, signal: &Signal) -> Result<Feed>;
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    Child,
    Timetable,
    Message,
    Notification,
}

impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Child => "child",
            Kind::Timetable => "timetable",
            Kind::Message => "message",
            Kind::Notification => "notification",
        }
    }

    fn parse(name: &str) -> Option<Self> {
        [
            Kind::Child,
            Kind::Timetable,
            Kind::Message,
            Kind::Notification,
        ]
        .into_iter()
        .find(|kind| kind.name() == name)
    }

    /// `feedForKind`: the feed whose skipped items make this kind incomplete.
    fn feed(self) -> Option<usize> {
        match self {
            Kind::Child => None,
            Kind::Timetable => Some(0),
            Kind::Message => Some(1),
            Kind::Notification => Some(2),
        }
    }
}

fn folder(name: &str) -> Option<&'static str> {
    FOLDERS.into_iter().find(|folder| *folder == name)
}

/// A stored item: where it was seen and a hash of its parsed data.
#[derive(Debug, Clone)]
struct Fingerprint {
    kind: Kind,
    source_id: String,
    folder: Option<&'static str>,
    child_id: String,
    hash: String,
    /// Read from a snapshot, so written back in `fingerprintSchema` order; a new fingerprint
    /// keeps the order the TypeScript object literal gave it.
    stored: bool,
}

impl Fingerprint {
    fn reference_key(&self) -> String {
        reference_key(self.kind, &self.source_id, self.folder)
    }

    fn key(&self) -> String {
        json!([self.reference_key(), self.child_id]).to_string()
    }

    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("kind".to_owned(), json!(self.kind.name()));
        object.insert("sourceId".to_owned(), json!(self.source_id));

        if self.stored
            && let Some(folder) = self.folder
        {
            object.insert("folder".to_owned(), json!(folder));
        }
        object.insert("childId".to_owned(), json!(self.child_id));
        object.insert("hash".to_owned(), json!(self.hash));

        if !self.stored
            && let Some(folder) = self.folder
        {
            object.insert("folder".to_owned(), json!(folder));
        }
        Value::Object(object)
    }

    /// `fingerprintSchema`.
    fn parse(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let folder = match object.get("folder") {
            None => None,
            Some(name) => Some(folder(name.as_str()?)?),
        };
        Some(Self {
            kind: Kind::parse(object.get("kind")?.as_str()?)?,
            source_id: object.get("sourceId")?.as_str()?.to_owned(),
            folder,
            child_id: object.get("childId")?.as_str()?.to_owned(),
            hash: object
                .get("hash")
                .and_then(Value::as_str)
                .filter(|hash| is_hash(hash))?
                .to_owned(),
            stored: true,
        })
    }
}

/// `/^[a-f0-9]{64}$/`.
fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

fn reference_key(kind: Kind, source_id: &str, folder: Option<&str>) -> String {
    json!([kind.name(), source_id, folder]).to_string()
}

/// A JavaScript `Map`: insertion order, and `set` on an existing key keeps its place.
struct Ordered<T> {
    entries: Vec<(String, T)>,
    index: HashMap<String, usize>,
}

impl<T> Default for Ordered<T> {
    fn default() -> Self {
        Self {
            entries: Vec::new(),
            index: HashMap::new(),
        }
    }
}

impl<T> Ordered<T> {
    fn get(&self, key: &str) -> Option<&T> {
        self.index.get(key).map(|at| &self.entries[*at].1)
    }

    fn get_mut(&mut self, key: &str) -> Option<&mut T> {
        self.index.get(key).map(|at| &mut self.entries[*at].1)
    }

    fn set(&mut self, key: String, value: T) {
        match self.index.get(&key) {
            Some(at) => self.entries[*at].1 = value,
            None => {
                self.index.insert(key.clone(), self.entries.len());
                self.entries.push((key, value));
            }
        }
    }

    fn len(&self) -> usize {
        self.entries.len()
    }

    fn values(&self) -> impl Iterator<Item = &T> {
        self.entries.iter().map(|(_, value)| value)
    }
}

/// One update; serialized in `collectionSchema`'s order.
struct Update {
    kind: Kind,
    source_id: String,
    folder: Option<&'static str>,
    child_ids: Vec<String>,
    data: Value,
}

impl Update {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("sourceId".to_owned(), json!(self.source_id));

        if let Some(folder) = self.folder {
            object.insert("folder".to_owned(), json!(folder));
        }
        object.insert("childIds".to_owned(), json!(self.child_ids));
        object.insert("kind".to_owned(), json!(self.kind.name()));
        object.insert("data".to_owned(), self.data.clone());
        Value::Object(object)
    }
}

/// `checkedParent`: the parent, unless two children share an id.
fn checked(parent: Parent) -> Result<Parent> {
    let mut ids: Vec<&str> = parent
        .pupils
        .iter()
        .map(|pupil| pupil.id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();

    match ids.len() == parent.pupils.len() {
        true => Ok(parent),
        false => Err(CHANGED_SELECTION),
    }
}

fn account_hash(parent: &Parent) -> String {
    js::sha256_hex(&json!([PARENT_URL, parent.account_id]).to_string())
}

fn child_list(parent: &Parent) -> String {
    let mut children: Vec<_> = parent
        .pupils
        .iter()
        .map(|pupil| (pupil.id.as_str(), pupil.name.as_str()))
        .collect();
    children.sort_by(|a, b| js::locale_compare(a.0, b.0));
    Value::Array(
        children
            .into_iter()
            .map(|(id, name)| json!({"id": id, "name": name}))
            .collect(),
    )
    .to_string()
}

fn selected_child(parent: &Parent) -> Result<Option<String>> {
    let selected: Vec<_> = parent
        .pupils
        .iter()
        .filter(|pupil| pupil.selected)
        .collect();

    if !parent.pupils.is_empty() && selected.len() != 1 {
        return Err(CHANGED_SELECTION);
    }
    Ok(selected.first().map(|pupil| pupil.id.clone()))
}

fn confirm(parent: &Parent, initial: &Parent, child_id: Option<&str>) -> Result<()> {
    if account_hash(parent) != account_hash(initial) || child_list(parent) != child_list(initial) {
        return Err(CHANGED_SELECTION);
    }

    if let Some(child_id) = child_id
        && selected_child(parent)?.as_deref() != Some(child_id)
    {
        return Err(CHANGED_SELECTION);
    }
    Ok(())
}

/// Milliseconds since `time`, as `Date.now() - mtimeMs`; negative for a future time.
fn age(time: SystemTime) -> f64 {
    match SystemTime::now().duration_since(time) {
        Ok(elapsed) => elapsed.as_secs_f64() * 1000.0,
        Err(ahead) => -ahead.duration().as_secs_f64() * 1000.0,
    }
}

fn expired(time: SystemTime, after: Duration) -> bool {
    age(time) > after.as_secs_f64() * 1000.0
}

fn snapshot_path(directory: &Path, cursor: &str) -> PathBuf {
    directory.join(format!("{cursor}.json"))
}

/// `readSnapshot`: the cursor's fingerprints; any failure is a cursor error.
fn read_snapshot(directory: &Path, cursor: &str, owner: &str) -> Result<Vec<Fingerprint>> {
    let path = snapshot_path(directory, cursor);
    let read = || -> Option<Vec<Fingerprint>> {
        let info = fs::metadata(&path).ok()?;

        if !info.is_file()
            || info.len() > MAX_BYTES as u64
            || expired(info.modified().ok()?, RETENTION)
        {
            return None;
        }
        let snapshot = js::parse(&read_private_file(&path, MAX_BYTES).ok()?)?;
        let snapshot = snapshot.as_object()?;
        (snapshot.get("version")?.as_f64()? == 1.0).then_some(())?;
        let account = snapshot
            .get("accountHash")?
            .as_str()
            .filter(|hash| is_hash(hash))?;
        let fingerprints = snapshot
            .get("fingerprints")?
            .as_array()?
            .iter()
            .map(Fingerprint::parse)
            .collect::<Option<Vec<_>>>()?;

        if account != owner {
            return None;
        }
        let mut keys: Vec<String> = fingerprints.iter().map(Fingerprint::key).collect();
        keys.sort_unstable();
        keys.dedup();
        (keys.len() == fingerprints.len()).then_some(fingerprints)
    };
    read().ok_or(CURSOR_ERROR)
}

fn save_snapshot(directory: &Path, cursor: &str, snapshot: &Value, cancel: &Cancel) -> Result<()> {
    let contents = snapshot.to_string();

    if contents.len() > MAX_BYTES {
        return Err(Fail::new(
            Code::UnexpectedPage,
            "The collection snapshot exceeds the supported size. No cursor was advanced.",
        ));
    }
    let failed = |_| Fail::Unknown;
    ensure_private_dir(directory, true).map_err(failed)?;
    write_private_file(
        &snapshot_path(directory, cursor),
        contents.as_bytes(),
        cancel,
    )
    .map_err(failed)
}

/// `utimes(path, new Date(), new Date())`.
fn touch(path: &Path) -> Result<()> {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| Fail::Unknown)?;
    // `new Date()` has millisecond precision.
    let millis = now.as_millis();
    let time = rustix::fs::Timespec {
        tv_sec: (millis / 1000) as i64,
        tv_nsec: ((millis % 1000) * 1_000_000) as _,
    };
    let times = rustix::fs::Timestamps {
        last_access: time,
        last_modification: time,
    };
    rustix::fs::utimensat(rustix::fs::CWD, path, &times, rustix::fs::AtFlags::empty())
        .map_err(|_| Fail::Unknown)
}

/// `/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/`.
fn is_lower_uuid(text: &str) -> bool {
    text.len() == 36
        && text.bytes().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => matches!(byte, b'0'..=b'9' | b'a'..=b'f'),
        })
}

/// `pruneSnapshots`, best effort: old orphaned temporaries (`ANY_TEMPORARY`), then snapshots
/// unused for the retention period.
fn prune_snapshots(directory: &Path) -> Option<()> {
    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        // `.\.<uuid>\.tmp$`: at least one character before the dot.
        let temporary = name.strip_suffix(".tmp").is_some_and(|rest| {
            let Some(head) = rest.len().checked_sub(36).and_then(|at| rest.get(..at)) else {
                return false;
            };
            let mut before = head.chars().rev();
            is_lower_uuid(&rest[head.len()..])
                && before.next() == Some('.')
                // `.` matches any character but a line terminator.
                && before
                    .next()
                    .is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
        });

        if !temporary {
            continue;
        }
        let info = match fs::symlink_metadata(entry.path()) {
            Ok(info) => info,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return None,
        };

        if !info.is_file()
            || !info
                .modified()
                .is_ok_and(|time| age(time) >= TEMPORARY_AGE.as_secs_f64() * 1000.0)
        {
            continue;
        }

        match fs::remove_file(entry.path()) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return None,
        }
    }

    for entry in fs::read_dir(directory).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name();
        let snapshot = name.to_str().is_some_and(|name| {
            name.strip_suffix(".json").is_some_and(|stem| {
                stem.len() == 36
                    && stem
                        .bytes()
                        .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f' | b'-'))
            })
        });

        if !snapshot {
            continue;
        }

        // Retention is best effort; another collection may have removed an expired snapshot.
        if let Ok(info) = fs::metadata(entry.path())
            && info.is_file()
            && info.modified().is_ok_and(|time| expired(time, RETENTION))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    Some(())
}

/// The scan's running state: what was seen, what changed and what was skipped.
struct Scan<'a> {
    signal: &'a Signal,
    previous: Option<Ordered<Fingerprint>>,
    include_existing: bool,
    current: Ordered<Fingerprint>,
    updates: Ordered<Update>,
    output_bytes: usize,
    skipped: [usize; 3],
}

impl Scan<'_> {
    fn add(&mut self, mut update: Update, child_id: &str) -> Result<()> {
        self.signal.check()?;
        let payload = update.data.to_string();
        let fingerprint = Fingerprint {
            kind: update.kind,
            source_id: update.source_id.clone(),
            folder: update.folder,
            child_id: child_id.to_owned(),
            hash: js::sha256_hex(&payload),
            stored: false,
        };
        let key = fingerprint.key();

        if self
            .current
            .get(&key)
            .is_some_and(|existing| existing.hash != fingerprint.hash)
        {
            return Err(Fail::new(
                Code::UnexpectedPage,
                "InfoMentor returned conflicting collection data. No cursor was advanced.",
            ));
        }
        let hash = fingerprint.hash.clone();
        let reference = fingerprint.reference_key();
        self.current.set(key.clone(), fingerprint);
        let known = match &self.previous {
            None => !self.include_existing,
            Some(previous) => previous.get(&key).is_some_and(|item| item.hash == hash),
        };

        if known {
            return Ok(());
        }
        let group = json!([reference, hash]).to_string();

        match self.updates.get_mut(&group) {
            Some(grouped) => {
                if !grouped.child_ids.iter().any(|id| id == child_id) {
                    grouped.child_ids.push(child_id.to_owned());
                }
            }
            None => {
                update.child_ids = vec![child_id.to_owned()];
                self.updates.set(group, update);
                self.output_bytes += payload.len();

                if self.output_bytes > MAX_BYTES {
                    return Err(TOO_LARGE);
                }
            }
        }
        Ok(())
    }

    fn folder_messages(
        &mut self,
        source: &mut impl Source,
        child_id: &str,
        folder: &'static str,
        max_pages: i64,
    ) -> Result<usize> {
        let mut seen = Vec::new();
        let mut skipped = 0;

        for page in 1..=max_pages {
            let messages = source.get_messages(folder, page, self.signal)?;
            skipped += messages.skipped;

            for summary in &messages.items {
                let id = summary["id"].as_i64().ok_or(Fail::Invalid)?;

                if seen.contains(&id) {
                    return Err(Fail::new(
                        Code::UnexpectedPage,
                        "InfoMentor message pages overlap or changed during collection. No cursor was advanced.",
                    ));
                }
                seen.push(id);
                let detail = source.get_message(id, self.signal)?;
                let detail = shapes::message_detail(&detail).ok_or(Fail::Invalid)?;
                let detail_id = detail["id"].as_i64().ok_or(Fail::Invalid)?;

                if detail_id != id {
                    return Err(Fail::new(
                        Code::UnexpectedPage,
                        "InfoMentor returned a different message than requested. No cursor was advanced.",
                    ));
                }
                self.add(
                    Update {
                        kind: Kind::Message,
                        source_id: detail_id.to_string(),
                        folder: Some(folder),
                        child_ids: Vec::new(),
                        data: detail,
                    },
                    child_id,
                )?;
            }

            if !messages.more {
                return Ok(skipped);
            }

            if (messages.items.is_empty() && messages.skipped == 0) || page == max_pages {
                return Err(Fail::new(
                    Code::UnexpectedPage,
                    "The complete message history could not be collected within maxMessagePages. Increase the limit and retry; no cursor was advanced.",
                ));
            }
        }
        Ok(skipped)
    }

    fn children(
        &mut self,
        source: &mut impl Source,
        initial: &Parent,
        max_pages: i64,
    ) -> Result<()> {
        let signal = self.signal;

        for child in &initial.pupils {
            let mut parent = checked(source.get_parent(signal)?)?;
            confirm(&parent, initial, None)?;

            if selected_child(&parent)?.as_deref() != Some(child.id.as_str()) {
                parent = checked(source.select_child(&child.id, signal)?)?;
            }
            confirm(&parent, initial, Some(&child.id))?;
            self.add(
                Update {
                    kind: Kind::Child,
                    source_id: child.id.clone(),
                    folder: None,
                    child_ids: Vec::new(),
                    data: json!({"id": child.id, "name": child.name}),
                },
                &child.id,
            )?;

            let timetable = source.read_timetable(&parent, signal)?;
            self.skipped[0] += timetable.as_ref().map_or(0, |feed| feed.skipped);
            let sorted = timetable.map(|feed| {
                let mut items: Vec<(String, Value)> = feed
                    .items
                    .into_iter()
                    .map(|item| (item.to_string(), item))
                    .collect();
                items.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
                Value::Array(items.into_iter().map(|(_, item)| item).collect())
            });
            self.add(
                Update {
                    kind: Kind::Timetable,
                    source_id: "timetable".to_owned(),
                    folder: None,
                    child_ids: Vec::new(),
                    data: sorted.unwrap_or(Value::Null),
                },
                &child.id,
            )?;

            for folder in FOLDERS {
                self.skipped[1] += self.folder_messages(source, &child.id, folder, max_pages)?;
            }

            let notifications = source.get_notifications(signal)?;
            self.skipped[2] += notifications.skipped;

            for item in &notifications.items {
                self.add(
                    Update {
                        kind: Kind::Notification,
                        source_id: json!([item["pupilSourceId"], item["id"]]).to_string(),
                        folder: None,
                        child_ids: Vec::new(),
                        data: shapes::parse(&shapes::COLLECTED_NOTIFICATION, item)
                            .ok_or(Fail::Invalid)?,
                    },
                    &child.id,
                )?;
            }
            confirm(
                &checked(source.get_parent(signal)?)?,
                initial,
                Some(&child.id),
            )?;
        }
        confirm(&checked(source.get_parent(signal)?)?, initial, None)
    }
}

/// Select `original` again, with a fresh deadline, and confirm it.
fn restore(source: &mut impl Source, owner: &str, original: &str) -> Result<()> {
    let signal = Signal::timeout(RESTORE_TIMEOUT);
    let mut parent = checked(source.get_parent(&signal)?)?;

    if account_hash(&parent) != owner || !parent.pupils.iter().any(|child| child.id == original) {
        return Err(CHANGED_SELECTION);
    }

    if selected_child(&parent)?.as_deref() != Some(original) {
        parent = checked(source.select_child(original, &signal)?)?;
    }

    if account_hash(&parent) != owner || selected_child(&parent)?.as_deref() != Some(original) {
        return Err(CHANGED_SELECTION);
    }
    parent = checked(source.get_parent(&signal)?)?;

    if account_hash(&parent) != owner || selected_child(&parent)?.as_deref() != Some(original) {
        return Err(CHANGED_SELECTION);
    }
    Ok(())
}

/// The cursor directory beside the session file.
pub fn collections_directory(session_file: &Path) -> PathBuf {
    let mut name = OsString::from(session_file);
    name.push(".collections");
    name.into()
}

/// `collectUpdates`. The caller holds the account lock for the whole operation; `cancel` is
/// `signal` as the store's cancel flag.
pub fn collect_updates(
    input: &CollectRequest,
    session_file: &Path,
    signal: &Signal,
    cancel: &Cancel,
    source: &mut impl Source,
) -> Result<Value> {
    let directory = collections_directory(session_file);
    signal.check()?;
    let initial = checked(source.get_parent(signal)?)?;
    let original = selected_child(&initial)?;
    let owner = account_hash(&initial);
    let previous = match &input.cursor {
        Some(cursor) => {
            let mut items = Ordered::default();

            for item in read_snapshot(&directory, cursor, &owner)? {
                items.set(item.key(), item);
            }
            Some(items)
        }
        None => None,
    };
    let mut scan = Scan {
        signal,
        previous,
        include_existing: input.include_existing,
        current: Ordered::default(),
        updates: Ordered::default(),
        output_bytes: 0,
        skipped: [0; 3],
    };
    let mut failure = scan
        .children(source, &initial, input.max_message_pages)
        .err()
        .map(|fail| match fail {
            Fail::Im { .. } => fail,
            Fail::Invalid | Fail::Unknown => Fail::new(
                Code::UnexpectedPage,
                "InfoMentor returned unsupported collection data. No cursor was advanced.",
            ),
        });

    if let Some(original) = &original
        && let Err(restored) = restore(source, &owner, original)
    {
        failure = Some(Fail::Im {
            code: failure
                .and_then(Fail::code)
                .or(restored.code())
                .unwrap_or(Code::UnexpectedPage),
            message: "InfoMentor could not confirm restoration of the original child. No cursor was advanced. Check the overview before continuing.",
            retry_after_ms: failure
                .and_then(Fail::retry_after_ms)
                .or(restored.retry_after_ms()),
        });
    }

    if let Some(failure) = failure {
        return Err(failure);
    }
    signal.check()?;

    let incomplete = |kind: Kind| kind.feed().is_some_and(|feed| scan.skipped[feed] > 0);
    let updates: Vec<Value> = scan
        .updates
        .values()
        .filter(|update| !incomplete(update.kind))
        .map(Update::to_json)
        .collect();
    let empty = Ordered::default();
    let previous_items = scan.previous.as_ref().unwrap_or(&empty);
    let mut next = Ordered::default();

    for (key, item) in &scan.current.entries {
        if !incomplete(item.kind) {
            next.set(key.clone(), item.clone());
        }
    }

    for (key, item) in &previous_items.entries {
        if incomplete(item.kind) {
            next.set(key.clone(), item.clone());
        }
    }
    let mut missing: Ordered<(Fingerprint, Vec<String>)> = Ordered::default();

    for (key, item) in &previous_items.entries {
        if incomplete(item.kind) || scan.current.get(key).is_some() {
            continue;
        }
        let group = item.reference_key();

        match missing.get_mut(&group) {
            Some((_, children)) => children.push(item.child_id.clone()),
            None => missing.set(group, (item.clone(), vec![item.child_id.clone()])),
        }
    }
    let missing: Vec<Value> = missing
        .values()
        .map(|(item, children)| {
            let mut reference = Map::new();
            reference.insert("kind".to_owned(), json!(item.kind.name()));
            reference.insert("sourceId".to_owned(), json!(item.source_id));

            if let Some(folder) = item.folder {
                reference.insert("folder".to_owned(), json!(folder));
            }
            reference.insert("childIds".to_owned(), json!(children));
            Value::Object(reference)
        })
        .collect();
    let unchanged = scan.previous.is_some()
        && next.len() == previous_items.len()
        && next.entries.iter().all(|(key, item)| {
            previous_items
                .get(key)
                .is_some_and(|previous| previous.hash == item.hash)
        });
    let cursor = match (&input.cursor, unchanged) {
        (Some(cursor), true) => cursor.clone(),
        _ => js::uuid().ok_or(Fail::Unknown)?,
    };
    let output = json!({
        "baseline": scan.previous.is_none(),
        "cursor": cursor,
        "retrievedAt": js::iso_string(js::now_ms()),
        "skipped": scan.skipped.iter().sum::<usize>(),
        "skippedByFeed": {
            "timetable": scan.skipped[0],
            "messages": scan.skipped[1],
            "notifications": scan.skipped[2],
        },
        "children": initial
            .pupils
            .iter()
            .map(|child| json!({"id": child.id, "name": child.name}))
            .collect::<Vec<_>>(),
        "updates": updates,
        "missing": missing,
    });

    if output.to_string().len() > MAX_BYTES {
        return Err(TOO_LARGE);
    }
    let saved = (|| -> Result<()> {
        if !unchanged {
            let snapshot = json!({
                "version": 1,
                "accountHash": owner,
                "fingerprints": next.values().map(Fingerprint::to_json).collect::<Vec<_>>(),
            });
            save_snapshot(&directory, &cursor, &snapshot, cancel)?;
        }

        if let Some(cursor) = &input.cursor {
            touch(&snapshot_path(&directory, cursor))?;
        }
        Ok(())
    })();

    if let Err(fail) = saved {
        signal.check()?;

        return Err(match fail {
            Fail::Im { .. } => fail,
            Fail::Invalid | Fail::Unknown => Fail::config(
                "Cannot save the collection cursor. Check the session directory permissions.",
            ),
        });
    }
    prune_snapshots(&directory);
    Ok(output)
}

#[cfg(test)]
mod tests {
    //! packages/infomentor-mcp/test/collection.test.ts against a fake source. Its invalid-request
    //! case is not ported: input.rs validates the request before a collection can start.

    use std::os::unix::fs::PermissionsExt;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;
    use crate::http::Pupil;
    use crate::signal::Controller;

    const MAX_PAGES: i64 = 20;

    fn summary(id: i64) -> Value {
        json!({
            "id": id,
            "messageContextType": "General",
            "sentUser": {"id": 2, "displayName": "Synthetic teacher"},
            "isNew": true,
            "messageSubject": "Synthetic subject",
            "timeSent": "2026-09-11T08:00:00",
        })
    }

    #[derive(Default, Clone, Copy)]
    struct Skipped {
        timetable: usize,
        messages: usize,
        notifications: usize,
    }

    struct Fake {
        selected: String,
        account: String,
        body: String,
        children: Vec<(String, String)>,
        removed: bool,
        drift: bool,
        restore_fails: bool,
        expires: bool,
        expired: bool,
        abort: Controller,
        cancel: bool,
        duplicate_notice_id: bool,
        rename_during_scan: bool,
        detail_reads: usize,
        skipped: Skipped,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                selected: "first".to_owned(),
                account: "parent".to_owned(),
                body: "Private message body".to_owned(),
                children: vec![
                    ("first".to_owned(), "Synthetic first child".to_owned()),
                    ("second".to_owned(), "Synthetic second child".to_owned()),
                ],
                removed: false,
                drift: false,
                restore_fails: false,
                expires: false,
                expired: false,
                abort: Controller::default(),
                cancel: false,
                duplicate_notice_id: false,
                rename_during_scan: false,
                detail_reads: 0,
                skipped: Skipped::default(),
            }
        }
    }

    impl Source for Fake {
        fn get_parent(&mut self, signal: &Signal) -> Result<Parent> {
            signal.check()?;

            if self.expired {
                return Err(Fail::new(Code::LoginRequired, "Sign in again."));
            }
            Ok(Parent {
                account_id: self.account.clone(),
                pupils: self
                    .children
                    .iter()
                    .map(|(id, name)| Pupil {
                        id: id.clone(),
                        name: name.clone(),
                        selected: *id == self.selected,
                        switch_url: None,
                    })
                    .collect(),
                apps: vec!["timetable".to_owned()],
            })
        }

        fn select_child(&mut self, child_id: &str, signal: &Signal) -> Result<Parent> {
            signal.check()?;

            if self.restore_fails && child_id == "first" {
                return Err(Fail::new(
                    Code::NetworkError,
                    "Synthetic restoration failure.",
                ));
            }
            self.selected = child_id.to_owned();
            self.get_parent(signal)
        }

        fn read_timetable(&mut self, parent: &Parent, signal: &Signal) -> Result<Option<Feed>> {
            signal.check()?;
            let selected = parent.pupils.iter().find(|child| child.selected);
            let skipped = match selected.is_some_and(|child| child.id == "first") {
                true => self.skipped.timetable,
                false => 0,
            };
            let items = match skipped {
                0 => vec![json!({
                    "start": "2026-09-11T09:00:00",
                    "end": "2026-09-11T10:00:00",
                    "title": "Synthetic timetable",
                    "startTime": "09:00",
                    "endTime": "10:00",
                    "notes": {"roomInfo": "", "timetableNotes": "", "tutors": ""},
                    "allDay": false,
                    "establishmentName": "Synthetic school",
                })],
                _ => Vec::new(),
            };
            Ok(Some(Feed { items, skipped }))
        }

        fn get_messages(
            &mut self,
            folder: &str,
            page: i64,
            signal: &Signal,
        ) -> Result<MessagesPage> {
            signal.check()?;

            if self.expires {
                self.expired = true;
                return Err(Fail::new(Code::LoginRequired, "Sign in again."));
            }
            let id = match (folder, page) {
                ("sent", _) => 21,
                (_, 1) => 11,
                _ => 12,
            };
            let skipped = match self.selected == "first" && folder == "inbox" && page == 1 {
                true => self.skipped.messages,
                false => 0,
            };
            Ok(MessagesPage {
                items: match (self.removed && id == 12) || skipped > 0 {
                    true => Vec::new(),
                    false => vec![summary(id)],
                },
                skipped,
                more: folder == "inbox" && page == 1,
            })
        }

        fn get_message(&mut self, id: i64, signal: &Signal) -> Result<Value> {
            signal.check()?;
            self.detail_reads += 1;
            let mut detail = summary(id);
            let object = detail.as_object_mut().ok_or(Fail::Invalid)?;
            object.insert(
                "messageBodyPlainText".to_owned(),
                json!(match id {
                    11 => self.body.as_str(),
                    _ => "Other private body",
                }),
            );
            object.insert(
                "toUsers".to_owned(),
                json!([{"id": 3, "displayName": "Synthetic guardian"}]),
            );
            object.insert(
                "messageFolder".to_owned(),
                json!(if id == 21 { "Sent" } else { "Inbox" }),
            );
            Ok(detail)
        }

        fn get_notifications(&mut self, signal: &Signal) -> Result<Feed> {
            signal.check()?;

            if self.drift {
                self.selected = "second".to_owned();
            }

            if self.cancel && self.selected == "second" {
                self.abort.abort();
            }

            if self.rename_during_scan && self.selected == "second" {
                self.children[0].1 = "Updated child name".to_owned();
            }
            let notice = json!({
                "id": 1,
                "title": "Synthetic notice",
                "subTitle": "",
                "subjectsCourses": "",
                "dateSent": "2026-09-11",
                "appType": "Message",
                "state": "Cleared",
                "type": "MessageCreated",
                "url": "/#/message/show/11",
                "pupilIM2Id": 1,
                "pupilSourceId": "first",
                "currentlySelectedPupil": self.selected == "first",
            });
            let mut notices = vec![notice.clone()];

            if self.duplicate_notice_id {
                let mut duplicate = notice;
                duplicate["pupilSourceId"] = json!("second");
                notices.push(duplicate);
            }
            let skipped = match self.selected == "first" {
                true => self.skipped.notifications,
                false => 0,
            };
            Ok(Feed {
                items: if skipped > 0 { Vec::new() } else { notices },
                skipped,
            })
        }
    }

    /// A private scratch directory, removed on drop.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let path = std::env::temp_dir().join(format!(
                "infomentor-collection-{name}-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }

        fn session(&self, name: &str) -> PathBuf {
            self.0.join(name)
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn request(cursor: Option<&str>, include_existing: bool, pages: i64) -> CollectRequest {
        CollectRequest {
            cursor: cursor.map(str::to_owned),
            include_existing,
            max_message_pages: pages,
        }
    }

    fn collect(fake: &mut Fake, file: &Path, input: CollectRequest) -> Result<Value> {
        collect_updates(&input, file, &Signal::default(), &Cancel::default(), fake)
    }

    fn message(fail: Fail) -> &'static str {
        match fail {
            Fail::Im { message, .. } => message,
            _ => "",
        }
    }

    fn cursor(collection: &Value) -> String {
        collection["cursor"].as_str().unwrap().to_owned()
    }

    fn no_snapshots(file: &Path) -> bool {
        !collections_directory(file).exists()
    }

    #[test]
    fn snapshots_replay_deltas_preserve_context_and_fail_without_advancing() {
        let scratch = Scratch::new("normal");

        // Baseline, identical grouping, full body edits, replay, and missing references.
        let file = scratch.session("normal.json");
        let mut fake = Fake::new();
        let baseline = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap();
        assert_eq!(baseline["baseline"], true);
        assert_eq!(baseline["updates"], json!([]));
        assert_eq!(fake.detail_reads, 6);
        assert_eq!(fake.selected, "first");
        let directory = collections_directory(&file);
        let snapshot = snapshot_path(&directory, &cursor(&baseline));
        let stored = fs::read_to_string(&snapshot).unwrap();

        for private in [
            "Private message",
            "Synthetic first",
            "Synthetic timetable",
            "Synthetic teacher",
        ] {
            assert!(!stored.contains(private));
        }
        assert_eq!(
            fs::metadata(&directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&snapshot).unwrap().permissions().mode() & 0o777,
            0o600
        );

        let unchanged = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(unchanged["cursor"], baseline["cursor"]);
        assert_eq!(unchanged["baseline"], false);
        assert_eq!(unchanged["updates"], json!([]));
        assert_eq!(fake.detail_reads, 12);

        let existing = collect(&mut fake, &file, request(None, true, MAX_PAGES)).unwrap();
        let updates = existing["updates"].as_array().unwrap();
        assert_eq!(updates.len(), 7);
        let find = |kind: &str| updates.iter().find(|item| item["kind"] == kind).unwrap();
        assert_eq!(find("timetable")["childIds"], json!(["first", "second"]));
        let notification = find("notification");
        assert_eq!(notification["childIds"], json!(["first", "second"]));
        assert_eq!(notification["data"]["state"], "Cleared");
        assert!(notification["data"].get("currentlySelectedPupil").is_none());

        fake.duplicate_notice_id = true;
        let duplicate_id = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(
            duplicate_id["updates"],
            json!([{
                "sourceId": r#"["second",1]"#,
                "childIds": ["first", "second"],
                "kind": "notification",
                "data": duplicate_id["updates"][0]["data"],
            }])
        );
        fake.duplicate_notice_id = false;

        fake.body = "Changed body with an unchanged summary".to_owned();
        let delta = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap();
        assert_ne!(delta["cursor"], baseline["cursor"]);
        assert_eq!(delta["updates"].as_array().unwrap().len(), 1);
        assert_eq!(delta["updates"][0]["kind"], "message");
        assert_eq!(delta["updates"][0]["childIds"], json!(["first", "second"]));
        let replay = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(replay["updates"], delta["updates"]);
        assert_eq!(fs::read_to_string(&snapshot).unwrap(), stored);
        let accepted = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&delta)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(accepted["updates"], json!([]));

        fake.removed = true;
        let missing = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&delta)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(
            missing["missing"],
            json!([{"kind": "message", "sourceId": "12", "folder": "inbox", "childIds": ["first", "second"]}])
        );
        assert_eq!(missing["updates"], json!([]));

        // The pagination limit restores selection and writes no snapshot.
        let file = scratch.session("limit.json");
        let mut fake = Fake::new();
        fake.selected = "second".to_owned();
        let fail = collect(&mut fake, &file, request(None, false, 1)).unwrap_err();
        assert!(message(fail).contains("maxMessagePages"));
        assert_eq!(fake.selected, "second");
        assert!(no_snapshots(&file));

        // Selection interference and cancellation restore with a fresh signal.
        let file = scratch.session("drift.json");
        let mut fake = Fake::new();
        fake.drift = true;
        let fail = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap_err();
        assert!(message(fail).contains("selected child changed"));
        assert_eq!(fake.selected, "first");
        fake.drift = false;
        fake.cancel = true;
        let signal = fake.abort.signal();
        let fail = collect_updates(
            &request(None, false, MAX_PAGES),
            &file,
            &signal,
            &Cancel::default(),
            &mut fake,
        )
        .unwrap_err();
        assert!(fail.is(Code::Cancelled));
        assert_eq!(fake.selected, "first");
        assert!(no_snapshots(&file));

        // Restoration failure prevents a cursor and preserves authentication errors.
        let file = scratch.session("restore.json");
        let mut fake = Fake::new();
        fake.restore_fails = true;
        let fail = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap_err();
        assert!(message(fail).contains("restoration of the original child"));
        assert!(no_snapshots(&file));
        fake.restore_fails = false;
        fake.selected = "first".to_owned();
        fake.expires = true;
        let fail = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap_err();
        assert!(fail.is(Code::LoginRequired));
        assert!(no_snapshots(&file));

        // Account mismatch and expired cursors require an explicit new baseline.
        let file = scratch.session("account.json");
        let mut fake = Fake::new();
        let baseline = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap();
        fake.account = "different-parent".to_owned();
        let fail = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap_err();
        assert!(fail.is(Code::InvalidConfiguration));
        assert_eq!(
            fs::read_dir(collections_directory(&file)).unwrap().count(),
            1
        );
        fake.account = "parent".to_owned();
        let old = SystemTime::now() - Duration::from_secs(91 * 24 * 60 * 60);
        fs::File::options()
            .write(true)
            .open(snapshot_path(
                &collections_directory(&file),
                &cursor(&baseline),
            ))
            .unwrap()
            .set_times(fs::FileTimes::new().set_accessed(old).set_modified(old))
            .unwrap();
        let fail = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap_err();
        assert!(fail.is(Code::InvalidConfiguration));

        // Oversized output fails without a snapshot.
        let file = scratch.session("large.json");
        let mut fake = Fake::new();
        fake.body = "x".repeat(8 * 1024 * 1024);
        let fail = collect(&mut fake, &file, request(None, true, MAX_PAGES)).unwrap_err();
        assert!(message(fail).contains("response size"));
        assert_eq!(fake.selected, "first");
        assert!(no_snapshots(&file));

        // Roster edits abort collection but still restore the available original child.
        let file = scratch.session("rename.json");
        let mut fake = Fake::new();
        fake.rename_during_scan = true;
        let fail = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap_err();
        assert!(message(fail).contains("selected child changed"));
        assert_eq!(fake.selected, "first");
        assert!(no_snapshots(&file));
    }

    #[test]
    fn skipped_upstream_items_are_reported_while_valid_feeds_are_kept() {
        let scratch = Scratch::new("skipped");
        let mut fake = Fake::new();
        fake.skipped.timetable = 1;
        let collection = collect(
            &mut fake,
            &scratch.session("session.json"),
            request(None, true, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(collection["skipped"], 1);
        assert_eq!(
            collection["skippedByFeed"],
            json!({"timetable": 1, "messages": 0, "notifications": 0})
        );
        let updates = collection["updates"].as_array().unwrap();
        assert!(updates.iter().any(|update| update["kind"] == "message"));
        assert!(!updates.iter().any(|update| update["kind"] == "timetable"));
    }

    #[test]
    fn partial_feeds_preserve_their_baselines_through_unchanged_recovery() {
        let scratch = Scratch::new("partial");
        let file = scratch.session("session.json");
        let mut fake = Fake::new();
        let baseline = collect(&mut fake, &file, request(None, false, MAX_PAGES)).unwrap();

        fake.skipped = Skipped {
            timetable: 1,
            messages: 1,
            notifications: 1,
        };
        let partial = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&baseline)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(partial["skipped"], 3);
        assert_eq!(
            partial["skippedByFeed"],
            json!({"timetable": 1, "messages": 1, "notifications": 1})
        );
        assert_eq!(partial["missing"], json!([]));
        assert_eq!(partial["updates"], json!([]));
        assert_eq!(partial["cursor"], baseline["cursor"]);

        fake.skipped = Skipped::default();
        let recovered = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&partial)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(recovered["skipped"], 0);
        assert_eq!(recovered["missing"], json!([]));
        assert_eq!(recovered["updates"], json!([]));
        assert_eq!(recovered["cursor"], baseline["cursor"]);

        let repeated = collect(
            &mut fake,
            &file,
            request(Some(&cursor(&recovered)), false, MAX_PAGES),
        )
        .unwrap();
        assert_eq!(repeated["missing"], json!([]));
        assert_eq!(repeated["updates"], json!([]));
        assert_eq!(repeated["cursor"], baseline["cursor"]);
    }

    #[test]
    fn output_keys_follow_the_collection_schema() {
        let scratch = Scratch::new("order");
        let mut fake = Fake::new();
        let collection = collect(
            &mut fake,
            &scratch.session("session.json"),
            request(None, true, MAX_PAGES),
        )
        .unwrap();
        let keys: Vec<&str> = collection
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(
            keys,
            [
                "baseline",
                "cursor",
                "retrievedAt",
                "skipped",
                "skippedByFeed",
                "children",
                "updates",
                "missing"
            ]
        );
        let message = collection["updates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|update| update["kind"] == "message")
            .unwrap();
        let keys: Vec<&str> = message
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        assert_eq!(keys, ["sourceId", "folder", "childIds", "kind", "data"]);
    }
}
