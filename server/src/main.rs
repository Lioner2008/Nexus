//! Nexus Server – accounts, chat rooms, direct messages and WebRTC call signaling.
//!
//!   nexus-server [--bind 127.0.0.1:7777] [--data ./nexus-data]
//!
//! Playing with friends in other networks:
//!
//!   nexus-server --bind 0.0.0.0:7777 --turn --upnp --invite SECRETCODE
//!
//!   --turn            built-in TURN relay (UDP 3478, relay ports 49160-49200) for calls behind strict NATs
//!   --upnp            ask the router to forward TCP 7777 and the TURN ports automatically
//!   --invite CODE     creating an account requires this code
//!   --public-ip IP    public address of this PC (found via UPnP when omitted)
//!   --turn-port N / --relay-min N / --relay-max N   change the relay ports
//!
//! Every option can also be set through the environment (the command line wins): NEXUS_BIND, NEXUS_DATA,
//! NEXUS_INVITE, NEXUS_TURN=1, NEXUS_UPNP=1, NEXUS_PUBLIC_IP, NEXUS_TURN_PORT, NEXUS_RELAY_MIN, NEXUS_RELAY_MAX.
//! NEXUS_TURN_URL / _USER / _PASS add an external TURN server. The Pterodactyl egg in pterodactyl/ uses
//! these variables. --public-ip / NEXUS_PUBLIC_IP also accept a host name; on Pterodactyl the allocation
//! address (SERVER_IP) is used when it is a public one and nothing else is given.
//!
//! Voice and video never pass through this server: it only forwards the WebRTC
//! offers/answers/ICE candidates, the audio and video flow peer-to-peer (or via the TURN relay).

