//! `startStdio`: serve over stdio until stdin ends, the connection breaks, or SIGINT or SIGTERM
//! arrives, then close.

use std::os::fd::AsFd;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rmcp::ServiceExt;
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Notify;

use crate::server::{Handler, Server};

/// The TypeScript SDK's stdio read buffer (`STDIO_DEFAULT_MAX_BUFFER_SIZE`): it closes the
/// connection once the bytes it holds of a line, the newline included, would pass this.
const MAX_LINE: usize = 10 * 1024 * 1024;

/// Standard input that tells the server where it ends, as the TypeScript server closes on `end`
/// instead of letting requests in flight finish, and that breaks the connection on a line over
/// [`MAX_LINE`]. rmcp would buffer such a line without bound.
struct Input<S> {
    stdin: tokio::io::Stdin,
    server: Arc<S>,
    broken: Arc<Notify>,
    /// The bytes read of the current line, or more than [`MAX_LINE`] once it broke the
    /// connection.
    line: usize,
}

impl<S: Server> AsyncRead for Input<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        // Serving stops once the connection breaks; nothing more is read.
        if self.line > MAX_LINE {
            return Poll::Pending;
        }
        let before = buffer.filled().len();
        let polled = Pin::new(&mut self.stdin).poll_read(context, buffer);

        if !matches!(polled, Poll::Ready(Ok(()))) {
            return polled;
        }
        if buffer.filled().len() == before && buffer.remaining() > 0 {
            self.server.stdin_ended();
        }
        let mut line = self.line;

        for part in buffer.filled()[before..].split_inclusive(|byte| *byte == b'\n') {
            line += part.len();

            if line > MAX_LINE {
                self.line = line;
                self.broken.notify_one();
                buffer.set_filled(before);
                return Poll::Pending;
            }
            if part.ends_with(b"\n") {
                line = 0;
            }
        }
        self.line = line;
        polled
    }
}

/// Standard output that breaks the connection when a write fails, as the TypeScript SDK's
/// transport closes on stdout's `error`. rmcp only logs the failure and keeps serving.
///
/// It writes to its own copy of descriptor 1, not through `std::io::stdout`, which reports a
/// write to a descriptor that cannot be written (EBADF, such as a read-only file) as success.
struct Output {
    stdout: tokio::fs::File,
    broken: Arc<Notify>,
}

impl Output {
    fn watch<T>(&self, polled: Poll<std::io::Result<T>>) -> Poll<std::io::Result<T>> {
        if matches!(polled, Poll::Ready(Err(_))) {
            self.broken.notify_one();
        }
        polled
    }
}

impl AsyncWrite for Output {
    fn poll_write(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        let polled = Pin::new(&mut self.stdout).poll_write(context, buffer);
        self.watch(polled)
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let polled = Pin::new(&mut self.stdout).poll_flush(context);
        self.watch(polled)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
    ) -> Poll<std::io::Result<()>> {
        let polled = Pin::new(&mut self.stdout).poll_shutdown(context);
        self.watch(polled)
    }
}

/// Serve until stdin ends, the connection breaks, or SIGINT or SIGTERM arrives, then wait for
/// the server's `close`. The connection breaks, as the TypeScript SDK closes it, when a write to
/// stdout fails or an input line passes the SDK's 10 MiB read buffer; serving then stops at once,
/// as on a signal, which cancels the calls in flight, and nothing is written to stderr.
/// Without a descriptor 1 to copy, it closes at once without serving.
/// Fails, before serving and without closing, only when the signal handler cannot be installed.
///
/// The caller must end its runtime with `shutdown_background` after this returns, not with
/// `#[tokio::main]` or a drop: the stdin read may still block, and waiting for it keeps a
/// signalled process alive while the host holds stdin open. See the crate's entry point docs.
pub async fn serve_stdio<S: Server>(server: S) -> std::io::Result<()> {
    let server = Arc::new(server);
    let mut terminate = signal(SignalKind::terminate())?;
    let broken = Arc::new(Notify::new());
    let Ok(stdout) = std::io::stdout().as_fd().try_clone_to_owned() else {
        server.close().await;
        return Ok(());
    };
    let stdout = tokio::fs::File::from_std(std::fs::File::from(stdout));

    tokio::select! {
        _ = async {
            let input = Input {
                stdin: tokio::io::stdin(),
                server: server.clone(),
                broken: broken.clone(),
                line: 0,
            };
            let output = Output { stdout, broken: broken.clone() };

            if let Ok(running) = Handler::new(server.clone())
                .serve((input, output))
                .await
            {
                let _ = running.waiting().await;
            }
        } => {}
        _ = broken.notified() => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    server.close().await;
    Ok(())
}
