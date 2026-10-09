//! The saved session: the encrypted store record `{version, current, candidate}` shared with the
//! TypeScript CLI, the plaintext file older versions wrote, and the login, import, migrate, retry
//! and logout changes, with packages/abler-mcp/src/auth.ts's rules and messages. Everything here
//! blocks; the server calls it from `spawn_blocking`.

use std::cell::Cell;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

use family_store::{
    Cancel, Code, DEFAULT_SWEEP_AGE, Error as StoreError, KeyProvider, LockOptions,
    SecretRecordOptions, SecretStore, default_key_provider, default_secret_record_path,
    default_session_path, read_private_file, sweep_temp, with_file_lock, with_secret_store,
    write_private_file,
};
use serde_json::{Value, json};

use crate::error::{Fail, Result};
use crate::jar::Jar;
use crate::js;

/// Two cookies of at most 32 KiB each fit comfortably; anything larger is not a session file.
pub const SESSION_MAX_BYTES: usize = 262_144;

const APP: &str = "abler-mcp";

pub const NO_SESSION: &str =
    "No saved Abler session. Run abler-mcp auth capture or abler-mcp auth import first.";

const NO_CANDIDATE: &str =
    "No retained Abler session candidate. Capture or import a fresh session.";

/// Which saved session a client uses: the one in use, or the candidate it verifies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Current,
    Candidate,
}

/// Node's `path.resolve`: absolute, with `.` and `..` resolved lexically.
pub fn resolve(path: &Path) -> PathBuf {
    let joined = std::env::current_dir().unwrap_or_default().join(path);
    let mut resolved = PathBuf::from("/");

    for component in joined.components() {
        match component {
            Component::ParentDir => {
                resolved.pop();
            }
            Component::Normal(name) => resolved.push(name),
            Component::RootDir | Component::CurDir | Component::Prefix(_) => {}
        }
    }
    resolved
}

/// The pre-store plaintext session file; its `.pending` siblings are failed-import candidates.
pub fn session_path() -> Result<PathBuf> {
    match std::env::var_os("ABLER_SESSION_FILE").filter(|file| !file.is_empty()) {
        Some(file) => Ok(resolve(Path::new(&file))),
        None => Ok(resolve(
            &default_session_path(APP, None).map_err(|_| Fail::Unknown)?,
        )),
    }
}

/// Fixed messages: a store failure never shows a path, key or cookie, and never falls back.
pub fn store_error(error: &StoreError) -> Fail {
    Fail::Store(match error.code {
        Code::StoreLocked => "Unlock your login keychain and try again.",
        Code::StoreAccessDenied => {
            "Access to the Abler store key was denied. Allow abler-mcp to use the login keychain and try again."
        }
        Code::StoreTimeout => "The login keychain did not answer in time. Try again.",
        Code::StoreUnavailable => {
            "The Abler store key is missing. Run abler-mcp auth login, capture or import to sign in again."
        }
        Code::StoreWriteUncertain => {
            "The last write to the Abler session store did not complete, so its session is not used. Remove the Abler secret store files and run abler-mcp auth login again."
        }
        Code::SecretNotFound => NO_SESSION,
        Code::Busy => "Another abler-mcp process is using the Abler session store. Try again.",
        Code::LockLost => "Another process took over the Abler session lock. Retry the request.",
        Code::Cancelled => "Cancelled before the Abler session store changed.",
        Code::TooLarge => {
            "The Abler session is larger than the store allows. Capture or import a fresh session."
        }
        // TypeScript throws a RangeError here, which is not a store error.
        Code::InvalidArgument => return Fail::Unknown,
        _ => {
            "Cannot use the Abler session store. Its files or key are damaged, unsafe, or not readable."
        }
    })
}

/// `guarded`: every store failure becomes its fixed message.
impl From<StoreError> for Fail {
    fn from(error: StoreError) -> Self {
        store_error(&error)
    }
}

/// A failure inside a lock hold, or the lock's own (acquiring, releasing).
enum Held {
    Fail(Fail),
    Store(StoreError),
}

impl From<StoreError> for Held {
    fn from(error: StoreError) -> Self {
        Held::Store(error)
    }
}

