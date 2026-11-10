//! TeamSpeak 3 integration through the client's **ClientQuery** interface.
//!
//! The TeamSpeak 3 client (with the ClientQuery plugin enabled) listens on 127.0.0.1:25639.
//! After `auth apikey=<key>` Nexus can read the channel tree, join channels, mute the
//! microphone / speakers and send text, and it receives live events (who is talking, chat
//! messages, people joining or leaving). The audio itself stays inside the TeamSpeak
//! client – there is no need for the TeamSpeak SDK.
//!
//! The API key is shown in TeamSpeak under Tools → Options → Addons → ClientQuery → Settings.
//!
//! Protocol notes: commands are one line, answers are zero or more data lines followed by
//! `error id=<n> msg=<text>`; notifications (`notify…`) can arrive at any time in between.
//! Values are escaped (`\s` = space, `\p` = `|`, `\/` = `/`, `\\` = `\`, …).

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{tcp::OwnedReadHalf, tcp::OwnedWriteHalf, TcpStream},
    sync::{oneshot, Mutex as AsyncMutex},
    time::timeout,
};

/// Sends an event to the UI (the Tauri side wraps `AppHandle::emit` in this).
pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub const DEFAULT_ADDRESS: &str = "127.0.0.1:25639";

// ───────────────────────────── protocol helpers ─────────────────────────────

pub fn unescape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut it = s.chars();
    while let Some(c) = it.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match it.next() {
            Some('s') => out.push(' '),
            Some('p') => out.push('|'),
            Some('/') => out.push('/'),
            Some('\\') => out.push('\\'),
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('a') => out.push('\x07'),
            Some('b') => out.push('\x08'),
            Some('f') => out.push('\x0c'),
            Some('v') => out.push('\x0b'),
            Some(o) => out.push(o),
            None => {}
        }
    }
    out
}

pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '/' => out.push_str("\\/"),
            ' ' => out.push_str("\\s"),
            '|' => out.push_str("\\p"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out
}

type Kv = HashMap<String, String>;

/// `a=1 b=two\sparts c` → {a:"1", b:"two parts", c:""}
pub fn parse_kv(line: &str) -> Kv {
    line.split(' ')
        .filter(|p| !p.is_empty())
        .map(|p| match p.split_once('=') {
            Some((k, v)) => (k.to_string(), unescape(v)),
            None => (p.to_string(), String::new()),
        })
        .collect()
}

/// Data lines of an answer → records (records are separated by an unescaped `|`).
pub fn parse_records(lines: &[String]) -> Vec<Kv> {
    lines
        .iter()
        .flat_map(|l| l.split('|').map(parse_kv).collect::<Vec<_>>())
        .filter(|m| !m.is_empty())
        .collect()
}

fn num(m: &Kv, k: &str) -> i64 {
    m.get(k).and_then(|v| v.parse().ok()).unwrap_or(0)
}
fn flag(m: &Kv, k: &str) -> bool {
    m.get(k).map(|v| v != "0" && !v.is_empty()).unwrap_or(false)
}
fn text(m: &Kv, k: &str) -> String {
    m.get(k).cloned().unwrap_or_default()
}

// ───────────────────────────── connection ─────────────────────────────

pub struct Resp {
    pub lines: Vec<String>,
    pub code: i64,
    pub msg: String,
}

pub struct TsConn {
    writer: AsyncMutex<OwnedWriteHalf>,
    pending: Arc<Mutex<VecDeque<oneshot::Sender<Resp>>>>,
    reader: tokio::task::JoinHandle<()>,
}

