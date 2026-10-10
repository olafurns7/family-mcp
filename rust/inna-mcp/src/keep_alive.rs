//! packages/inna-mcp/src/keep-alive.ts's `startKeepAlive` for the one stdio connection: touches
//! the saved session on a fixed interval while the server runs. The first tick comes one interval
//! after start, ticks never overlap (one due while another runs is dropped), and nothing is
//! logged. `stop` is final and aborts the tick in flight. The TypeScript scheduler follows the
//! SDK's per-negotiation server instances; this server has one connection for its lifetime, so it
//! runs from start until the connection closes.

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
    /// Run `tick` every `interval`, with a signal that `stop` aborts.
    pub fn start<F, T>(interval: Duration, tick: F) -> Self
    where
        F: Fn(Signal) -> T + Send + 'static,
        T: Future<Output = Duration> + Send + 'static,
    {
        let stopped = Controller::default();
        let fire = Arc::new(Notify::new());
        let (signal, fired) = (stopped.signal(), fire.clone());

        tokio::spawn(async move {
            let mut next = interval;
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