impl From<Fail> for Held {
    fn from(fail: Fail) -> Self {
        Held::Fail(fail)
    }
}

/// `keys` is a test seam; the default is the macOS Keychain or a Linux key file.
fn session_record(
    keys: Option<Arc<dyn KeyProvider>>,
    cancel: Cancel,
) -> std::result::Result<SecretRecordOptions, StoreError> {
    let path = default_secret_record_path(APP)?;
    let keys = match keys {
        Some(keys) => keys,
        None => default_key_provider(APP, "default")?,
    };
    let mut record = SecretRecordOptions::new(
        path,
        APP,
        "default",
        "session",
        1,
        keys,
        SESSION_MAX_BYTES * 2 + 4096,
    );
    record.cancel = cancel;
    Ok(record)
}

/// The record's plaintext. Both slots empty means logged out. Cookies are kept as stored.
#[derive(Debug, Clone, Default)]
struct Record {
    current: Option<Vec<Value>>,
    candidate: Option<(String, Vec<Value>)>,
}

/// `{version: 1, cookies}`, the session as saved.
fn stored_jar(value: &Value) -> Option<Vec<Value>> {
    let object = value.as_object()?;
    (object.get("version")?.as_f64()? == 1.0).then_some(())?;
    object.get("cookies")?.as_array().cloned()
}

fn jar_value(cookies: &[Value]) -> Value {
    json!({ "version": 1, "cookies": cookies })
}

fn cookies_of(jar: &Jar) -> Vec<Value> {
    stored_jar(&jar.serialize()).unwrap_or_default()
}

/// zod's `uuid()`: an RFC 9562 UUID of version 1-8, or the nil or max UUID.
fn is_uuid(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    if lower == "00000000-0000-0000-0000-000000000000"
        || lower == "ffffffff-ffff-ffff-ffff-ffffffffffff"
    {
        return true;
    }
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(at, byte)| match at {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        })
        && (b'1'..=b'8').contains(&bytes[14])
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn parse_record(text: &str) -> Option<Record> {
    let value = js::parse(text.as_bytes())?;
    let object = value.as_object()?;
    (object.get("version")?.as_f64()? == 1.0).then_some(())?;
    let current = match object.get("current")? {
        Value::Null => None,
        jar => Some(stored_jar(jar)?),
    };
    let candidate = match object.get("candidate")? {
        Value::Null => None,
        candidate => {
            let id = candidate.get("id")?.as_str().filter(|id| is_uuid(id))?;
            Some((id.to_owned(), stored_jar(candidate.get("jar")?)?))
        }
    };
    Some(Record { current, candidate })
}

fn encode(record: &Record) -> String {
    json!({
        "version": 1,
        "current": record.current.as_deref().map(jar_value),
        "candidate": record.candidate.as_ref().map(|(id, jar)| json!({ "id": id, "jar": jar_value(jar) })),
    })
    .to_string()
}

/// The committed record, or `None` while the store holds none.
fn stored_record(store: &mut SecretStore) -> Result<Option<Record>> {
    match store.read()? {
        None => Ok(None),
        Some(text) => parse_record(&text).map(Some).ok_or(Fail::Safe(
            "Invalid Abler session store record. Run abler-mcp auth login, capture or import again.",
        )),
    }
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(false),
        Err(_) => Err(Fail::Safe(
            "Cannot inspect the Abler session store. Check its permissions.",
        )),
    }
}

/// A marker, or even a lone record, means the store decides; the legacy files are never read.
fn store_decides(store: &SecretStore, record: &Path) -> Result<bool> {
    Ok(store.exists()? || exists(record)?)
}

/// The pre-store plaintext file, read with the rules it always had; `None` when missing.
fn read_legacy(path: &Path) -> Result<Option<Jar>> {
    let raw = match read_private_file(path, SESSION_MAX_BYTES) {
        Ok(raw) => raw,
        Err(error) if error.code == Code::NotFound => return Ok(None),
        Err(_) => {
            return Err(Fail::Safe(
                "Cannot read the Abler session file. Use a regular file that you own with owner-only permissions (chmod 600 on Unix), not a symlink or hard link.",
            ));
        }
    };
    js::parse(raw.as_bytes())
        .and_then(|value| Jar::import(&value).ok())
        .map(Some)
        .ok_or(Fail::Safe(
            "Invalid or expired Abler session file. Capture/import a fresh session.",
        ))
}