mod hub;
mod net;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, Query, State,
    },
    http::{header::HOST, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use hub::{Config, Hub};
use net::{TurnInfo, Upnp, UpnpInfo};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::sync::mpsc;
use tower_http::cors::CorsLayer;

type App = Arc<Hub>;

#[derive(Deserialize)]
struct Cred {
    username: String,
    password: String,
    #[serde(default)]
    invite: Option<String>,
}

fn fail(code: u16, msg: String) -> Response {
    (StatusCode::from_u16(code).unwrap_or(StatusCode::BAD_REQUEST), Json(json!({ "error": msg }))).into_response()
}

async fn health(State(app): State<App>) -> Json<serde_json::Value> {
    Json(app.stats())
}

async fn register(State(app): State<App>, Json(c): Json<Cred>) -> Response {
    match app.register(c.username, c.password, c.invite).await {
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
    app.shutdown.notify_waiters();
    Json(json!({ "ok": true })).into_response()
}

/// Network status (public address, UPnP, TURN) – only for the launcher on this machine.
async fn admin_info(State(app): State<App>, ConnectInfo(addr): ConnectInfo<SocketAddr>) -> Response {
    if !addr.ip().is_loopback() {
        return fail(403, "forbidden".into());
    }
    let info = app.info.lock().unwrap().clone();
    Json(info).into_response()
}

/// "example.com:7777" / "[::1]:7777" / "10.0.0.5" -> host part only
fn host_of(headers: &HeaderMap) -> Option<String> {
    let h = headers.get(HOST)?.to_str().ok()?.trim();
    if let Some(rest) = h.strip_prefix('[') {
        return rest.split(']').next().map(str::to_string);
    }
    Some(h.split(':').next()?.to_string()).filter(|s| !s.is_empty())
}

async fn ws_upgrade(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    State(app): State<App>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(user) = q.get("token").and_then(|t| app.user_for_token(t)) else {
        return fail(401, "Invalid session".into());
    };
    let host = host_of(&headers);
    ws.max_message_size(256 * 1024)
        .on_upgrade(move |socket| socket_loop(app, socket, user, host))
}

async fn socket_loop(app: App, socket: WebSocket, user: String, host: Option<String>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let id = app.register_conn(&user, tx, host.as_deref());

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
fn flag(name: &str) -> bool {
    std::env::args().any(|x| x == name)
}
/// `--name VALUE` on the command line, else the environment variable `env`; empty values count as unset.
fn setting(name: &str, env: &str) -> Option<String> {
    arg(name)
        .or_else(|| std::env::var(env).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}
/// `--name` on the command line, or `env` set to 1 / true / yes / on.
fn switch(name: &str, env: &str) -> bool {
    flag(name)
        || matches!(
            std::env::var(env).ok().map(|s| s.trim().to_ascii_lowercase()).as_deref(),
            Some("1" | "true" | "yes" | "on")
        )
}
fn number(name: &str, env: &str, default: u16) -> u16 {
    setting(name, env).and_then(|v| v.parse().ok()).unwrap_or(default)
}

/// An IP address, or a host name that is looked up (IPv4 preferred).
fn resolve_ip(s: &str) -> Option<IpAddr> {
    if let Ok(ip) = s.parse() {
        return Some(ip);
    }
    use std::net::ToSocketAddrs;
    let addrs: Vec<IpAddr> = (s, 0).to_socket_addrs().ok()?.map(|a| a.ip()).collect();
    addrs.iter().copied().find(IpAddr::is_ipv4).or_else(|| addrs.first().copied())
}

const USAGE: &str = "\
nexus-server [--bind 127.0.0.1:7777] [--data nexus-data] [--invite CODE]
             [--turn] [--turn-port 3478] [--relay-min 49160] [--relay-max 49200]
             [--upnp] [--public-ip IP-OR-HOST]

Every option can also be set through the environment: NEXUS_BIND, NEXUS_DATA, NEXUS_INVITE,
NEXUS_TURN=1, NEXUS_TURN_PORT, NEXUS_RELAY_MIN, NEXUS_RELAY_MAX, NEXUS_UPNP=1, NEXUS_PUBLIC_IP.
External TURN server: NEXUS_TURN_URL, NEXUS_TURN_USER, NEXUS_TURN_PASS.";

/// SIGINT (Ctrl+C) and, on Unix, SIGTERM (docker stop, Pterodactyl).
async fn stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut term) => {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => {},
                    _ = term.recv() => {},
                }
            }
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Shared secret for the TURN credentials, created once and kept in the data folder.
fn turn_secret(data: &PathBuf) -> String {
    let file = data.join("turn-secret");
    if let Ok(s) = std::fs::read_to_string(&file) {
        if s.trim().len() >= 16 {
            return s.trim().to_string();
        }
    }
    use rand::RngCore;
    let mut b = [0u8; 24];
    rand::thread_rng().fill_bytes(&mut b);
    let s: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let _ = std::fs::create_dir_all(data);
    let _ = std::fs::write(&file, &s);
    s
}

#[tokio::main]
async fn main() {
    if flag("--version") || flag("-V") {
        println!("nexus-server {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    if flag("--help") || flag("-h") {
        println!("Nexus Server {}\n\n{USAGE}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let bind: SocketAddr = setting("--bind", "NEXUS_BIND")
        .unwrap_or_else(|| "127.0.0.1:7777".into())
        .parse()
        .expect("invalid --bind address, e.g. 127.0.0.1:7777");
    let data = PathBuf::from(setting("--data", "NEXUS_DATA").unwrap_or_else(|| "nexus-data".into()));
    let invite = setting("--invite", "NEXUS_INVITE");

    // ── internet play: UPnP port forwarding + TURN relay
    let (want_turn, want_upnp) = (switch("--turn", "NEXUS_TURN"), switch("--upnp", "NEXUS_UPNP"));
    let turn_port = number("--turn-port", "NEXUS_TURN_PORT", 3478);
    let (rmin, rmax) = (number("--relay-min", "NEXUS_RELAY_MIN", 49160), number("--relay-max", "NEXUS_RELAY_MAX", 49200));
    let local_ip = net::local_ipv4();
    let mut public_ip: Option<IpAddr> = None;
    if let Some(s) = setting("--public-ip", "NEXUS_PUBLIC_IP") {
        public_ip = resolve_ip(&s);
        if public_ip.is_none() {
            eprintln!("Nexus Server: --public-ip {s}: not an IP address and the name could not be resolved, ignoring it");
        }
    }
    let mut upnp_info = UpnpInfo { enabled: want_upnp, ..Default::default() };
    let mut upnp: Option<Upnp> = None;
    if want_upnp {
        match local_ip {
            None => upnp_info.message = "could not find the local network address".into(),
            Some(local) => match Upnp::open(local, bind.port(), turn_port, rmin, rmax).await {
                Ok(u) => {
                    upnp_info.ok = true;
                    upnp_info.external_ip = Some(u.external.to_string());
                    if net::is_unroutable(u.external) {
                        upnp_info.message = format!(
                            "the router reports {} – that is not a public address (carrier-grade NAT?), friends cannot connect directly. Use a VPN such as Tailscale.",
                            u.external
                        );
                    }
                    public_ip.get_or_insert(u.external);
                    upnp = Some(u);
                }
                Err(e) => upnp_info.message = e,
            },
        }
    }

    // Pterodactyl (Wings) passes the address of the server's allocation; use it when it is public.
    if public_ip.is_none() {
        if let Some(ip) = std::env::var("SERVER_IP").ok().and_then(|s| s.trim().parse::<IpAddr>().ok()) {
            if !ip.is_unspecified() && !net::is_unroutable(ip) {
                public_ip = Some(ip);
            }
        }
    }

    let secret = turn_secret(&data);
    let mut turn_info = TurnInfo { enabled: want_turn, port: turn_port, relay: format!("{rmin}-{rmax}"), ..Default::default() };
    let mut turn_server = None;
    let mut relay_ip = IpAddr::from([127, 0, 0, 1]);
    if want_turn {
        relay_ip = public_ip.or(local_ip.map(IpAddr::V4)).unwrap_or(relay_ip);
        match net::start_turn(&secret, turn_port, relay_ip, rmin, rmax).await {
            Ok(s) => {
                turn_info.ok = true;
                turn_server = Some(s);
            }
            Err(e) => turn_info.message = e,
        }
    }

    let cfg = Config { invite: invite.clone(), turn: turn_info.ok.then(|| (secret.clone(), turn_port)) };
    let hub: App = Arc::new(Hub::load(data.clone(), cfg));
    *hub.info.lock().unwrap() = json!({
        "bind": bind.to_string(),
        "publicIp": public_ip.map(|i| i.to_string()),
        "localIp": local_ip.map(|i| i.to_string()),
        "invite": invite.is_some(),
        "upnp": upnp_info,
        "turn": turn_info,
    });

    // persist changes every couple of seconds; keep the router mappings alive
    let saver = hub.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            saver.save_if_dirty();
        }
    });
    if let Some(mut u) = upnp {
        let stop = hub.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(1800)) => { u.refresh().await; }
                    _ = stop.shutdown.notified() => { u.remove_all().await; break; }
                }
            }
        });
    }

    let app = Router::new()
        .route("/api/health", get(health))
        .route("/api/register", post(register))
        .route("/api/login", post(login))
        .route("/api/me", get(me))
        .route("/api/logout", post(logout))
        .route("/api/admin/shutdown", post(shutdown))
        .route("/api/admin/info", get(admin_info))
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
    println!("Nexus Server {} listening on http://{bind}  (data: {})", env!("CARGO_PKG_VERSION"), data.display());
    if let Some(ip) = public_ip {
        println!("  public address: http://{ip}:{}", bind.port());
    }
    if want_turn {
        println!("  TURN relay: {}", if turn_info.ok { format!("UDP {turn_port}, relay ports {rmin}-{rmax}") } else { turn_info.message.clone() });
        if turn_info.ok && net::is_unroutable(relay_ip) {
            println!("  Note: relayed media is announced as {relay_ip}, which friends on the internet cannot reach - set --public-ip / NEXUS_PUBLIC_IP");
        }
    }
    if want_upnp {
        println!("  UPnP: {}", if upnp_info.ok { "ports forwarded".to_string() } else { upnp_info.message.clone() });
    }
    if invite.is_some() {
        println!("  accounts need the invite code");
    } else if !bind.ip().is_loopback() {
        println!("  Note: listening on a non-local address without --invite – anyone who can reach this port can register.");
    }

    // a second shutdown waiter: UPnP cleanup needs its own notification
    let stop = hub.clone();
    let shutdown_signal = async move {
        tokio::select! {
            _ = stop_signal() => { stop.shutdown.notify_waiters(); },
            _ = stop.shutdown.notified() => {},
        }
        println!("Nexus Server shutting down…");
    };

    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal)
        .await
        .ok();
    if let Some(t) = turn_server {
        let _ = t.close().await;
    }
    hub.save_if_dirty();
    tokio::time::sleep(Duration::from_millis(300)).await; // let the UPnP cleanup finish
}
