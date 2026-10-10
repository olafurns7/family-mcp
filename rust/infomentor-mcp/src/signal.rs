//! `AbortSignal` as the TypeScript client combines them: stop controllers (the client's lifetime,
//! a setup operation) and deadlines (`AbortSignal.timeout`), merged with `AbortSignal.any`.

use std::future::{Future, poll_fn, ready};
use std::pin::Pin;
use std::task::Poll;
use std::time::Duration;

use family_store::Cancel;
use tokio::runtime::Handle;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::error::{CANCELLED, Result};

#[derive(Clone, Default)]
pub struct Signal {
    stops: Vec<watch::Receiver<bool>>,
    deadline: Option<Instant>,
}

/// An `AbortController`.
pub struct Controller(watch::Sender<bool>);

impl Default for Controller {
    fn default() -> Self {
        Self(watch::channel(false).0)
    }
}

impl Controller {
    pub fn signal(&self) -> Signal {
        Signal {
            stops: vec![self.0.subscribe()],
            deadline: None,
        }
    }

    pub fn abort(&self) {
        self.0.send_replace(true);
    }

    #[expect(dead_code, reason = "setup status uses it from slice 4")]
    pub fn aborted(&self) -> bool {
        *self.0.borrow()
    }
}

impl Signal {
    /// `AbortSignal.any([this, other])`.
    pub fn any(&self, other: &Signal) -> Signal {
        let mut stops = self.stops.clone();
        stops.extend(other.stops.iter().cloned());
        let deadline = match (self.deadline, other.deadline) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        };
        Signal { stops, deadline }
    }

    /// `AbortSignal.timeout(duration)`, alone.
    pub fn timeout(duration: Duration) -> Signal {
        Signal {
            stops: Vec::new(),
            deadline: Some(Instant::now() + duration),
        }
    }

    pub fn aborted(&self) -> bool {
        self.stops.iter().any(|stop| *stop.borrow())
            || self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
    }

    /// `throwIfAborted`.
    pub fn check(&self) -> Result<()> {
        match self.aborted() {
            true => Err(CANCELLED),
            false => Ok(()),
        }
    }

    /// Resolves once the signal aborts. A dropped controller never aborts it.
    pub async fn cancelled(&self) {
        let mut stops = self.stops.clone();
        let mut waits: Vec<Pin<Box<dyn Future<Output = ()> + Send + '_>>> = stops
            .iter_mut()
            .map(|stop| {
                Box::pin(async move {
                    if stop.wait_for(|stopped| *stopped).await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }) as Pin<Box<dyn Future<Output = ()> + Send + '_>>
            })
            .collect();
        let stopped = poll_fn(|context| {
            match waits
                .iter_mut()
                .any(|wait| wait.as_mut().poll(context).is_ready())
            {
                true => Poll::Ready(()),
                false => Poll::Pending,
            }
        });
        let deadline = async {
            match self.deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };

        tokio::select! {
            () = stopped => {}
            () = deadline => {}
        }
    }

    /// `future`, unless the signal aborts first.
    pub async fn wait<F: Future>(&self, future: F) -> Option<F::Output> {
        if self.aborted() {
            return None;
        }

        tokio::select! {
            biased;
            () = self.cancelled() => None,
            output = future => Some(output),
        }
    }

    /// The store's cancel flag, set once this signal aborts, for lock waits and writes.
    pub fn store_cancel(&self, handle: &Handle) -> Bridge {
        let cancel = Cancel::default();

        if self.aborted() {
            cancel.cancel();
        }
        let (signal, flag) = (self.clone(), cancel.clone());
        let task = match self.stops.is_empty() && self.deadline.is_none() {
            true => handle.spawn(ready(())),
            false => handle.spawn(async move {
                signal.cancelled().await;
                flag.cancel();
            }),
        };
        Bridge { cancel, task }
    }
}

/// A [`Signal`] as the store's [`Cancel`]; dropping it stops watching.
pub struct Bridge {
    pub cancel: Cancel,
    task: JoinHandle<()>,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn signals_abort_on_any_stop_or_deadline() {
        let controller = Controller::default();
        let signal = controller
            .signal()
            .any(&Signal::timeout(Duration::from_secs(60)));
        assert!(!signal.aborted() && signal.check().is_ok());
        assert_eq!(signal.wait(async { 1 }).await, Some(1));
        controller.abort();
        assert!(signal.aborted() && signal.check().is_err());
        assert_eq!(signal.wait(std::future::pending::<()>()).await, None);

        let short = Signal::timeout(Duration::from_millis(20));
        assert_eq!(short.wait(std::future::pending::<()>()).await, None);
        assert!(short.aborted());

        // A dropped controller never aborts.
        let dropped = Controller::default().signal();
        assert!(!dropped.aborted());
        let bridge = Signal::timeout(Duration::from_millis(20)).store_cancel(&Handle::current());
        tokio::time::sleep(Duration::from_millis(60)).await;
        assert!(bridge.cancel.is_cancelled());
    }
}