pub fn load_session(path: &Path) -> Result<Jar> {
    read_legacy(path)?.ok_or(Fail::Safe(NO_SESSION))
}

pub fn save_session(path: &Path, jar: &Jar) -> Result<()> {
    write_private_file(
        path,
        format!("{}\n", jar.serialize()).as_bytes(),
        &Cancel::default(),
    )
    .map_err(|_| Fail::Safe("Cannot save the Abler session file. Check the directory permissions."))
}

/// Where a held operation persists its rotated jar, before any further request.
enum Target<'h, 'o> {
    Legacy(&'h Path),
    Store {
        store: &'h mut SecretStore<'o>,
        record: &'h Path,
        slot: Slot,
        next: Record,
    },
}

/// The jar of one held operation, and how to persist its rotation.
pub struct Session<'h, 'o> {
    pub jar: Jar,
    pub storage: &'static str,
    target: Target<'h, 'o>,
}

impl Session<'_, '_> {
    pub fn save(&mut self) -> Result<()> {
        match &mut self.target {
            Target::Legacy(path) => save_session(path, &self.jar),
            Target::Store {
                store,
                record,
                slot,
                next,
            } => {
                let rotated = cookies_of(&self.jar);

                match (&mut next.candidate, slot) {
                    (Some((_, jar)), Slot::Candidate) => *jar = rotated,
                    _ => next.current = Some(rotated),
                }

                if store.write(&encode(next)).is_err() {
                    return Err(lost(record));
                }
                Ok(())
            }
        }
    }

    /// A response whose cookies cannot be read may have rotated the session, like one whose
    /// rotation cannot be written. `None` for the plaintext file, which keeps its session.
    pub fn lose(&mut self) -> Option<Fail> {
        match &self.target {
            Target::Store { record, .. } => Some(lost(record)),
            Target::Legacy(_) => None,
        }
    }
}

/// Abler has consumed the old refresh token, so the record must never offer it again. Removing
/// it under the held lock reads as STORE_WRITE_UNCERTAIN.
fn lost(record: &Path) -> Fail {
    let _ = fs::remove_file(record);
    store_error(&StoreError::new(
        Code::StoreWriteUncertain,
        "Rotated session lost.",
    ))
}

fn storage_name(keys: &dyn KeyProvider) -> &'static str {
    if keys.key_source() == "keychain-accessor" {
        "Saved in an encrypted file whose key is in the macOS Keychain."
    } else {
        "Saved in an encrypted file."
    }
}

