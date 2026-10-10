//! One sequential renewal timer per stdio connection. The first delay is chosen by the caller;
//! each completed tick chooses the next delay. Closing the connection cancels the tick in flight.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::signal::{Controller, Signal};

pub const MAX_RENEWAL_AGE: Duration = Duration::from_secs(30 * 60);

pub fn max_renewal_age() -> Duration {
    #[cfg(feature = "test-origin")]
    if let Ok(milliseconds) = std::env::var("INNA_TEST_RENEWAL_MS") {
        return Duration::from_millis(
            milliseconds
                .parse::<u64>()
                .ok()
                .filter(|ms| *ms >= 30)
                .expect("INNA_TEST_RENEWAL_MS must be at least 30."),
        );
    }
    MAX_RENEWAL_AGE
}

pub fn interval(optional_touches: bool) -> Duration {
    max_renewal_age() / 3 * if optional_touches { 1 } else { 2 }
}

pub fn retry_interval() -> Duration {
    max_renewal_age() / 30
}

pub struct KeepAlive {
    stopped: Controller,
    /// Ticks now; only tests and a test build's SIGUSR1 use it.
    #[cfg(any(test, feature = "test-origin"))]
    fire: Arc<Notify>,
}

impl KeepAlive {
    /// Run `tick` after `first`, then after its returned delay; `stop` aborts its signal.
    pub fn start<F, T>(first: Duration, tick: F) -> Self
    where
        F: Fn(Signal) -> T + Send + 'static,
        T: Future<Output = Duration> + Send + 'static,
    {
        let stopped = Controller::default();
        let fire = Arc::new(Notify::new());
        let (signal, fired) = (stopped.signal(), fire.clone());

        tokio::spawn(async move {
            let mut next = first;
            loop {
                tokio::select! {
                    biased;
                    () = signal.cancelled() => break,
                    () = tokio::time::sleep(next) => {}
                    () = fired.notified() => {}
                }
                next = tick(signal.clone()).await;
            }
        });
        Self {
            stopped,
            #[cfg(any(test, feature = "test-origin"))]
            fire,
        }
    }

    /// Tick now, as the timer would.
    #[cfg(test)]
    pub fn fire(&self) {
        self.fire.notify_one();
    }

    /// What ticks now when notified: a test build's SIGUSR1.
    #[cfg(feature = "test-origin")]
    pub fn fire_handle(&self) -> Arc<Notify> {
        self.fire.clone()
    }

    /// Cancel the timer and abort the tick in flight. Final.
    pub fn stop(&self) {
        self.stopped.abort();
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn production_durations_are_thirty_ten_twenty_and_one_minute() {
        assert!(std::env::var_os("INNA_TEST_RENEWAL_MS").is_none());
        assert_eq!(max_renewal_age(), Duration::from_secs(30 * 60));
        assert_eq!(interval(true), Duration::from_secs(10 * 60));
        assert_eq!(interval(false), Duration::from_secs(20 * 60));
        assert_eq!(retry_interval(), Duration::from_secs(60));
    }

    async fn turn(milliseconds: u64) {
        tokio::time::sleep(Duration::from_millis(milliseconds)).await;
    }

    #[tokio::test]
    async fn the_timer_waits_one_interval_and_stops_firing_after_stop() {
        let runs = Arc::new(AtomicUsize::new(0));
        let counted = runs.clone();
        let keep_alive = KeepAlive::start(Duration::from_millis(40), move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            async { Duration::from_millis(40) }
        });
        turn(10).await;
        assert_eq!(runs.load(Ordering::SeqCst), 0);
        turn(60).await;
        assert!(runs.load(Ordering::SeqCst) >= 1);
        keep_alive.stop();
        turn(10).await;
        let stopped = runs.load(Ordering::SeqCst);
        turn(100).await;
        assert_eq!(runs.load(Ordering::SeqCst), stopped);
    }

    #[tokio::test]
    async fn ticks_never_overlap_and_stop_aborts_the_tick_in_flight() {
        let started = Arc::new(AtomicUsize::new(0));
        let aborted = Arc::new(AtomicUsize::new(0));
        let (counted, seen) = (started.clone(), aborted.clone());
        let keep_alive = KeepAlive::start(Duration::from_secs(600), move |signal| {
            counted.fetch_add(1, Ordering::SeqCst);
            let seen = seen.clone();
            async move {
                signal.cancelled().await;
                seen.fetch_add(1, Ordering::SeqCst);
                Duration::from_secs(600)
            }
        });
        keep_alive.fire();
        turn(10).await;
        keep_alive.fire();
        turn(10).await;
        keep_alive.fire();
        turn(10).await;
        assert_eq!(started.load(Ordering::SeqCst), 1);
        assert_eq!(aborted.load(Ordering::SeqCst), 0);
        keep_alive.stop();
        turn(10).await;
        assert_eq!(aborted.load(Ordering::SeqCst), 1);
        keep_alive.fire();
        turn(10).await;
        assert_eq!(started.load(Ordering::SeqCst), 1);
    }
}
