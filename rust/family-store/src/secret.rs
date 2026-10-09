use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rustix::io::Errno;

use crate::backup::exclude_from_backups;
use crate::errors::{Cancel, Code, Error, Result, errno};
use crate::files::{
    DEFAULT_SWEEP_AGE, parent, random, read_private_bytes, suffixed, sweep_temp, write_private_file,
};
use crate::keys::{Key, KeyProvider, key_temporary};
use crate::lock::{DEFAULT_WAIT, LockOptions, with_file_lock};
use crate::storage::{MAX_LINKS, StorePaths, check_store_paths, store_directories};

#[derive(Clone)]
pub struct SecretRecordOptions {
    /// Canonical record path. Its lock is `<path>.lock` and its non-secret marker `<path>.marker`.
    pub path: PathBuf,
    pub server: String,
    pub profile: String,
    /// What the record holds, such as `session`; a record never opens under another purpose.
    pub purpose: String,
    /// Version of the plaintext's own format, a positive integer of at most 15 digits.
    pub schema: u64,
    pub keys: Arc<dyn KeyProvider>,
    /// Largest accepted plaintext in UTF-8 bytes.
    pub max_bytes: usize,
    /// Stops waiting for the lock or before `update` runs; a started write always completes.
    pub cancel: Cancel,
    /// Longest wait for a busy lock. Default 30 s.
    pub wait: Duration,
    /// Files of an earlier layout of this store ([`crate::retired_store_paths`]). While one exists
    /// the store decides (`exists()` is true), so an older plaintext credential is never imported
    /// over it; that includes a link or entry that cannot be followed. Only one shown to be the
    /// current store under another name is ignored. They are only checked by metadata, never read.
    pub retired: Vec<PathBuf>,
}