/// Hold the store lock for all of `work`, so refreshes and requests use one session. Before the
/// store has a marker the legacy file is authoritative and rotations are written back to it; once
/// it has one only the store is used, whatever it holds.
pub fn with_session<T>(
    legacy: &Path,
    slot: Slot,
    cancel: &Cancel,
    keys: Option<Arc<dyn KeyProvider>>,
    work: impl FnOnce(&mut Session) -> Result<T>,
) -> Result<T> {
    let record = session_record(keys, cancel.clone()).map_err(|error| store_error(&error))?;
    let held = Cell::new(false);
    let storage = storage_name(&*record.keys);

    let outcome = with_secret_store(&record, |store| -> std::result::Result<T, Held> {
        held.set(true);

        if !store_decides(store, &record.path)? {
            if slot == Slot::Candidate {
                return Err(Fail::Safe(NO_CANDIDATE).into());
            }
            // Temporaries orphaned by a hard crash hold credentials; old ones are removed.
            sweep_temp(legacy, DEFAULT_SWEEP_AGE).map_err(|_| {
                Fail::Safe("Cannot clean up beside the Abler session file. Check permissions.")
            })?;
            let mut session = Session {
                jar: load_session(legacy)?,
                storage: "Saved in a plaintext file. Run abler-mcp auth migrate.",
                target: Target::Legacy(legacy),
            };
            return Ok(work(&mut session)?);
        }
        let saved = stored_record(store)?;
        let stored = saved.as_ref().and_then(|saved| match slot {
            Slot::Current => saved.current.clone(),
            Slot::Candidate => saved.candidate.as_ref().map(|(_, jar)| jar.clone()),
        });
        let (Some(saved), Some(stored)) = (saved, stored) else {
            let missing = match slot {
                Slot::Current => NO_SESSION,
                Slot::Candidate => NO_CANDIDATE,
            };
            return Err(Fail::Safe(missing).into());
        };
        let jar = Jar::import(&jar_value(&stored)).map_err(|_| {
            Fail::Expired("Invalid or expired Abler session. Capture/import a fresh session.")
        })?;
        let mut session = Session {
            jar,
            storage,
            target: Target::Store {
                store,
                record: &record.path,
                slot,
                next: saved,
            },
        };
        Ok(work(&mut session)?)
    });

    match outcome {
        Ok(value) => Ok(value),
        Err(Held::Fail(fail)) => Err(fail),
        // Store setup and taking the lock are mapped; anything after that was never a SafeError.
        Err(Held::Store(error)) if !held.get() => Err(store_error(&error)),
        Err(Held::Store(_)) => Err(Fail::Unknown),
    }
}

/// Where the session is saved, after checking that one is.
pub fn session_storage(legacy: &Path, keys: Option<Arc<dyn KeyProvider>>) -> Result<&'static str> {
    with_session(legacy, Slot::Current, &Cancel::default(), keys, |session| {
        Ok(session.storage)
    })
}

/// Resolve symbolic links in the longest existing prefix, so aliases compare equal.
fn canonical(path: &Path) -> Result<PathBuf> {
    let mut existing = resolve(path);
    let mut rest = Vec::new();

    loop {
        match fs::canonicalize(&existing) {
            Ok(real) => return Ok(rest.iter().rev().fold(real, |path, name| path.join(name))),
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let (Some(parent), Some(name)) = (existing.parent(), existing.file_name()) else {
                    break;
                };
                rest.push(name.to_owned());
                existing = parent.to_owned();
            }
            Err(_) => break,
        }
    }
    Err(Fail::Safe(
        "Cannot resolve the Abler session paths. Check their permissions.",
    ))
}

/// Same file, or one name is the other's `<name>.` namespace (lock, marker, temporaries) beside it.
fn overlaps(first: &Path, second: &Path) -> bool {
    let (Some(a), Some(b)) = (first.file_name(), second.file_name()) else {
        return false;
    };
    let (a, b) = (a.as_encoded_bytes(), b.as_encoded_bytes());
    let namespace =
        |name: &[u8], of: &[u8]| name.starts_with(of) && name.get(of.len()) == Some(&b'.');
    first.parent() == second.parent() && (a == b || namespace(a, b) || namespace(b, a))
}

/// The path and every directory above it, short of the root.
fn lineage(path: &Path) -> impl Iterator<Item = &Path> {
    path.ancestors().filter(|up| up.parent().is_some())
}

/// The legacy file, its candidates and temporaries are removed and swept, and the store can be
/// reset, so neither namespace may hold, or sit inside a directory of, the other or the key file.
fn reject_collisions(record: &SecretRecordOptions, legacy: &Path) -> Result<()> {
    let file = canonical(legacy)?;
    let mut owned = vec![canonical(&record.path)?];

    if let Some(key) = record.keys.key_file() {
        owned.push(canonical(key)?);
    }

    if owned.iter().any(|path| {
        lineage(&file).any(|up| overlaps(up, path)) || lineage(path).any(|up| overlaps(&file, up))
    }) {
        return Err(Fail::Safe(
            "ABLER_SESSION_FILE overlaps the encrypted Abler session store or its key. Choose another path.",
        ));
    }
    Ok(())
}

