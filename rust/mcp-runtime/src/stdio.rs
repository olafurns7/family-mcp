//! `startStdio`: serve over stdio until stdin ends or SIGINT or SIGTERM arrives, then close.

use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use rmcp::ServiceExt;
use tokio::io::{AsyncRead, ReadBuf};
use tokio::signal::unix::{SignalKind, signal};

use crate::server::{Handler, Server};

/// Standard input that tells the server where it ends, as the TypeScript server closes on `end`
/// instead of letting requests in flight finish.
struct Input<S> {
    stdin: tokio::io::Stdin,
    server: Arc<S>,
}

impl<S: Server> AsyncRead for Input<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        context: &mut Context<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let before = buffer.filled().len();
        let polled = Pin::new(&mut self.stdin).poll_read(context, buffer);

        if matches!(polled, Poll::Ready(Ok(())))
            && buffer.filled().len() == before
            && buffer.remaining() > 0
        {
            self.server.stdin_ended();
        }
        polled
    }
}

/// Serve until stdin ends or SIGINT or SIGTERM arrives, then wait for the server's `close`.
/// Fails, before serving and without closing, only when the signal handler cannot be installed.
pub async fn serve_stdio<S: Server>(server: S) -> std::io::Result<()> {
    let server = Arc::new(server);
    let mut terminate = signal(SignalKind::terminate())?;

    tokio::select! {
        _ = async {
            let input = Input { stdin: tokio::io::stdin(), server: server.clone() };

            if let Ok(running) = Handler::new(server.clone())
                .serve((input, tokio::io::stdout()))
                .await
            {
                let _ = running.waiting().await;
            }
        } => {}
        _ = tokio::signal::ctrl_c() => {}
        _ = terminate.recv() => {}
    }
    server.close().await;
    Ok(())
}