impl SecretRecordOptions {
    pub fn new(
        path: impl Into<PathBuf>,
        server: &str,
        profile: &str,
        purpose: &str,
        schema: u64,
        keys: Arc<dyn KeyProvider>,
        max_bytes: usize,
    ) -> Self {
        Self {
            path: path.into(),
            server: server.to_owned(),
            profile: profile.to_owned(),
            purpose: purpose.to_owned(),
            schema,
            keys,
            max_bytes,
            cancel: Cancel::default(),
            wait: DEFAULT_WAIT,
            retired: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
struct Marker {
    migrated: bool,
    generation: u64,
    pending: Option<(u64, String)>,
}

struct OpenedRecord {
    generation: u64,
    nonce: String,
    plaintext: Vec<u8>,
}

const NONCE_BYTES: usize = 12;

const TAG_BYTES: usize = 16;

const HEADER_MAX_BYTES: usize = 512;

const MARKER_MAX_BYTES: usize = 1024;

// The largest generation or schema the 15-digit header and marker fields hold.
const MAX_INTEGER: u64 = 999_999_999_999_999;

const RETIRED_KEY_SOURCE: &str = "keychain-accessor";

/// A store whose record lock is already held, from [`with_secret_store`]. Nothing locks again, and
/// the borrow ends with the hold.
pub struct SecretStore<'a> {
    options: &'a SecretRecordOptions,
    // A failed write ends the handle with that error's code and message.
    ended: Option<(Code, &'static str)>,
    // The key and the marker as of the last read or write in this hold.
    state: Option<(Key, Option<Marker>)>,
}

impl SecretStore<'_> {
    fn usable(&self) -> Result<()> {
        match self.ended {
            Some((code, message)) => Err(Error::new(code, message)),
            None => Ok(()),
        }
    }

    // The key is wiped as it is dropped, here and when the hold ends.
    fn forget(&mut self) {
        self.state = None;
    }

    /// The committed plaintext and marker. The key stays in the hold, which lends it out.
    fn open(&mut self) -> Result<(Option<String>, Option<Marker>)> {
        self.usable()?;
        sweep_temp(&self.options.path, DEFAULT_SWEEP_AGE)?;
        let mut fetched = None;
        let key = match &self.state {
            Some((key, _)) => key,
            None => &*fetched.insert(current_key(self.options)?),
        };
        let (current, marker) = load(self.options, key)?;

        match (&mut self.state, fetched) {
            (Some((_, held)), _) => *held = marker.clone(),
            (state, Some(key)) => *state = Some((key, marker.clone())),
            (None, None) => {}
        }
        let current = current.map(|bytes| String::from_utf8_lossy(&bytes).into_owned());
        Ok((current, marker))
    }

    /// True once a marker exists, or a file of an earlier layout that is not shown to be this
    /// store: the store then decides, also while it holds no record.
    pub fn exists(&self) -> Result<bool> {
        self.usable()?;
        Ok(secret_store_exists(&self.options.path)?
            || !leftovers(self.options)?.deciding.is_empty())
    }

    /// The committed plaintext, or `None` while the store holds no record.
    pub fn read(&mut self) -> Result<Option<String>> {
        Ok(self.open()?.0)
    }

    /// Commit `next` as the next generation: pending marker, record, authenticated read-back,
    /// marker commit. Any failure ends the handle; one after a file changed is
    /// STORE_WRITE_UNCERTAIN.
    pub fn write(&mut self, next: &str) -> Result<()> {
        self.usable()?;
        let written: Result<()> = (|| {
            if self.state.is_none() {
                self.open()?;
            }
            let options = self.options;

            if let Some((key, marker)) = &mut self.state {
                check_generation_left(marker.as_ref())?;
                *marker = Some(store(options, key, marker.as_ref(), next)?);
            }
            Ok(())
        })();

        if let Err(error) = &written {
            self.ended = Some((error.code, error.message));
        }
        written
    }

    /// Run `update` on the current plaintext and store its `Some` result as the next generation;
    /// `None` leaves the record unchanged. Returns the stored plaintext.
    pub fn update<E: From<Error>>(
        &mut self,
        update: impl FnOnce(Option<&str>) -> std::result::Result<Option<String>, E>,
    ) -> std::result::Result<Option<String>, E> {
        let (current, marker) = self.open()?;
        check_generation_left(marker.as_ref())?;
        self.options.cancel.check()?;

        match update(current.as_deref())? {
            None => Ok(current),
            Some(next) => {
                self.write(&next)?;
                Ok(Some(next))
            }
        }
    }

    /// Explicit setup: create the key while there is no record, and either no marker or a
    /// generation-0 marker without a pending write whose key is conclusively missing.
    pub fn create_key(&mut self) -> Result<()> {
        self.usable()?;
        // Setup changes the key, so the next read or write loads again.
        self.forget();
        let options = self.options;
        let marker = read_marker(options)?;
        let set_up = exists(&options.path)?
            || match marker {
                None => false,
                Some(marker) => {
                    marker.generation != 0 || marker.pending.is_some() || !key_missing(options)?
                }
            };

        if set_up {
            return Err(Error::new(
                Code::StoreError,
                "The secret store is already set up; its key is never replaced.",
            ));
        }
        options.keys.create_key(&options.cancel)
    }

    /// Explicit re-setup after a lost key: only while the key is conclusively missing, commit a
    /// fresh generation-0 marker first and then remove the record, which nothing can decrypt
    /// anymore. The caller then runs `create_key` and writes. Any other key outcome leaves both
    /// files untouched.
    pub fn reset(&mut self) -> Result<()> {
        self.usable()?;
        self.forget();
        let options = self.options;
        // A missing key is what that build leaves; its record may still open with the Keychain key.
        refuse_retired(options)?;

        if !key_missing(options)? {
            return Err(Error::new(
                Code::StoreError,
                "The store key is available; a readable secret store is never reset.",
            ));
        }
        // The fresh marker commits before the record goes, so no crash leaves a store without one.
        write_marker(
            options,
            &Marker {
                migrated: false,
                generation: 0,
                pending: None,
            },
        )?;

        match fs::remove_file(&options.path) {
            Ok(()) => {}
            Err(error) if errno(&error) == Some(Errno::NOENT) => {}
            Err(error) => {
                return Err(Error::io(
                    error,
                    "Cannot remove the secret record. Check its permissions.",
                ));
            }
        }
        sweep_temp(&options.path, DEFAULT_SWEEP_AGE)?;
        Ok(())
    }

    /// Confirm the key is there without reading the record: STORE_BACKEND_RETIRED first for a
    /// store set up through the retired Keychain accessor, then whatever `get_key` returns
    /// (STORE_UNAVAILABLE while the key is missing).
    pub fn check_key(&self) -> Result<()> {
        self.usable()?;
        // The probed key is wiped as it is dropped.
        current_key(self.options).map(drop)
    }
}

/// Hold the record's lock for all of `work`, so a caller can decide, read, set up and write in one
/// critical section. A caller that also holds another lock always takes that one first. The handle
/// stops working after a failed write.
pub fn with_secret_store<T, E: From<Error>>(
    options: &SecretRecordOptions,
    work: impl FnOnce(&mut SecretStore) -> std::result::Result<T, E>,
) -> std::result::Result<T, E> {
    check_options(options)?;
    // Before the lock: a refused store gets no lock directory. The record's directory is made and
    // excluded from backups here, before any record or marker is written in it.
    check_store_paths(&StorePaths {
        directories: &store_directories(&options.path),
        create: true,
        ..StorePaths::default()
    })?;
    exclude_from_backups(&[parent(&options.path)], false)?;
    let lock = LockOptions {
        cancel: options.cancel.clone(),
        wait: options.wait,
    };

    with_file_lock(&options.path, &lock, || {
        work(&mut SecretStore {
            options,
            ended: None,
            state: None,
        })
    })
}

/// Run `update` on the decrypted record while holding the record's lock, and store its result as
/// the next generation. Returns the stored plaintext, or `None` when the store holds no record.
pub fn with_secret_record<E: From<Error>>(
    options: &SecretRecordOptions,
    update: impl FnOnce(Option<&str>) -> std::result::Result<Option<String>, E>,
) -> std::result::Result<Option<String>, E> {
    with_secret_store(options, |held| held.update(update))
}

/// Read the record; a store that conclusively holds none is SECRET_NOT_FOUND.
pub fn read_secret_record(options: &SecretRecordOptions) -> Result<String> {
    with_secret_record(options, |_| Ok::<_, Error>(None))?.ok_or_else(|| {
        Error::new(
            Code::SecretNotFound,
            "No secret is stored for this profile.",
        )
    })
}

/// [`SecretStore::create_key`] under its own lock hold.
pub fn create_secret_key(options: &SecretRecordOptions) -> Result<()> {
    with_secret_store(options, |held| held.create_key())
}

/// What the startup preflight found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoreCheck {
    /// A marker exists at the store's path.
    pub exists: bool,
    /// The `retired` files that exist and are shown to be separate from the current store: an
    /// earlier layout to clean up after a new sign-in. An old entry that cannot be followed is
    /// left out here, although it still makes the store decide.
    pub retired: Vec<PathBuf>,
}

/// Startup preflight: refuse unsafe store directories and files before serving, with an
/// UNSAFE_FILE error whose `path()` names what to fix. It checks the store directories, the
/// directories above them, and the key, record and marker files (macOS ACLs included), and passes
/// when nothing exists yet. On macOS it then confirms the Time Machine exclusion of the existing
/// store directories, applying it again when it was lost. It reads no secret, takes no lock and
/// creates nothing. A key with the recognised second name of an interrupted publication passes;
/// its next `get_key` removes that name.
pub fn check_secret_store(options: &SecretRecordOptions) -> Result<StoreCheck> {
    let path = options.path.as_path();
    let key = options.keys.key_file();
    let mut directories = store_directories(path);

    for directory in key.map(store_directories).unwrap_or_default() {
        if !directories.contains(&directory) {
            directories.push(directory);
        }
    }
    let mut files: Vec<PathBuf> = key.map(Path::to_path_buf).into_iter().collect();
    files.extend([path.to_path_buf(), marker_path(path)]);
    let allow_link = |file: &Path, info: &fs::Metadata| -> Result<bool> {
        Ok(Some(file) == key && key_temporary(file, info)?.is_some())
    };
    check_store_paths(&StorePaths {
        directories: &directories,
        files: &files,
        create: false,
        allow_link: Some(&allow_link),
    })?;
    // An existing store's exclusion is applied again if it was lost; missing directories wait.
    let mut excluded = vec![parent(path)];
    excluded.extend(key.map(parent));
    exclude_from_backups(&excluded, true)?;

    Ok(StoreCheck {
        exists: secret_store_exists(path)?,
        retired: leftovers(options)?.named,
    })
}

/// The `retired` files that exist, split by use.
struct Leftovers {
    /// Every one not shown to be the current store's record, marker, lock or key under another
    /// name: an old entry whose link or metadata cannot be followed still decides, so a broken old
    /// store never lets an older plaintext credential back in.
    deciding: Vec<PathBuf>,
    /// Only those shown to be separate files, safe to name in a cleanup command.
    named: Vec<PathBuf>,
}

/// The current files are protected by canonical directory entry (the resolved directory plus the
/// file name), which an atomic save leaves unchanged, and by device and inode for any other alias.
/// A name followed through its links to a current entry is that entry. When the current files
/// cannot be read, nothing is named and every old entry decides.
fn leftovers(options: &SecretRecordOptions) -> Result<Leftovers> {
    let found = existing_paths(&options.retired)?;

    if found.is_empty() {
        return Ok(Leftovers {
            deciding: Vec::new(),
            named: Vec::new(),
        });
    }
    let path = options.path.as_path();
    let mut current = vec![
        path.to_path_buf(),
        marker_path(path),
        suffixed(path, ".lock"),
    ];
    current.extend(options.keys.key_file().map(Path::to_path_buf));
    let mut entries = Vec::new();
    let mut identities = Vec::new();

    for file in &current {
        match (directory_entry(file), identity(file)) {
            (Ok(entry), Ok(id)) => {
                entries.extend(entry);
                identities.extend(id);
            }
            _ => {
                return Ok(Leftovers {
                    deciding: found,
                    named: Vec::new(),
                });
            }
        }
    }
    let mut leftovers = Leftovers {
        deciding: Vec::new(),
        named: Vec::new(),
    };

    for file in found {
        // None when the name cannot be followed: gone, dangling, unreadable or looping.
        let entry = linked_entry(&file).ok();
        let id = identity(&file).ok().flatten();

        if entry.as_ref().is_some_and(|entry| entries.contains(entry))
            || id.is_some_and(|id| identities.contains(&id))
        {
            continue;
        }

        if entry.is_some() && id.is_some() {
            leftovers.named.push(file.clone());
        }
        leftovers.deciding.push(file);
    }
    Ok(leftovers)
}

/// The resolved directory plus the file name; `None` when the directory does not exist.
fn directory_entry(path: &Path) -> std::io::Result<Option<PathBuf>> {
    let name = path.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;

    match fs::canonicalize(parent(path)) {
        Ok(directory) => Ok(Some(directory.join(name))),
        Err(error) if errno(&error) == Some(Errno::NOENT) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The directory entry `path` reaches after its links, by `lstat` and `readlink`: never opened.
fn linked_entry(path: &Path) -> std::io::Result<PathBuf> {
    let mut entry = path.to_path_buf();

    for _ in 0..=MAX_LINKS {
        let name = entry.file_name().ok_or(std::io::ErrorKind::InvalidInput)?;
        entry = fs::canonicalize(parent(&entry))?.join(name);

        if !fs::symlink_metadata(&entry)?.is_symlink() {
            return Ok(entry);
        }
        entry = parent(&entry).join(fs::read_link(&entry)?);
    }
    Err(std::io::ErrorKind::InvalidInput.into())
}

/// Device and inode of what `path` names, following links; `None` when nothing is there.
fn identity(path: &Path) -> std::io::Result<Option<(u64, u64)>> {
    use std::os::unix::fs::MetadataExt;

    match fs::metadata(path) {
        Ok(info) => Ok(Some((info.dev(), info.ino()))),
        Err(error) if errno(&error) == Some(Errno::NOENT) => Ok(None),
        Err(error) => Err(error),
    }
}

/// The paths that exist, by `lstat` only: nothing is followed, opened or read.
pub fn existing_paths(paths: &[PathBuf]) -> Result<Vec<PathBuf>> {
    let mut found = Vec::new();

    for path in paths {
        if exists(path)? {
            found.push(path.clone());
        }
    }
    Ok(found)
}

/// A marker exists, so the store decides even while it holds no record.
pub fn secret_store_exists(path: &Path) -> Result<bool> {
    exists(&marker_path(path))
}

fn is_name_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

/// Server, profile and key names: 1-64 letters, digits, dots, dashes or underscores, starting
/// with a letter or digit.
pub(crate) fn check_names(names: &[&str]) -> Result<()> {
    for name in names {
        let bytes = name.as_bytes();

        if bytes.len() > 64
            || !bytes.first().is_some_and(u8::is_ascii_alphanumeric)
            || !bytes.iter().copied().all(is_name_byte)
        {
            return Err(Error::invalid(
                "Store names must be 1-64 letters, digits, dots, dashes or underscores.",
            ));
        }
    }
    Ok(())
}

fn check_options(options: &SecretRecordOptions) -> Result<()> {
    let keys = &options.keys;

    check_names(&[
        &options.server,
        &options.profile,
        &options.purpose,
        keys.backend(),
        keys.key_source(),
        keys.key_id(),
    ])?;

    if options.schema < 1 || options.schema > MAX_INTEGER {
        return Err(Error::invalid(
            "schema must be a positive integer of at most 15 digits.",
        ));
    }
    Ok(())
}

fn check_generation_left(marker: Option<&Marker>) -> Result<()> {
    if marker.is_some_and(|marker| marker.generation >= MAX_INTEGER) {
        return Err(Error::new(
            Code::StoreError,
            "The secret store has no generation left.",
        ));
    }
    Ok(())
}

/// The key, after a store of the retired Keychain accessor is refused.
fn current_key(options: &SecretRecordOptions) -> Result<Key> {
    refuse_retired(options)?;
    options.keys.get_key(&options.cancel)
}

/// STORE_BACKEND_RETIRED when the marker names the retired Keychain accessor, before any key is
/// asked for. Only the marker's key source is read here; every other marker problem is left to
/// `read_marker`.
fn refuse_retired(options: &SecretRecordOptions) -> Result<()> {
    if options.keys.key_source() == RETIRED_KEY_SOURCE {
        return Ok(());
    }
    let text = match read_private_bytes(&marker_path(&options.path), MARKER_MAX_BYTES) {
        Ok(text) => text,
        Err(error) if error.code == Code::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };

    match parse_marker(&text) {
        Some((_, RETIRED_KEY_SOURCE, ..)) => Err(retired_backend()),
        _ => Ok(()),
    }
}

/// True only for STORE_UNAVAILABLE; a readable key is false and every other failure propagates.
fn key_missing(options: &SecretRecordOptions) -> Result<bool> {
    match options.keys.get_key(&options.cancel) {
        // The probed key is wiped as it is dropped.
        Ok(_) => Ok(false),
        Err(error) if error.code == Code::StoreUnavailable => Ok(true),
        Err(error) => Err(error),
    }
}

fn load(options: &SecretRecordOptions, key: &Key) -> Result<(Option<Vec<u8>>, Option<Marker>)> {
    let marker = read_marker(options)?;
    let record = read_record(options, key)?;

    let Some(marker) = marker else {
        // The first write records a pending marker before its record, so a lone record is suspect.
        return match record {
            Some(_) => Err(uncertain()),
            None => Ok((None, None)),
        };
    };

    // Only committed writes mark a store migrated, and every committed generation is at least 1.
    if marker.migrated != (marker.generation > 0) {
        return Err(uncertain());
    }

    if let Some((pending, nonce)) = &marker.pending {
        if *pending != marker.generation + 1 {
            return Err(uncertain());
        }

        return match record {
            // A record at the announced generation and nonce is the interrupted write: commit it.
            Some(record) if record.generation == *pending && record.nonce == *nonce => {
                let committed = Marker {
                    migrated: true,
                    generation: record.generation,
                    pending: None,
                };
                write_marker(options, &committed)?;
                Ok((Some(record.plaintext), Some(committed)))
            }
            // The lock never expires a live holder, so a record still at the committed generation
            // (or still absent before a first write) means that write never committed and cannot
            // land later.
            Some(record) if record.generation == marker.generation => {
                let kept = Marker {
                    pending: None,
                    ..marker
                };
                write_marker(options, &kept)?;
                Ok((Some(record.plaintext), Some(kept)))
            }
            None if marker.generation == 0 => {
                let kept = Marker {
                    pending: None,
                    ..marker
                };
                write_marker(options, &kept)?;
                Ok((None, Some(kept)))
            }
            _ => Err(uncertain()),
        };
    }

    match record {
        // Only a first write that never committed leaves a generation-0 marker without a record.
        None if marker.generation == 0 => Ok((None, Some(marker))),
        Some(record) if record.generation == marker.generation => {
            Ok((Some(record.plaintext), Some(marker)))
        }
        _ => Err(uncertain()),
    }
}

fn store(
    options: &SecretRecordOptions,
    key: &Key,
    marker: Option<&Marker>,
    next: &str,
) -> Result<Marker> {
    let plaintext = next.as_bytes();

    if plaintext.len() > options.max_bytes {
        return Err(Error::new(
            Code::TooLarge,
            "The secret is larger than allowed.",
        ));
    }
    let generation = marker.map_or(0, |marker| marker.generation) + 1;
    let (nonce, text) = seal(options, key, generation, plaintext)?;

    let committed = Marker {
        migrated: true,
        generation,
        pending: None,
    };

    // Until the pending marker is renamed into place nothing has changed.
    write_marker(
        options,
        &Marker {
            migrated: marker.is_some_and(|marker| marker.migrated),
            generation: generation - 1,
            pending: Some((generation, nonce.clone())),
        },
    )?;

    let landed = (|| {
        write_private_file(&options.path, text.as_bytes(), &Cancel::default())?;

        match read_record(options, key)? {
            Some(written)
                if written.generation == generation
                    && written.nonce == nonce
                    && written.plaintext == plaintext =>
            {
                write_marker(options, &committed)
            }
            _ => Err(uncertain()),
        }
    })();

    match landed {
        Ok(()) => Ok(committed),
        Err(error) if error.code == Code::StoreWriteUncertain => Err(error),
        Err(error) => Err(Error::caused(Code::StoreWriteUncertain, UNCERTAIN, error)),
    }
}

/// Key order is fixed: these exact bytes are the authenticated data.
fn header(options: &SecretRecordOptions, generation: u64, nonce: &str) -> String {
    format!(
        r#"{{"v":1,"server":"{}","profile":"{}","purpose":"{}","schema":{},"generation":{generation},"keyId":"{}","nonce":"{nonce}"}}"#,
        options.server,
        options.profile,
        options.purpose,
        options.schema,
        options.keys.key_id(),
    )
}

/// Returns the nonce as text and the whole record file.
fn seal(
    options: &SecretRecordOptions,
    key: &Key,
    generation: u64,
    plaintext: &[u8],
) -> Result<(String, String)> {
    let nonce = random::<NONCE_BYTES>()?;
    let nonce_text = URL_SAFE_NO_PAD.encode(nonce);
    let header = header(options, generation, &nonce_text);
    // Ciphertext followed by the 16-byte tag, as the TypeScript package concatenates them.
    let body = Aes256Gcm::new(key.bytes().into())
        .encrypt(
            &Nonce::from(nonce),
            Payload {
                msg: plaintext,
                aad: header.as_bytes(),
            },
        )
        .map_err(|_| Error::new(Code::StoreError, "The secret could not be encrypted."))?;
    let text = format!("{header}\n{}\n", URL_SAFE_NO_PAD.encode(body));

    Ok((nonce_text, text))
}

/// Authenticate a record and check every binding before any plaintext leaves this function.
fn open_record(options: &SecretRecordOptions, key: &Key, text: &[u8]) -> Option<OpenedRecord> {
    let lines = text.strip_suffix(b"\n")?;
    let split = lines.iter().position(|byte| *byte == b'\n')?;
    let (header_line, body) = (&lines[..split], &lines[split + 1..]);
    let mut scan = Scan(header_line);
    scan.literal(r#"{"v":1,"server":""#)?;
    let server = scan.name()?;
    scan.literal(r#"","profile":""#)?;
    let profile = scan.name()?;
    scan.literal(r#"","purpose":""#)?;
    let purpose = scan.name()?;
    scan.literal(r#"","schema":"#)?;
    let schema = scan.integer()?;
    scan.literal(r#","generation":"#)?;
    let generation = scan.integer()?;
    scan.literal(r#","keyId":""#)?;
    let key_id = scan.name()?;
    scan.literal(r#"","nonce":""#)?;
    let nonce = scan.nonce()?;
    scan.literal(r#""}"#)?;

    if !scan.0.is_empty()
        || server != options.server
        || profile != options.profile
        || purpose != options.purpose
        || schema != options.schema
        || key_id != options.keys.key_id()
        || generation < 1
    {
        return None;
    }
    // The decoder refuses padding, other alphabets and non-canonical trailing bits.
    let sealed = URL_SAFE_NO_PAD.decode(body).ok()?;

    if sealed.len() < TAG_BYTES || sealed.len() > options.max_bytes.saturating_add(TAG_BYTES) {
        return None;
    }
    let nonce_bytes: [u8; NONCE_BYTES] = URL_SAFE_NO_PAD.decode(nonce).ok()?.try_into().ok()?;
    let plaintext = Aes256Gcm::new(key.bytes().into())
        .decrypt(
            &Nonce::from(nonce_bytes),
            Payload {
                msg: &sealed,
                aad: header_line,
            },
        )
        .ok()?;

    Some(OpenedRecord {
        generation,
        nonce: nonce.to_owned(),
        plaintext,
    })
}

fn read_record(options: &SecretRecordOptions, key: &Key) -> Result<Option<OpenedRecord>> {
    // Header, separator, unpadded base64url of ciphertext and tag, final newline. Saturating: a
    // limit too large to count in bytes is no limit, as in TypeScript's floating point.
    let max_bytes = (options.max_bytes.saturating_add(TAG_BYTES))
        .saturating_mul(4)
        .div_ceil(3)
        .saturating_add(HEADER_MAX_BYTES + 2);

    match read_private_bytes(&options.path, max_bytes) {
        Ok(text) => open_record(options, key, &text).map(Some).ok_or_else(|| {
            Error::new(
                Code::StoreError,
                "The stored secret could not be authenticated with the configured key.",
            )
        }),
        Err(error) if error.code == Code::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn read_marker(options: &SecretRecordOptions) -> Result<Option<Marker>> {
    let text = match read_private_bytes(&marker_path(&options.path), MARKER_MAX_BYTES) {
        Ok(text) => text,
        Err(error) if error.code == Code::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let keys = &options.keys;
    let (backend, key_source, key_id, profile, marker) = parse_marker(&text)
        .ok_or_else(|| Error::new(Code::StoreError, "The secret store marker is malformed."))?;

    // Set up by an earlier build through security(1), which no server runs any more.
    if key_source == RETIRED_KEY_SOURCE && keys.key_source() != RETIRED_KEY_SOURCE {
        return Err(retired_backend());
    }

    if backend != keys.backend()
        || key_source != keys.key_source()
        || key_id != keys.key_id()
        || profile != options.profile
    {
        return Err(Error::new(
            Code::StoreError,
            "The secret store marker does not match the configured key or profile.",
        ));
    }
    Ok(Some(marker))
}

fn parse_marker(text: &[u8]) -> Option<(&str, &str, &str, &str, Marker)> {
    let mut scan = Scan(text);
    scan.literal(r#"{"backend":""#)?;
    let backend = scan.name()?;
    scan.literal(r#"","keySource":""#)?;
    let key_source = scan.name()?;
    scan.literal(r#"","keyId":""#)?;
    let key_id = scan.name()?;
    scan.literal(r#"","profile":""#)?;
    let profile = scan.name()?;
    scan.literal(r#"","migrated":"#)?;
    let migrated = if scan.literal("true").is_some() {
        true
    } else {
        scan.literal("false")?;
        false
    };
    scan.literal(r#","generation":"#)?;
    let generation = scan.integer()?;
    let mut pending = None;

    if scan.literal(r#","pending":{"generation":"#).is_some() {
        let generation = scan.integer()?;
        scan.literal(r#","nonce":""#)?;
        pending = Some((generation, scan.nonce()?.to_owned()));
        scan.literal(r#""}"#)?;
    }
    scan.literal("}\n")?;

    scan.0.is_empty().then_some((
        backend,
        key_source,
        key_id,
        profile,
        Marker {
            migrated,
            generation,
            pending,
        },
    ))
}

fn write_marker(options: &SecretRecordOptions, marker: &Marker) -> Result<()> {
    let keys = &options.keys;
    let pending = marker
        .pending
        .as_ref()
        .map_or(String::new(), |(generation, nonce)| {
            format!(r#","pending":{{"generation":{generation},"nonce":"{nonce}"}}"#)
        });
    let text = format!(
        r#"{{"backend":"{}","keySource":"{}","keyId":"{}","profile":"{}","migrated":{},"generation":{}{pending}}}"#,
        keys.backend(),
        keys.key_source(),
        keys.key_id(),
        options.profile,
        marker.migrated,
        marker.generation,
    );

    write_private_file(
        &marker_path(&options.path),
        format!("{text}\n").as_bytes(),
        &Cancel::default(),
    )
}

/// Headers and markers are canonical JSON over restricted names, so a strict scan parses them the
/// way the TypeScript package's anchored patterns do.
struct Scan<'a>(&'a [u8]);

impl<'a> Scan<'a> {
    fn literal(&mut self, text: &str) -> Option<()> {
        self.0 = self.0.strip_prefix(text.as_bytes())?;
        Some(())
    }

    fn take(&mut self, length: usize) -> Option<&'a str> {
        let (taken, rest) = self.0.split_at_checked(length)?;
        self.0 = rest;
        std::str::from_utf8(taken).ok()
    }

    fn name(&mut self) -> Option<&'a str> {
        let length = self
            .0
            .iter()
            .take(64)
            .take_while(|byte| is_name_byte(**byte))
            .count();

        self.0.first()?.is_ascii_alphanumeric().then_some(())?;
        self.take(length)
    }

    /// `0`, or up to 15 digits without a leading zero.
    fn integer(&mut self) -> Option<u64> {
        let digits = self
            .0
            .iter()
            .take(15)
            .take_while(|byte| byte.is_ascii_digit())
            .count();
        let length = if self.0.first() == Some(&b'0') {
            1
        } else {
            digits
        };

        self.take(length)?.parse().ok()
    }

    /// Twelve bytes as 16 unpadded base64url characters.
    fn nonce(&mut self) -> Option<&'a str> {
        self.take(16).filter(|nonce| {
            nonce
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
    }
}

fn marker_path(path: &Path) -> PathBuf {
    suffixed(path, ".marker")
}

fn exists(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if errno(&error) == Some(Errno::NOENT) => Ok(false),
        Err(error) => Err(Error::io(
            error,
            "Cannot inspect the secret store. Check its permissions.",
        )),
    }
}

fn retired_backend() -> Error {
    Error::new(
        Code::StoreBackendRetired,
        "This store is a leftover of an earlier test build that kept its key in the macOS Keychain, which is no longer used. Remove session.enc and session.enc.marker from the server's folder in ~/Library/Application Support/family-mcp, then sign in again.",
    )
}

const UNCERTAIN: &str =
    "The last write to the secret store did not complete consistently; its secret is not used.";

fn uncertain() -> Error {
    Error::new(Code::StoreWriteUncertain, UNCERTAIN)
}