fn lock_error(error: &StoreError) -> Fail {
    Fail::Safe(match error.code {
        Code::LockLost => "Another process took over the Abler session lock. Retry the request.",
        Code::UnsafeFile => "The Abler session file has hard links, which are unsupported.",
        _ => {
            "Cannot lock the Abler session. Another request may be busy; retry shortly and check directory permissions."
        }
    })
}

/// Login, import, migrate, retry and logout hold the legacy file's lock for the whole change, and
/// take the store's inside it. Clients take only the store's lock, so the order never inverts.
fn administer<T>(
    legacy: &Path,
    keys: Option<Arc<dyn KeyProvider>>,
    work: impl FnOnce(&SecretRecordOptions) -> Result<T>,
) -> Result<T> {
    let record = session_record(keys, Cancel::default())?;
    reject_collisions(&record, legacy)?;

    let locked = with_file_lock(
        legacy,
        &LockOptions::default(),
        || -> std::result::Result<T, Held> {
            // Temporaries orphaned by a hard crash hold credentials; the lock holder removes old ones.
            sweep_temp(legacy, DEFAULT_SWEEP_AGE)?;
            Ok(work(&record)?)
        },
    );

    match locked {
        Ok(value) => Ok(value),
        Err(Held::Fail(fail)) => Err(fail),
        Err(Held::Store(error)) => Err(lock_error(&error)),
    }
}

fn pending_candidates(path: &Path) -> std::io::Result<Vec<PathBuf>> {
    let directory = path.parent().unwrap_or(Path::new("/"));
    let mut prefix = path
        .file_name()
        .unwrap_or_default()
        .as_encoded_bytes()
        .to_vec();
    prefix.push(b'.');
    let mut found = Vec::new();

    for entry in fs::read_dir(directory)? {
        let name = entry?.file_name();
        let bytes = name.as_encoded_bytes();

        if bytes.starts_with(&prefix) && bytes.ends_with(b".pending") {
            found.push(directory.join(name));
        }
    }
    Ok(found)
}

/// The legacy file and its `.pending` candidates are credentials; remove them and any orphaned
/// temporaries beside them. True if any was there.
fn remove_legacy(path: &Path) -> Result<bool> {
    let removed = (|| {
        let found = exists(path).ok()?;
        remove_forced(path).ok()?;
        let candidates = pending_candidates(path).ok()?;

        for candidate in &candidates {
            remove_forced(candidate).ok()?;
        }
        sweep_temp(path, DEFAULT_SWEEP_AGE).ok()?;
        Some(found || !candidates.is_empty())
    })();
    removed.ok_or(Fail::Safe(
        "Cannot remove the old plaintext Abler session file or its failed-import candidates. Any encrypted-store change already completed; remove those files by hand.",
    ))
}