impl Drop for TsConn {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

impl TsConn {
    /// Sends one command and waits for its `error id=…` line.
    pub async fn cmd(&self, line: &str) -> Result<Resp, String> {
        let (tx, rx) = oneshot::channel();
        {
            let mut w = self.writer.lock().await;
            self.pending.lock().unwrap().push_back(tx);
            w.write_all(format!("{line}\n").as_bytes())
                .await
                .map_err(|e| format!("TeamSpeak connection lost: {e}"))?;
        }
        let resp = match timeout(Duration::from_secs(6), rx).await {
            Ok(Ok(r)) => r,
            Ok(Err(_)) => return Err("TeamSpeak closed the connection".into()),
            Err(_) => {
                // an unanswered command would shift all later answers: drop the connection
                self.reader.abort();
                self.pending.lock().unwrap().clear();
                return Err("TeamSpeak did not answer in time".into());
            }
        };
        if resp.code != 0 {
            return Err(format!("TeamSpeak: {} (error {})", resp.msg, resp.code));
        }
        Ok(resp)
    }
}

async fn read_loop(
    read: OwnedReadHalf,
    pending: Arc<Mutex<VecDeque<oneshot::Sender<Resp>>>>,
    emit: Emit,
    on_close: Arc<dyn Fn() + Send + Sync>,
) {
    let mut lines = BufReader::new(read).lines();
    let mut buf: Vec<String> = Vec::new();
    while let Ok(Some(raw)) = lines.next_line().await {
        let line = raw.trim().to_string();
        if line.is_empty()
            || line == "TS3 Client"
            || line.starts_with("Welcome to the TeamSpeak")
            || line.starts_with("selected schandlerid=")
        {
            continue;
        }
        if line.starts_with("notify") {
            handle_notify(&emit, &line);
            continue;
        }
        if let Some(rest) = line.strip_prefix("error ") {
            let kv = parse_kv(rest);
            let resp = Resp { lines: std::mem::take(&mut buf), code: num(&kv, "id"), msg: text(&kv, "msg") };
            let tx = pending.lock().unwrap().pop_front();
            if let Some(tx) = tx {
                let _ = tx.send(resp);
            }
            continue;
        }
        buf.push(line);
    }
    // socket closed: wake every waiting command, then tell the UI
    pending.lock().unwrap().clear();
    on_close();
    emit("ts-disconnected", json!({}));
}

fn handle_notify(emit: &Emit, line: &str) {
    let (name, rest) = line.split_once(' ').unwrap_or((line, ""));
    let kv = parse_kv(rest);
    match name {
        "notifytalkstatuschange" => emit(
            "ts-talk",
            json!({ "schandler": num(&kv, "schandlerid"), "clid": num(&kv, "clid"), "talking": num(&kv, "status") > 0 }),
        ),
        "notifytextmessage" => emit(
            "ts-text",
            json!({
                "schandler": num(&kv, "schandlerid"), "mode": num(&kv, "targetmode"),
                "from": text(&kv, "invokername"), "clid": num(&kv, "invokerid"), "msg": text(&kv, "msg"),
            }),
        ),
        "notifycliententerview" | "notifyclientleftview" | "notifyclientmoved" | "notifyclientupdated"
        | "notifychannelcreated" | "notifychanneledited" | "notifychanneldeleted" | "notifychannelmoved"
        | "notifyconnectstatuschange" | "notifycurrentserverconnectionchanged" | "notifyserverupdated" => {
            emit("ts-changed", json!({ "event": name }))
        }
        _ => {}
    }
}

/// Connects, authenticates with the API key and subscribes to all events.
pub async fn connect(
    addr: &str,
    api_key: &str,
    emit: Emit,
    on_close: Arc<dyn Fn() + Send + Sync>,
) -> Result<TsConn, String> {
    let stream = timeout(Duration::from_secs(3), TcpStream::connect(addr))
        .await
        .map_err(|_| format!("No answer from {addr}"))?
        .map_err(|_| {
            format!(
                "Could not reach the TeamSpeak client on {addr}. Start TeamSpeak 3 and enable the ClientQuery plugin (Tools → Options → Addons)."
            )
        })?;
    let (r, w) = stream.into_split();
    let pending: Arc<Mutex<VecDeque<oneshot::Sender<Resp>>>> = Arc::new(Mutex::new(VecDeque::new()));
    let reader = tokio::spawn(read_loop(r, pending.clone(), emit, on_close));
    let conn = TsConn { writer: AsyncMutex::new(w), pending, reader };

    conn.cmd(&format!("auth apikey={}", api_key.trim()))
        .await
        .map_err(|e| format!("TeamSpeak rejected the API key ({e}). Copy it again from Tools → Options → Addons → ClientQuery."))?;

    // events for every server tab
    let handlers = conn.cmd("serverconnectionhandlerlist").await?;
    for h in parse_records(&handlers.lines) {
        let id = num(&h, "schandlerid");
        let _ = conn.cmd(&format!("clientnotifyregister schandlerid={id} event=any")).await;
    }
    Ok(conn)
}

// ───────────────────────────── state of the active server tab ─────────────────────────────

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TsChannel {
    pub cid: i64,
    pub pid: i64,
    pub name: String,
    pub order: i64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TsClient {
    pub clid: i64,
    pub cid: i64,
    pub name: String,
    pub talking: bool,
    pub input_muted: bool,
    pub output_muted: bool,
    pub is_me: bool,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TsOverview {
    pub schandler: i64,
    pub server_name: String,
    pub my_clid: i64,
    pub my_cid: i64,
    pub input_muted: bool,
    pub output_muted: bool,
    pub channels: Vec<TsChannel>,
    pub clients: Vec<TsClient>,
}

pub async fn overview(conn: &TsConn) -> Result<TsOverview, String> {
    let cur = conn.cmd("currentschandlerid").await?;
    let schandler = parse_records(&cur.lines).first().map(|m| num(m, "schandlerid")).unwrap_or(1);
    conn.cmd(&format!("use schandlerid={schandler}")).await?;
    let who = conn
        .cmd("whoami")
        .await
        .map_err(|_| "The active TeamSpeak tab is not connected to a server yet".to_string())?;
    let me = parse_records(&who.lines).into_iter().next().unwrap_or_default();
    let (my_clid, my_cid) = (num(&me, "clid"), num(&me, "cid"));

    let server_name = match conn.cmd("servervariable virtualserver_name").await {
        Ok(r) => parse_records(&r.lines).first().map(|m| text(m, "virtualserver_name")).unwrap_or_default(),
        Err(_) => String::new(),
    };
    let mut channels: Vec<TsChannel> = parse_records(&conn.cmd("channellist").await?.lines)
        .iter()
        .map(|m| TsChannel { cid: num(m, "cid"), pid: num(m, "pid"), name: text(m, "channel_name"), order: num(m, "channel_order") })
        .collect();
    channels.sort_by_key(|c| (c.pid, c.order, c.cid));

    let clients: Vec<TsClient> = parse_records(&conn.cmd("clientlist -voice").await?.lines)
        .iter()
        .filter(|m| num(m, "client_type") != 1) // hide ServerQuery clients
        .map(|m| TsClient {
            clid: num(m, "clid"),
            cid: num(m, "cid"),
            name: text(m, "client_nickname"),
            talking: flag(m, "client_flag_talking"),
            input_muted: flag(m, "client_input_muted"),
            output_muted: flag(m, "client_output_muted"),
            is_me: num(m, "clid") == my_clid,
        })
        .collect();
    let mine = clients.iter().find(|c| c.is_me);
    Ok(TsOverview {
        schandler,
        server_name,
        my_clid,
        my_cid,
        input_muted: mine.map(|c| c.input_muted).unwrap_or(false),
        output_muted: mine.map(|c| c.output_muted).unwrap_or(false),
        channels,
        clients,
    })
}

pub async fn join_channel(conn: &TsConn, clid: i64, cid: i64) -> Result<(), String> {
    conn.cmd(&format!("clientmove clid={clid} cid={cid}")).await.map(|_| ())
}

pub async fn set_mute(conn: &TsConn, input: Option<bool>, output: Option<bool>) -> Result<(), String> {
    let mut parts = Vec::new();
    if let Some(i) = input {
        parts.push(format!("client_input_muted={}", i as u8));
    }
    if let Some(o) = output {
        parts.push(format!("client_output_muted={}", o as u8));
    }
    if parts.is_empty() {
        return Ok(());
    }
    conn.cmd(&format!("clientupdate {}", parts.join(" "))).await.map(|_| ())
}

/// Sends a message to the channel the user is currently in.
pub async fn send_channel_text(conn: &TsConn, cid: i64, msg: &str) -> Result<(), String> {
    conn.cmd(&format!("sendtextmessage targetmode=2 target={cid} msg={}", escape(msg)))
        .await
        .map(|_| ())
}

// ───────────────────────────── tests (against a fake ClientQuery server) ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    #[test]
    fn escaping_round_trips() {
        let s = "My Server | a/b \\ c\nd";
        assert_eq!(unescape(&escape(s)), s);
        assert_eq!(unescape("Team\\sOne\\p2"), "Team One|2");
    }

    #[test]
    fn parses_records() {
        let lines = vec!["cid=1 pid=0 channel_name=Lobby|cid=2 pid=0 channel_name=Team\\sOne".to_string()];
        let r = parse_records(&lines);
        assert_eq!(r.len(), 2);
        assert_eq!(r[1]["channel_name"], "Team One");
        assert_eq!(num(&r[1], "cid"), 2);
    }

    /// Minimal fake of the TeamSpeak ClientQuery plugin.
    async fn fake_server(good_key: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        tokio::spawn(async move {
            let (sock, _) = listener.accept().await.unwrap();
            let (r, mut w) = sock.into_split();
            w.write_all(b"TS3 Client\n\rWelcome to the TeamSpeak 3 ClientQuery interface, type \"help\" for a list of commands and \"help <command>\" for information on a specific command.\n\rselected schandlerid=1\n\r").await.unwrap();
            let mut lines = BufReader::new(r).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                let l = l.trim().to_string();
                let reply: String = if let Some(k) = l.strip_prefix("auth apikey=") {
                    if k == good_key { "error id=0 msg=ok\n\r".into() } else { "error id=2568 msg=insufficient\\sclient\\spermissions\n\r".into() }
                } else if l == "serverconnectionhandlerlist" {
                    "schandlerid=1\n\rerror id=0 msg=ok\n\r".into()
                } else if l.starts_with("clientnotifyregister") || l.starts_with("use ") {
                    "error id=0 msg=ok\n\r".into()
                } else if l == "currentschandlerid" {
                    "schandlerid=1\n\rerror id=0 msg=ok\n\r".into()
                } else if l == "whoami" {
                    "clid=5 cid=2\n\rerror id=0 msg=ok\n\r".into()
                } else if l.starts_with("servervariable") {
                    "virtualserver_name=My\\sTest\\sServer\n\rerror id=0 msg=ok\n\r".into()
                } else if l == "channellist" {
                    "cid=2 pid=0 channel_order=1 channel_name=Team\\sOne|cid=1 pid=0 channel_order=0 channel_name=Lobby\n\rerror id=0 msg=ok\n\r".into()
                } else if l == "clientlist -voice" {
                    "clid=5 cid=2 client_nickname=Me client_type=0 client_flag_talking=0 client_input_muted=1 client_output_muted=0|clid=6 cid=2 client_nickname=Friend client_type=0 client_flag_talking=1 client_input_muted=0 client_output_muted=0|clid=7 cid=1 client_nickname=serveradmin client_type=1\n\rerror id=0 msg=ok\n\r".into()
                } else if l.starts_with("clientmove") {
                    // answer plus an interleaved notification, like the real client
                    "notifyclientmoved schandlerid=1 ctid=1 reasonid=0 clid=5\n\rerror id=0 msg=ok\n\r".into()
                } else if l.starts_with("sendtextmessage") {
                    "error id=0 msg=ok\n\r".into()
                } else {
                    "error id=256 msg=command\\snot\\sfound\n\r".into()
                };
                w.write_all(reply.as_bytes()).await.unwrap();
                if l.starts_with("sendtextmessage") {
                    w.write_all(b"notifytalkstatuschange schandlerid=1 status=1 isreceivedwhisper=0 clid=6\n\r").await.unwrap();
                }
            }
        });
        addr
    }

    fn collector() -> (Emit, Arc<Mutex<Vec<(String, Value)>>>) {
        let got: Arc<Mutex<Vec<(String, Value)>>> = Arc::new(Mutex::new(Vec::new()));
        let g = got.clone();
        let emit: Emit = Arc::new(move |n: &str, v: Value| g.lock().unwrap().push((n.to_string(), v)));
        (emit, got)
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn talks_to_a_fake_clientquery() {
        let addr = fake_server("GOODKEY").await;
        let (emit, got) = collector();
        let conn = connect(&addr, "GOODKEY", emit, Arc::new(|| {})).await.expect("connect");

        let ov = overview(&conn).await.expect("overview");
        assert_eq!(ov.server_name, "My Test Server");
        assert_eq!((ov.my_clid, ov.my_cid), (5, 2));
        assert!(ov.input_muted && !ov.output_muted);
        assert_eq!(ov.channels.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["Lobby", "Team One"]);
        assert_eq!(ov.clients.len(), 2, "ServerQuery clients are hidden");
        assert!(ov.clients.iter().find(|c| c.name == "Friend").unwrap().talking);

        join_channel(&conn, 5, 1).await.expect("join");
        send_channel_text(&conn, 2, "hi | there").await.expect("text");
        tokio::time::sleep(Duration::from_millis(200)).await;
        let events = got.lock().unwrap();
        assert!(events.iter().any(|(n, _)| n == "ts-changed"), "move notification is forwarded");
        assert!(events.iter().any(|(n, v)| n == "ts-talk" && v["clid"] == 6 && v["talking"] == true), "talk status is forwarded");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rejects_a_wrong_key() {
        let addr = fake_server("GOODKEY").await;
        let (emit, _) = collector();
        let err = connect(&addr, "WRONG", emit, Arc::new(|| {})).await.err().expect("must fail");
        assert!(err.contains("rejected the API key"), "{err}");
    }

    #[tokio::test]
    async fn reports_a_missing_client() {
        let (emit, _) = collector();
        let err = connect("127.0.0.1:1", "x", emit, Arc::new(|| {})).await.err().expect("must fail");
        assert!(err.contains("TeamSpeak"), "{err}");
    }
}
