//! `awsp-server`: reads one JSON config line on stdin, then JSON commands, one per line; writes
//! JSON events to stdout, one per line; logs to stderr. Never writes a secret to disk.

use std::io::Write;

use awsp_server::{Command, Config, Event, Server, ServerOptions};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    sync::mpsc,
};
use tracing::{error, info};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(EnvFilter::try_from_env("AWSP_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .init();

    let (events_tx, mut events_rx) = mpsc::unbounded_channel::<Event>();
    // The only writer of stdout: one JSON event per line, flushed as it goes.
    let writer = tokio::task::spawn_blocking(move || {
        let stdout = std::io::stdout();
        while let Some(event) = events_rx.blocking_recv() {
            let mut out = stdout.lock();
            if let Ok(line) = serde_json::to_string(&event) {
                let _ = writeln!(out, "{line}");
                let _ = out.flush();
            }
        }
    });

    let code = match run(events_tx).await {
        Ok(()) => 0,
        Err(e) => {
            error!("{e:#}");
            1
        }
    };
    let _ = writer.await;
    std::process::exit(code);
}

async fn run(events: mpsc::UnboundedSender<Event>) -> anyhow::Result<()> {
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let Some(first) = lines.next_line().await? else { anyhow::bail!("stdin closed before the config line") };
    let mut cfg = match Config::from_json_line(&first) {
        Ok(c) => c,
        Err(e) => {
            let _ = events.send(Event::Error { message: format!("{e:#}") });
            return Err(e);
        }
    };
    cfg.apply_env(|k| std::env::var(k).ok());

    let endpoint = match cfg.bind_endpoint().await {
        Ok(ep) => ep,
        Err(e) => {
            let _ = events.send(Event::Error { message: format!("{e:#}") });
            return Err(e);
        }
    };
    info!("awsp endpoint {} relay_only={}", endpoint.id(), cfg.relay_only);
    let server = Server::start(
        endpoint,
        ServerOptions {
            server_name: cfg.server_name.clone(),
            library_db: cfg.library_db.clone(),
            cache_dir: cfg.cache_dir.clone(),
            allowlist: cfg.allowlist.clone(),
            ffmpeg: None,
        },
        events.clone(),
    );
    let ready = server.ready_event(cfg.online_timeout()).await;
    let _ = events.send(ready);

    loop {
        match lines.next_line().await {
            Ok(Some(line)) if line.trim().is_empty() => continue,
            Ok(Some(line)) => match serde_json::from_str::<Command>(&line) {
                Ok(cmd) => {
                    if !server.command(cmd) {
                        break;
                    }
                }
                Err(e) => {
                    let _ = events.send(Event::Error { message: format!("bad command: {e}") });
                }
            },
            // stdin closed: the supervisor is gone, so stop too.
            Ok(None) | Err(_) => break,
        }
    }
    info!("awsp shutting down");
    server.shutdown().await;
    Ok(())
}