fn remove_forced(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// A readable legacy session as stored, or `None`: a broken file is replaced, as it always was.
fn legacy_current(path: &Path) -> Option<Vec<Value>> {
    read_legacy(path).ok().flatten().map(|jar| cookies_of(&jar))
}

/// The newest readable `.pending` candidate an older version retained, if any.
fn newest_pending(path: &Path) -> Result<Option<Vec<Value>>> {
    let unlisted =
        || Fail::Safe("Cannot list the failed-import candidates. Check their permissions.");
    let mut dated = Vec::new();

    for candidate in pending_candidates(path).map_err(|_| unlisted())? {
        let modified = fs::symlink_metadata(&candidate)
            .and_then(|metadata| metadata.modified())
            .map_err(|_| unlisted())?;
        let at = modified
            .duration_since(UNIX_EPOCH)
            .map_or(0.0, |elapsed| elapsed.as_secs_f64() * 1000.0);
        dated.push((candidate, at));
    }
    dated.sort_by(|a, b| b.1.total_cmp(&a.1));

    Ok(dated
        .iter()
        .find_map(|(candidate, _)| read_legacy(candidate).ok().flatten())
        .map(|jar| cookies_of(&jar)))
}

/// Create the key when it is missing; only an explicit new login may reset a lost key's store.
fn prepare_key(store: &mut SecretStore, record: &SecretRecordOptions, reset: bool) -> Result<bool> {
    match record.keys.get_key(&record.cancel) {
        // The key is wiped as it is dropped.
        Ok(_) => Ok(false),
        Err(error) if error.code != Code::StoreUnavailable => Err(error.into()),
        Err(error) => {
            let used = store_decides(store, &record.path)?;

            if used {
                if !reset {
                    return Err(error.into());
                }
                store.reset()?;
            }
            store.create_key()?;
            Ok(used)
        }
    }
}

/// Verifies the candidate slot, for example with a forced refresh and an authenticated read.
fn verify_candidate(verify: impl FnOnce() -> Result<()>, reset: bool) -> Result<()> {
    match verify() {
        Ok(()) => Ok(()),
        // A refresh may already have rotated the candidate; it stays retained in the store.
        Err(fail @ (Fail::Store(_) | Fail::Expired(_))) => Err(fail),
        Err(_) if reset => Err(Fail::Safe(
            "Session verification failed. The old store could not be read without its key and was replaced; the new session is retained in the encrypted store. Run abler-mcp auth retry-candidate, or capture a fresh session.",
        )),
        Err(_) => Err(Fail::Safe(
            "Session verification failed. The previous session was kept; the new one is retained in the encrypted store. Run abler-mcp auth retry-candidate, or capture a fresh session.",
        )),
    }
}

/// Make the verified candidate the session in use in one write, then remove plaintext leftovers.
fn promote(record: &SecretRecordOptions, legacy: &Path, id: &str) -> Result<()> {
    with_secret_store(record, |store| {
        let candidate = stored_record(store)?
            .and_then(|saved| saved.candidate)
            .filter(|(candidate, _)| candidate == id)
            .ok_or(Fail::Safe(
                "The Abler session candidate changed. Capture a fresh session.",
            ))?;
        store.write(&encode(&Record {
            current: Some(candidate.1),
            candidate: None,
        }))?;
        remove_legacy(legacy)?;
        Ok(())
    })
}

/// Login, capture and import: store `jar` as the candidate (replacing an older one), verify it,
/// then promote it. Before the store decides, a readable legacy session moves in as the current
/// one, so a failed verification still keeps it. True if a store whose key was lost was reset.
pub fn save_verified_session(
    jar: &Jar,
    verify: impl FnOnce() -> Result<()>,
    legacy: &Path,
    keys: Option<Arc<dyn KeyProvider>>,
) -> Result<bool> {
    administer(legacy, keys, |record| {
        let candidate = (js::uuid().ok_or(Fail::Unknown)?, cookies_of(jar));

        let replaced = with_secret_store(record, |store| -> Result<bool> {
            let decides = store_decides(store, &record.path)?;
            let reset = prepare_key(store, record, true)?;
            let mut saved = if decides {
                stored_record(store)?.unwrap_or_default()
            } else {
                Record {
                    current: legacy_current(legacy),
                    candidate: None,
                }
            };
            saved.candidate = Some(candidate.clone());
            store.write(&encode(&saved))?;

            // The store decides from here on, so the plaintext files would never be read again.
            if !decides {
                remove_legacy(legacy)?;
            }
            Ok(reset)
        })?;

        verify_candidate(verify, replaced)?;
        promote(record, legacy, &candidate.0)?;
        Ok(replaced)
    })
}

/// Verify and promote the candidate a failed import or a migration retained.
pub fn retry_candidate(
    verify: impl FnOnce() -> Result<()>,
    legacy: &Path,
    keys: Option<Arc<dyn KeyProvider>>,
) -> Result<()> {
    administer(legacy, keys, |record| {
        let id = with_secret_store(record, |store| -> Result<String> {
            let saved = match store_decides(store, &record.path)? {
                true => stored_record(store)?,
                false => None,
            };
            saved
                .and_then(|saved| saved.candidate)
                .map(|(id, _)| id)
                .ok_or(Fail::Safe(NO_CANDIDATE))
        })?;

        verify_candidate(verify, false)?;
        promote(record, legacy, &id)
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migrated {
    Moved,
    Candidate,
    Already,
    AlreadyRemovedLegacy,
}

/// Move the legacy session into the store as the current one, or, without one, the newest
/// `.pending` candidate into the candidate slot. A store with a marker but no record (an
/// interrupted first write or reset) takes the explicit migration.
pub fn migrate_session(legacy: &Path, keys: Option<Arc<dyn KeyProvider>>) -> Result<Migrated> {
    administer(legacy, keys, |record| {
        with_secret_store(record, |store| {
            if store_decides(store, &record.path)? && stored_record(store)?.is_some() {
                return Ok(match remove_legacy(legacy)? {
                    true => Migrated::AlreadyRemovedLegacy,
                    false => Migrated::Already,
                });
            }
            let current = read_legacy(legacy)?.map(|jar| cookies_of(&jar));
            let pending = match current {
                Some(_) => None,
                None => newest_pending(legacy)?,
            };

            if current.is_none() && pending.is_none() {
                return Err(Fail::Safe(NO_SESSION));
            }
            prepare_key(store, record, false)?;
            let candidate = match pending {
                Some(jar) => Some((js::uuid().ok_or(Fail::Unknown)?, jar)),
                None => None,
            };
            let migrated = match current {
                Some(_) => Migrated::Moved,
                None => Migrated::Candidate,
            };
            store.write(&encode(&Record { current, candidate }))?;
            remove_legacy(legacy)?;
            Ok(migrated)
        })
    })
}

/// Store a logged-out record when the store decides, and remove any plaintext files.
pub fn logout_session(legacy: &Path, keys: Option<Arc<dyn KeyProvider>>) -> Result<()> {
    administer(legacy, keys, |record| {
        with_secret_store(record, |store| {
            if store_decides(store, &record.path)? {
                store.write(&encode(&Record::default()))?;
            }
            remove_legacy(legacy)?;
            Ok(())
        })
    })
}

#[cfg(test)]
mod tests {
    use std::os::unix::fs::DirBuilderExt;

    use family_store::FakeKeyProvider;

    use super::*;
    use crate::jar::parse_set_cookie;

    #[test]
    fn a_failed_rotation_write_removes_the_record_so_the_spent_token_is_never_offered() {
        let directory = std::env::temp_dir().join(format!("abler-auth-{}", std::process::id()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let keys: Arc<dyn KeyProvider> = Arc::new(FakeKeyProvider::new(Some([7; 32])));
        let options = SecretRecordOptions::new(
            directory.join("session.enc"),
            APP,
            "default",
            "session",
            1,
            keys,
            600,
        );
        let jar = Jar::import(
            &json!([{ "name": "refreshToken", "value": "r0", "domain": "www.abler.io" }]),
        )
        .unwrap();
        let saved = Record {
            current: Some(cookies_of(&jar)),
            candidate: None,
        };
        with_secret_store(&options, |store| store.write(&encode(&saved))).unwrap();

        // The rotated session outgrows the record's limit, so its write fails.
        let outcome = with_secret_store(&options, |store| -> Result<()> {
            let mut session = Session {
                jar: jar.clone(),
                storage: "",
                target: Target::Store {
                    store,
                    record: &options.path,
                    slot: Slot::Current,
                    next: saved.clone(),
                },
            };
            let large =
                parse_set_cookie(&format!("id_token={}; Path=/", "a".repeat(1000))).unwrap();
            session.jar.set(large, "/oauth/token").unwrap();
            session.save()
        });
        let uncertain = store_error(&StoreError::new(Code::StoreWriteUncertain, ""));
        assert_eq!(outcome, Err(uncertain));
        assert!(!options.path.exists());
        let again = with_secret_store(&options, |store| store.read().map(drop));
        assert_eq!(again.unwrap_err().code, Code::StoreWriteUncertain);
        fs::remove_dir_all(&directory).unwrap();
    }

    /// The checks of integration.test.ts that inject a key provider or a verifier, which the
    /// binary cannot be given: tests/ts/integration.test.ts runs the rest through it.
    #[test]
    fn keychain_failures_have_the_typescript_messages() {
        for (code, needle) in [
            (
                Code::StoreLocked,
                "Unlock your login keychain and try again.",
            ),
            (Code::StoreTimeout, "did not answer in time"),
            (
                Code::StoreAccessDenied,
                "Allow abler-mcp to use the login keychain",
            ),
        ] {
            let Fail::Store(message) = store_error(&StoreError::new(code, "")) else {
                panic!("{code:?} is not a store failure");
            };
            assert!(message.contains(needle), "{message}");
        }
    }

    #[test]
    fn verification_passes_store_and_expired_messages_and_promote_refuses_a_changed_candidate() {
        let uncertain = store_error(&StoreError::new(Code::StoreWriteUncertain, ""));
        assert_eq!(verify_candidate(|| Err(uncertain), false), Err(uncertain));
        let expired = Fail::Expired("expired");
        assert_eq!(verify_candidate(|| Err(expired), true), Err(expired));
        let Err(Fail::Safe(replaced)) = verify_candidate(|| Err(Fail::Unknown), true) else {
            panic!("a failed verification is a SafeError");
        };
        assert!(replaced.contains("was replaced; the new session is retained"));
        assert!(!replaced.contains("previous session was kept"));

        // The candidate replaced between verification and promote is never promoted.
        let directory = std::env::temp_dir().join(format!("abler-promote-{}", std::process::id()));
        fs::DirBuilder::new()
            .mode(0o700)
            .create(&directory)
            .unwrap();
        let keys: Arc<dyn KeyProvider> = Arc::new(FakeKeyProvider::new(Some([9; 32])));
        let options = SecretRecordOptions::new(
            directory.join("session.enc"),
            APP,
            "default",
            "session",
            1,
            keys,
            600_000,
        );
        let jar = Jar::import(
            &json!([{ "name": "refreshToken", "value": "r0", "domain": "www.abler.io" }]),
        )
        .unwrap();
        let held = Record {
            current: None,
            candidate: Some((js::uuid().unwrap(), cookies_of(&jar))),
        };
        with_secret_store(&options, |store| store.write(&encode(&held))).unwrap();

        let verified = js::uuid().unwrap();
        assert_eq!(
            promote(&options, &directory.join("session.json"), &verified),
            Err(Fail::Safe(
                "The Abler session candidate changed. Capture a fresh session."
            ))
        );
        let kept = with_secret_store(&options, stored_record).unwrap();
        assert!(kept.is_some_and(|kept| kept.current.is_none() && kept.candidate.is_some()));
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn records_parse_and_encode_like_the_typescript_schema() {
        let text = r#"{"version":1,"current":{"version":1,"cookies":[{"b":1,"1":2}],"extra":1},"candidate":null,"x":2}"#;
        let record = parse_record(text).unwrap();
        assert_eq!(
            encode(&record),
            r#"{"version":1,"current":{"version":1,"cookies":[{"1":2,"b":1}]},"candidate":null}"#
        );
        for invalid in [
            r#"{"version":1,"current":null}"#,
            r#"{"version":2,"current":null,"candidate":null}"#,
            r#"{"version":1,"current":null,"candidate":{"id":"not-a-uuid","jar":{"version":1,"cookies":[]}}}"#,
            r#"{"version":1,"current":{"version":1},"candidate":null}"#,
        ] {
            assert!(parse_record(invalid).is_none(), "{invalid}");
        }
        assert!(is_uuid("6F9619FF-8B86-4011-B42D-00C04FC964FF"));
        assert!(!is_uuid("6f9619ff-8b86-9011-b42d-00c04fc964ff"));
    }

    #[test]
    fn collisions_compare_namespaces_beside_each_other() {
        let at = |path: &str| PathBuf::from(path);
        assert!(overlaps(
            &at("/a/session.enc"),
            &at("/a/session.enc.marker")
        ));
        assert!(overlaps(&at("/a/session.enc.lock"), &at("/a/session.enc")));
        assert!(!overlaps(&at("/a/session.encx"), &at("/a/session.enc")));
        assert!(!overlaps(&at("/b/session.enc"), &at("/a/session.enc")));
        assert_eq!(
            lineage(&at("/a/b")).collect::<Vec<_>>(),
            [at("/a/b"), at("/a")]
        );
        assert_eq!(resolve(&at("/a/./b/../c/")), at("/a/c"));
    }
}
