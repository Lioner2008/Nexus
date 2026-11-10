//! Nexus Server – accounts, chat rooms, direct messages and WebRTC call signaling.
//!
//!   nexus-server [--bind 127.0.0.1:7777] [--data ./nexus-data]
//!
//! Environment: NEXUS_BIND, NEXUS_DATA, and optionally NEXUS_TURN_URL / NEXUS_TURN_USER /
//! NEXUS_TURN_PASS to hand a TURN relay to the clients (needed for calls across strict NATs).
//!
//! Voice and video never pass through this server: it only forwards the WebRTC
//! offers/answers/ICE candidates, the audio and video flow peer-to-peer between the clients.

mod hub;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use hub::Hub;
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

type App = Arc<Hub>;

#[derive(Deserialize)]
struct Cred {
    username: String,
    password: String,
}

fn fail(code: u16, msg: String) -> Response {
    (StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), Json(json!({ "error": msg }))).into_response()
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(app.stats())
}

async fn register(State(app): State<App>, Json(c): Json<Cred>) -> Response {
    match app.register(c.username, c.password).await {
        Ok((token, user)) => Json(json!({ "token": token, "user": user })).into_response(),
        Err((code, msg)) => fail(code, msg),
    }
}

async fn login(State(app): State<App>, Json(c): Json<Cred>) -> Response {
    match app.login(c.username, c.password).await {
        Ok((token, user)) => Json(json!({ "token": token, "user": user })).into_response(),
        Err((code, msg)) => fail(code, msg),
    }
}

/// Lets the client check a remembered token on startup.
async fn me(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    match q.get("token").and_then(|t| app.user_for_token(t)) {
        Some(user) => Json(json!({ "user": user })).into_response(),
        None => fail(401, "Session expired, please log in again".into()),
    }
}

async fn logout(State(app): State<App>, Query(q): Query<HashMap<String, String>>) -> Response {
    if let Some(t) = q.get("token") {
        app.logout(t);
    }
    Json(json!({ "ok": true })).into_response()
}

/// Only reachable from this machine; used by the launcher's "Stop server" button.
async fn shutdown(State(app): State<App>, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    if !addr.ip().is_loopback() {
        return fail(403, "forbidden".into());
    }
    app.shutdown.notify_one();
    Json(json!({ "ok": true })).into_response()
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(user) = q.get("token").and_then(|t| app.user_for_token(t)) else {
        return fail(401, "Invalid session".into());
    };
    ws.max_message_size(256 * 1024)
        .on_upgrade(move |socket| socket_loop(app, socket, user))
}

async fn socket_loop(app: App, socket: WebSocket, user: String) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = app.register_conn(&user, tx);

    let writer = tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if sink.send(Message::Text(m)).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => app.on_message(id, &t),
            Message::Close(_) => break,
            _ => {}
        }
    }
    app.unregister_conn(id);
    writer.abort();
}

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let bind: SocketAddr = arg("--bind")
        .or_else(|| std::env::var("NEXUS_BIND").ok())
        .unwrap_or_else(|| "127.0.0.1:7777".into())
        .parse()
        .expect("invalid --bind address, e.g. 127.0.0.1:7777");
    let data = PathBuf::from(
        arg("--data")
            .or_else(|| std::env::var("NEXUS_DATA").ok())
            .unwrap_or_else(|| "nexus-data".into()),
    );

    let hub: App = Arc::new(Hub::load(data.clone()));

    // persist changes every couple of seconds
    let saver = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            saver.save_if_dirty();
        }
    });

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/me", get(me))
        .route("/api/logout", post(logout))
        .route("/api/admin/shutdown", post(shutdown))
        .route("/ws", get(ws_upgrade))
        .layer(CorsLayer::permissive())
        .with_state(hub.clone());

    let listener = match tokio::net::TcpListener::bind(bind).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("Nexus Server: cannot listen on {bind}: {e}");
            std::process::exit(1);
        }
    };
    println!("Nexus Server listening on http://{bind}  (data: {})", data.display());
    if !bind.ip().is_loopback() {
        println!("Note: listening on a non-local address – anyone who can reach this port can register.");
    }

    let stop = hub.clone();
    let shutdown_signal = async move {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = stop.shutdown.notified() => {},
        }
        println!("Nexus Server shutting down…");
    };

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal)
        .await
        .ok();
    hub.save_if_dirty();
}
