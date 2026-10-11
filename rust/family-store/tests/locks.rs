//! The lock cases of packages/session-store/test/lock.test.ts that tests/files_lock.rs does not
//! already make: waiting, a waiter's temporary under a holder's sweep, a replaced owner, and work
//! that never runs on a hard-linked target.

mod common;

use std::fs;
use std::sync::mpsc;
use std::time::{Duration, Instant, SystemTime};

use common::*;
use family_store::{Cancel, Code, Error, LockOptions, sweep_temp, with_file_lock};

fn waiting(wait: Duration) -> LockOptions {
    LockOptions {
        wait,
        ..LockOptions::default()
    }
}

/// Set a file's or folder's modification time ten minutes back, as utimes does.
fn age(path: &std::path::Path) {
    let old = SystemTime::now() - Duration::from_secs(600);
    fs::File::open(path).unwrap().set_modified(old).unwrap();
}

#[test]
fn waiters_poll_a_busy_lock_and_a_live_pid_never_expires_by_age() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    let lock = scratch.join("session.json.lock");
    let (entered, holding) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();

    let holder = {
        let file = file.clone();
        std::thread::spawn(move || {
            with_file_lock(&file, &LockOptions::default(), || {
                entered.send(()).unwrap();
                released.recv().unwrap();
                Ok::<_, Error>("held")
            })
        })
    };
    holding.recv().unwrap();

    let immediate = Instant::now();
    assert_eq!(
        code(with_file_lock(&file, &waiting(Duration::ZERO), || Ok::<
            _,
            Error,
        >(
            ()
        ))),
        Some(Code::Busy)
    );
    assert!(immediate.elapsed() < Duration::from_secs(1));

    let bounded = Instant::now();
    assert_eq!(
        code(with_file_lock(
            &file,
            &waiting(Duration::from_millis(200)),
            || { Ok::<_, Error>(()) }
        )),
        Some(Code::Busy)
    );
    let waited = bounded.elapsed();
    assert!(waited >= Duration::from_millis(150), "{waited:?}");
    assert!(waited < Duration::from_secs(3), "{waited:?}");

    // A cancel while waiting ends the wait.
    let cancel = Cancel::default();
    let cancelled = {
        let (file, cancel) = (file.clone(), cancel.clone());
        std::thread::spawn(move || {
            let options = LockOptions {
                cancel,
                wait: Duration::from_secs(10),
            };
            code(with_file_lock(&file, &options, || Ok::<_, Error>(())))
        })
    };
    std::thread::sleep(Duration::from_millis(50));
    cancel.cancel();
    assert_eq!(cancelled.join().unwrap(), Some(Code::Cancelled));

    // A waiter gets the lock once the holder releases it.
    let started = Instant::now();
    let waiter = {
        let file = file.clone();
        std::thread::spawn(move || {
            with_file_lock(&file, &waiting(Duration::from_secs(10)), || {
                Ok::<_, Error>("waited")
            })
        })
    };
    std::thread::sleep(Duration::from_millis(300));
    release.send(()).unwrap();
    assert_eq!(holder.join().unwrap().unwrap(), "held");
    assert_eq!(waiter.join().unwrap().unwrap(), "waited");
    let waited = started.elapsed();
    assert!(waited >= Duration::from_millis(250), "{waited:?}");
    assert!(waited < Duration::from_secs(5), "{waited:?}");
    assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 0);

    // A live PID stays busy however old its owner file is.
    let owner = format!(
        "{}-0b0e5cbb-7d1c-4d7a-9d0e-3f2a6c1b8e4f",
        std::process::id()
    );
    fs::create_dir(&lock).unwrap();
    fs::write(lock.join(&owner), "").unwrap();
    age(&lock.join(&owner));
    assert_eq!(
        code(with_file_lock(&file, &waiting(Duration::ZERO), || Ok::<
            _,
            Error,
        >(
            ()
        ))),
        Some(Code::Busy)
    );
    let left: Vec<_> = fs::read_dir(&lock)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, [std::ffi::OsString::from(owner)]);
}

#[test]
fn a_holders_sweep_leaves_an_old_live_waiters_lock_temporary_alone() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    let (entered, holding) = mpsc::channel();
    let (sweep_now, sweep) = mpsc::channel::<()>();
    let (swept, sweeping) = mpsc::channel();
    let (release, released) = mpsc::channel::<()>();

    let holder = {
        let file = file.clone();
        std::thread::spawn(move || {
            with_file_lock(&file, &LockOptions::default(), || {
                entered.send(()).unwrap();
                sweep.recv().unwrap();
                swept
                    .send(sweep_temp(&file, Duration::from_secs(300)))
                    .unwrap();
                released.recv().unwrap();
                Ok::<_, Error>(())
            })
        })
    };
    holding.recv().unwrap();
    let waiter = {
        let file = file.clone();
        std::thread::spawn(move || {
            with_file_lock(&file, &waiting(Duration::from_secs(10)), || {
                Ok::<_, Error>("waited")
            })
        })
    };

    // The waiter publishes its temporary before it polls.
    let mut temporary = None;

    for _ in 0..100 {
        temporary = fs::read_dir(&scratch.0)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("session.json.lock-tmp.")
            });

        if temporary.is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let temporary = temporary.expect("the waiter's lock temporary");
    age(&temporary);
    sweep_now.send(()).unwrap();
    assert_eq!(sweeping.recv().unwrap().unwrap(), 0);
    assert!(temporary.exists());

    release.send(()).unwrap();
    holder.join().unwrap().unwrap();
    assert_eq!(waiter.join().unwrap().unwrap(), "waited");
    assert_eq!(fs::read_dir(&scratch.0).unwrap().count(), 0);
}

#[test]
fn in_flight_lock_loss_is_reported_without_deleting_the_replacement_owner() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    let lock = scratch.join("session.json.lock");
    let replacement = format!(
        "{}-1b4e28ba-2fa1-41d2-883f-0016d3cca427",
        std::process::id()
    );

    let lost = with_file_lock(&file, &waiting(Duration::ZERO), || {
        assert_eq!(fs::read_dir(&lock).unwrap().count(), 1);
        fs::rename(&lock, scratch.join("session.json.lock.previous")).unwrap();
        fs::create_dir(&lock).unwrap();
        fs::write(lock.join(&replacement), "").unwrap();
        Ok::<_, Error>(())
    });
    assert_eq!(code(lost), Some(Code::LockLost));
    let left: Vec<_> = fs::read_dir(&lock)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(left, [std::ffi::OsString::from(replacement)]);
}

#[test]
fn hard_linked_targets_are_refused_before_any_work() {
    let scratch = Scratch::new();
    let file = scratch.join("session.json");
    write(&file, "private session");
    fs::hard_link(&file, scratch.join("alias.json")).unwrap();
    let mut ran = false;

    let refused = with_file_lock(&file, &waiting(Duration::ZERO), || {
        ran = true;
        Ok::<_, Error>(())
    });
    assert_eq!(code(refused), Some(Code::UnsafeFile));
    assert!(!ran);
    let mut left: Vec<_> = fs::read_dir(&scratch.0)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(left, ["alias.json", "session.json"]);
}
