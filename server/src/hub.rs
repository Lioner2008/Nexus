//! Shared server state: accounts, rooms, chat history, live connections and
//! the voice/video call bookkeeping. All WebSocket messages are handled here.
//!
//! Concurrency model: one `std::sync::Mutex<State>`; no `.await` is ever done while the
//! lock is held. Every connection owns an unbounded channel; the socket writer task
//! drains it, so sending from inside the lock never blocks.

use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc::UnboundedSender, Notify};

const HISTORY_CAP: usize = 500;
const HISTORY_ON_CONNECT: usize = 100;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize, Clone)]
pub struct UserRec {
    pub name: String,
    pub hash: String,
    pub created: u64,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Room {
    pub id: String,
    pub name: String,
    pub kind: String, // "text" | "voice"
    pub topic: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Msg {
    pub id: u64,
    pub room: String,
    pub from: String,
    pub text: String,
    pub ts: u64,
}

#[derive(Serialize, Clone)]
pub struct VoiceMember {
    pub conn: u64,
    pub user: String,
    pub room: String,
    pub video: bool,
    pub screen: bool,
    pub muted: bool,
    pub deaf: bool,
}

struct Conn {
    user: String,
    status: String,
    tx: UnboundedSender<String>,
    voice: Option<VoiceMember>,
}

#[derive(Serialize, Deserialize, Default)]
struct Persisted {
    users: HashMap<String, UserRec>,
    tokens: HashMap<String, String>,
    rooms: Vec<Room>,
    history: HashMap<String, VecDeque<Msg>>,
    next_msg: u64,
    next_room: u64,
}

pub struct State {
    users: HashMap<String, UserRec>,   // key: lower-case name
    tokens: HashMap<String, String>,   // token -> lower-case name
    rooms: Vec<Room>,
    history: HashMap<String, VecDeque<Msg>>,
    next_msg: u64,
    next_room: u64,
    conns: HashMap<u64, Conn>,
    next_conn: u64,
    calls: HashSet<String>,            // ephemeral call rooms ("call:xxxx")
    fails: HashMap<String, (u32, Instant)>,
    dirty: bool,
}

/// Options chosen at startup.
#[derive(Default, Clone)]
pub struct Config {
    /// When set, creating an account requires this code.
    pub invite: Option<String>,
    /// (shared secret, UDP port) of the built-in TURN relay, when it is running.
    pub turn: Option<(String, u16)>,
}

pub struct Hub {
    pub st: Mutex<State>,
    pub data: PathBuf,
    pub shutdown: Notify,
    pub started: Instant,
    pub cfg: Config,
    /// Network status shown to the launcher (public address, UPnP, TURN).
    pub info: Mutex<Value>,
}

fn key(name: &str) -> String {
    name.trim().to_lowercase()
}

fn valid_name(n: &str) -> bool {
    (3..=24).contains(&n.chars().count()) && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

fn slug(n: &str) -> String {
    n.chars()
        .map(|c| if c.is_alphanumeric() { c.to_ascii_lowercase() } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn random_token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn dm_id(a: &str, b: &str) -> String {
    let (a, b) = (key(a), key(b));
    if a <= b { format!("dm:{a}|{b}") } else { format!("dm:{b}|{a}") }
}

fn dm_parts(id: &str) -> Option<(String, String)> {
    let rest = id.strip_prefix("dm:")?;
    let (a, b) = rest.split_once('|')?;
    Some((a.to_string(), b.to_string()))
}

impl Hub {
    pub fn load(data: PathBuf, cfg: Config) -> Hub {
        let _ = std::fs::create_dir_all(&data);
        let p: Persisted = std::fs::read(data.join("state.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let mut rooms = p.rooms;
        if rooms.is_empty() {
            let mk = |id: &str, name: &str, kind: &str, topic: &str| Room {
                id: id.into(), name: name.into(), kind: kind.into(), topic: topic.into(),
            };
            rooms = vec![
                mk("general", "general", "text", "Talk about anything"),
                mk("games", "games", "text", "What are you playing?"),
                mk("looking-for-group", "looking-for-group", "text", "Find people to play with"),
                mk("lobby", "Lobby", "voice", ""),
                mk("gaming-1", "Gaming 1", "voice", ""),
                mk("gaming-2", "Gaming 2", "voice", ""),
                mk("afk", "AFK", "voice", ""),
            ];
        }
        Hub {
            st: Mutex::new(State {
                users: p.users,
                tokens: p.tokens,
                rooms,
                history: p.history,
                next_msg: p.next_msg.max(1),
                next_room: p.next_room.max(1),
                conns: HashMap::new(),
                next_conn: 1,
                calls: HashSet::new(),
                fails: HashMap::new(),
                dirty: true,
            }),
            data,
            shutdown: Notify::new(),
            started: Instant::now(),
            cfg,
            info: Mutex::new(json!({})),
        }
    }

    /// Writes the state to disk when something changed (atomic replace).
    pub fn save_if_dirty(&self) {
        let json = {
            let mut st = self.st.lock().unwrap();
            if !st.dirty {
                return;
            }
            st.dirty = false;
            let p = Persisted {
                users: st.users.clone(),
                tokens: st.tokens.clone(),
                rooms: st.rooms.clone(),
                history: st.history.clone(),
                next_msg: st.next_msg,
                next_room: st.next_room,
            };
            serde_json::to_vec(&p).ok()
        };
        if let Some(b) = json {
            let tmp = self.data.join("state.json.tmp");
            if std::fs::write(&tmp, b).is_ok() {
                let _ = std::fs::rename(&tmp, self.data.join("state.json"));
            }
        }
    }

    // ───────────── accounts ─────────────

    pub async fn register(&self, name: String, password: String, invite: Option<String>) -> Result<(String, String), (u16, String)> {
        if let Some(code) = &self.cfg.invite {
            if invite.as_deref().map(str::trim) != Some(code.as_str()) {
                return Err((403, "A valid invite code is required to create an account".into()));
            }
        }
        let name = name.trim().to_string();
        if !valid_name(&name) {
            return Err((400, "Username: 3–24 characters, letters, digits, _ or -".into()));
        }
        if password.chars().count() < 6 || password.len() > 200 {
            return Err((400, "Password must have at least 6 characters".into()));
        }
        if self.st.lock().unwrap().users.contains_key(&key(&name)) {
            return Err((409, "That username is already taken".into()));
        }
        let hash = tokio::task::spawn_blocking(move || {
            let salt = SaltString::generate(&mut OsRng);
            Argon2::default().hash_password(password.as_bytes(), &salt).map(|h| h.to_string())
        })
        .await
        .map_err(|_| (500, "internal error".to_string()))?
        .map_err(|_| (500, "could not hash password".to_string()))?;

        let mut st = self.st.lock().unwrap();
        if st.users.contains_key(&key(&name)) {
            return Err((409, "That username is already taken".into()));
        }
        st.users.insert(key(&name), UserRec { name: name.clone(), hash, created: now_ms() });
        let token = random_token();
        st.tokens.insert(token.clone(), key(&name));
        st.dirty = true;
        Ok((token, name))
    }

    pub async fn login(&self, name: String, password: String) -> Result<(String, String), (u16, String)> {
        let k = key(&name);
        {
            let mut st = self.st.lock().unwrap();
            if let Some((n, since)) = st.fails.get(&k).copied() {
                if since.elapsed() < Duration::from_secs(60) && n >= 8 {
                    return Err((429, "Too many attempts, try again in a minute".into()));
                }
                if since.elapsed() >= Duration::from_secs(60) {
                    st.fails.remove(&k);
                }
            }
        }
        let rec = self.st.lock().unwrap().users.get(&k).cloned();
        let ok = match &rec {
            Some(r) => {
                let hash = r.hash.clone();
                tokio::task::spawn_blocking(move || {
                    PasswordHash::new(&hash)
                        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
                        .unwrap_or(false)
                })
                .await
                .unwrap_or(false)
            }
            None => false,
        };
        let mut st = self.st.lock().unwrap();
        match (ok, rec) {
            (true, Some(r)) => {
                st.fails.remove(&k);
                let token = random_token();
                st.tokens.insert(token.clone(), k);
                st.dirty = true;
                Ok((token, r.name))
            }
            _ => {
                let e = st.fails.entry(k).or_insert((0, Instant::now()));
                e.0 += 1;
                Err((401, "Wrong username or password".into()))
            }
        }
    }

    pub fn user_for_token(&self, token: &str) -> Option<String> {
        let st = self.st.lock().unwrap();
        let k = st.tokens.get(token)?;
        st.users.get(k).map(|u| u.name.clone())
    }

    pub fn logout(&self, token: &str) {
        let mut st = self.st.lock().unwrap();
        if st.tokens.remove(token).is_some() {
            st.dirty = true;
        }
    }

    pub fn stats(&self) -> Value {
        let st = self.st.lock().unwrap();
        let online: HashSet<String> = st.conns.values().map(|c| key(&c.user)).collect();
        json!({
            "ok": true, "name": "Nexus Server", "version": env!("CARGO_PKG_VERSION"),
            "users": st.users.len(), "online": online.len(), "invite": self.cfg.invite.is_some(),
            "connections": st.conns.len(), "uptime": self.started.elapsed().as_secs(),
        })
    }

    // ───────────── connections ─────────────

    pub fn register_conn(&self, user: &str, tx: UnboundedSender<String>, host: Option<&str>) -> u64 {
        let mut st = self.st.lock().unwrap();
        let id = st.next_conn;
        st.next_conn += 1;
        st.conns.insert(id, Conn { user: user.to_string(), status: "online".into(), tx, voice: None });

        let ice = self.ice_servers(host);
        st.send(id, &json!({
            "t": "welcome", "you": user, "conn": id, "ice": ice,
            "rooms": st.rooms_json(), "dms": st.dms_json(user),
        }));
        st.send(id, &st.presence_json());
        st.send(id, &st.voice_rooms_json());
        // history of every public text room and of the user's direct messages
        let mut ids: Vec<String> = st.rooms.iter().filter(|r| r.kind == "text").map(|r| r.id.clone()).collect();
        ids.extend(st.history.keys().filter(|k| st.dm_has(k, user)).cloned());
        for rid in ids {
            let msgs: Vec<&Msg> = st
                .history
                .get(&rid)
                .map(|h| h.iter().rev().take(HISTORY_ON_CONNECT).collect::<Vec<_>>().into_iter().rev().collect())
                .unwrap_or_default();
            st.send(id, &json!({ "t": "history", "room": rid, "msgs": msgs }));
        }
        let p = st.presence_json();
        st.broadcast(&p);
        id
    }

    pub fn unregister_conn(&self, id: u64) {
        let mut st = self.st.lock().unwrap();
        st.leave_voice(id);
        st.conns.remove(&id);
        let p = st.presence_json();
        st.broadcast(&p);
    }

    // ───────────── message handling ─────────────

    pub fn on_message(&self, id: u64, raw: &str) {
        let Ok(v) = serde_json::from_str::<Value>(raw) else { return };
        let t = v["t"].as_str().unwrap_or("");
        let mut st = self.st.lock().unwrap();
        let Some(user) = st.conns.get(&id).map(|c| c.user.clone()) else { return };
        let err = |st: &State, m: &str| st.send(id, &json!({ "t": "error", "msg": m }));

        match t {
            "ping" => st.send(id, &json!({ "t": "pong" })),

            "msg" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                let text = v["text"].as_str().unwrap_or("").trim().to_string();
                if text.is_empty() || text.chars().count() > 4000 {
                    return;
                }
                let Some(targets) = st.room_targets(&room, &user) else {
                    return err(&st, "Unknown room");
                };
                let msg = Msg { id: st.next_msg, room: room.clone(), from: user.clone(), text, ts: now_ms() };
                st.next_msg += 1;
                let h = st.history.entry(room.clone()).or_default();
                h.push_back(msg.clone());
                while h.len() > HISTORY_CAP {
                    h.pop_front();
                }
                st.dirty = true;
                let out = json!({ "t": "msg", "room": room, "msg": msg }).to_string();
                for c in targets {
                    if let Some(c) = st.conns.get(&c) {
                        let _ = c.tx.send(out.clone());
                    }
                }
            }

            "typing" => {
                let room = v["room"].as_str().unwrap_or("");
                if let Some(targets) = st.room_targets(room, &user) {
                    let out = json!({ "t": "typing", "room": room, "from": user }).to_string();
                    for c in targets.into_iter().filter(|c| *c != id) {
                        if let Some(c) = st.conns.get(&c) {
                            let _ = c.tx.send(out.clone());
                        }
                    }
                }
            }

            "dm" => {
                let to = v["to"].as_str().unwrap_or("").trim().to_string();
                let Some(other) = st.users.get(&key(&to)).map(|u| u.name.clone()) else {
                    return err(&st, "User not found");
                };
                if key(&other) == key(&user) {
                    return err(&st, "You cannot message yourself");
                }
                let rid = dm_id(&user, &other);
                st.history.entry(rid.clone()).or_default();
                st.dirty = true;
                st.send_user(&user, &json!({ "t": "dm_room", "room": { "id": rid, "kind": "dm", "with": other, "name": other } }));
                st.send_user(&other, &json!({ "t": "dm_room", "room": { "id": rid, "kind": "dm", "with": user, "name": user } }));
                st.send_user(&user, &json!({ "t": "history", "room": rid, "msgs": st.history.get(&rid) }));
                st.send_user(&other, &json!({ "t": "history", "room": rid, "msgs": st.history.get(&rid) }));
            }

            "create_room" => {
                let name = v["name"].as_str().unwrap_or("").trim().to_string();
                let kind = if v["kind"].as_str() == Some("voice") { "voice" } else { "text" };
                if !(2..=24).contains(&name.chars().count()) {
                    return err(&st, "Room name: 2–24 characters");
                }
                let mut rid = slug(&name);
                if rid.is_empty() || st.rooms.iter().any(|r| r.id == rid) {
                    rid = format!("{rid}-{}", st.next_room);
                    st.next_room += 1;
                }
                st.rooms.push(Room { id: rid, name, kind: kind.into(), topic: String::new() });
                st.dirty = true;
                let r = st.rooms_json();
                st.broadcast(&json!({ "t": "rooms", "rooms": r }));
            }

            "status" => {
                let s = match v["status"].as_str() {
                    Some("away") => "away",
                    Some("dnd") => "dnd",
                    _ => "online",
                };
                if let Some(c) = st.conns.get_mut(&id) {
                    c.status = s.into();
                }
                let p = st.presence_json();
                st.broadcast(&p);
            }

            // ───────── voice / video (WebRTC signaling only, media is peer-to-peer) ─────────
            "voice_join" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                let known = st.calls.contains(&room) || st.rooms.iter().any(|r| r.id == room && r.kind == "voice");
                if !known {
                    return err(&st, "Unknown voice room");
                }
                st.leave_voice(id);
                let me = VoiceMember {
                    conn: id, user: user.clone(), room: room.clone(),
                    video: v["video"].as_bool().unwrap_or(false), screen: false, muted: false, deaf: false,
                };
                let others = st.voice_members(&room);
                if others.len() >= 8 {
                    return err(&st, "This voice room is full (max. 8)");
                }
                if let Some(c) = st.conns.get_mut(&id) {
                    c.voice = Some(me.clone());
                }
                st.send(id, &json!({ "t": "voice_members", "room": room, "members": others }));
                for m in &others {
                    st.send(m.conn, &json!({ "t": "voice_joined", "room": room, "member": me }));
                }
                let vr = st.voice_rooms_json();
                st.broadcast(&vr);
                let p = st.presence_json();
                st.broadcast(&p);
            }
            "voice_leave" => {
                st.leave_voice(id);
            }
            "voice_state" => {
                let room = {
                    let Some(m) = st.conns.get_mut(&id).and_then(|c| c.voice.as_mut()) else { return };
                    if let Some(b) = v["muted"].as_bool() { m.muted = b; }
                    if let Some(b) = v["deaf"].as_bool() { m.deaf = b; }
                    if let Some(b) = v["video"].as_bool() { m.video = b; }
                    if let Some(b) = v["screen"].as_bool() { m.screen = b; }
                    m.room.clone()
                };
                let me = st.conns.get(&id).and_then(|c| c.voice.clone());
                for m in st.voice_members(&room) {
                    if m.conn != id {
                        st.send(m.conn, &json!({ "t": "voice_state", "room": room, "member": me }));
                    }
                }
                let vr = st.voice_rooms_json();
                st.broadcast(&vr);
            }
            "signal" => {
                let to = v["to"].as_u64().unwrap_or(0);
                let same_room = {
                    let a = st.conns.get(&id).and_then(|c| c.voice.as_ref()).map(|m| m.room.clone());
                    let b = st.conns.get(&to).and_then(|c| c.voice.as_ref()).map(|m| m.room.clone());
                    a.is_some() && a == b
                };
                if same_room {
                    st.send(to, &json!({ "t": "signal", "from": id, "user": user, "data": v["data"] }));
                }
            }

            // ───────── calls (1:1 or group invites) ─────────
            "call" => {
                let to = v["to"].as_str().unwrap_or("").trim().to_string();
                let video = v["video"].as_bool().unwrap_or(false);
                let Some(other) = st.users.get(&key(&to)).map(|u| u.name.clone()) else {
                    return err(&st, "User not found");
                };
                if !st.conns.values().any(|c| key(&c.user) == key(&other)) {
                    return err(&st, &format!("{other} is offline"));
                }
                let room = format!("call:{}", &random_token()[..10]);
                st.calls.insert(room.clone());
                st.send(id, &json!({ "t": "call_started", "room": room, "to": other, "video": video }));
                st.send_user(&other, &json!({ "t": "call_incoming", "room": room, "from": user, "video": video, "group": false }));
            }
            "call_invite" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                let to = v["to"].as_str().unwrap_or("").to_string();
                let in_room = st.conns.get(&id).and_then(|c| c.voice.as_ref()).map(|m| m.room == room).unwrap_or(false);
                if !in_room {
                    return err(&st, "Join the room first");
                }
                if let Some(other) = st.users.get(&key(&to)).map(|u| u.name.clone()) {
                    st.send_user(&other, &json!({ "t": "call_incoming", "room": room, "from": user, "video": false, "group": true }));
                }
            }
            "call_accept" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                for m in st.voice_members(&room) {
                    st.send(m.conn, &json!({ "t": "call_accepted", "room": room, "by": user }));
                }
                // dismiss the ringing on the user's other sessions
                let others: Vec<u64> = st.conns.iter().filter(|(c, x)| **c != id && key(&x.user) == key(&user)).map(|(c, _)| *c).collect();
                for c in others {
                    st.send(c, &json!({ "t": "call_handled", "room": room }));
                }
            }
            "call_decline" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                for m in st.voice_members(&room) {
                    st.send(m.conn, &json!({ "t": "call_declined", "room": room, "by": user }));
                }
                let others: Vec<u64> = st.conns.iter().filter(|(c, x)| **c != id && key(&x.user) == key(&user)).map(|(c, _)| *c).collect();
                for c in others {
                    st.send(c, &json!({ "t": "call_handled", "room": room }));
                }
                st.drop_call_if_empty(&room);
            }
            "call_cancel" => {
                let room = v["room"].as_str().unwrap_or("").to_string();
                st.broadcast(&json!({ "t": "call_cancelled", "room": room }));
                st.drop_call_if_empty(&room);
            }
            _ => {}
        }
    }
}

fn is_local_host(h: &str) -> bool {
    h == "localhost" || h == "::1" || h.starts_with("127.")
}

impl Hub {
    /// STUN for everyone, plus the built-in TURN relay for clients that reach this server
    /// through a non-local address (the address they used is also the relay address).
    fn ice_servers(&self, host: Option<&str>) -> Value {
        let mut v = vec![json!({ "urls": ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] })];
        if let (Some((secret, port)), Some(h)) = (&self.cfg.turn, host.filter(|h| !is_local_host(h))) {
            if let Ok((user, cred)) = turn::auth::generate_long_term_credentials(secret, Duration::from_secs(8 * 3600)) {
                let h = if h.contains(':') { format!("[{h}]") } else { h.to_string() };
                v.push(json!({
                    "urls": [format!("stun:{h}:{port}"), format!("turn:{h}:{port}?transport=udp")],
                    "username": user, "credential": cred,
                }));
            }
        }
        if let Ok(url) = std::env::var("NEXUS_TURN_URL") {
            v.push(json!({
                "urls": [url],
                "username": std::env::var("NEXUS_TURN_USER").unwrap_or_default(),
                "credential": std::env::var("NEXUS_TURN_PASS").unwrap_or_default(),
            }));
        }
        Value::Array(v)
    }
}
impl State {
    fn send(&self, conn: u64, v: &Value) {
        if let Some(c) = self.conns.get(&conn) {
            let _ = c.tx.send(v.to_string());
        }
    }

    fn send_user(&self, user: &str, v: &Value) {
        let s = v.to_string();
        for c in self.conns.values().filter(|c| key(&c.user) == key(user)) {
            let _ = c.tx.send(s.clone());
        }
    }

    fn broadcast(&self, v: &Value) {
        let s = v.to_string();
        for c in self.conns.values() {
            let _ = c.tx.send(s.clone());
        }
    }

    fn dm_has(&self, room: &str, user: &str) -> bool {
        dm_parts(room).map(|(a, b)| a == key(user) || b == key(user)).unwrap_or(false)
    }

    /// Connections allowed to see a room: everyone for public text rooms, both users for a DM.
    fn room_targets(&self, room: &str, user: &str) -> Option<Vec<u64>> {
        if let Some((a, b)) = dm_parts(room) {
            if key(user) != a && key(user) != b {
                return None;
            }
            return Some(self.conns.iter().filter(|(_, c)| key(&c.user) == a || key(&c.user) == b).map(|(i, _)| *i).collect());
        }
        if self.rooms.iter().any(|r| r.id == room && r.kind == "text") {
            return Some(self.conns.keys().copied().collect());
        }
        None
    }

    fn rooms_json(&self) -> Value {
        json!(self.rooms)
    }

    fn dms_json(&self, user: &str) -> Value {
        let k = key(user);
        let list: Vec<Value> = self
            .history
            .keys()
            .filter_map(|id| {
                let (a, b) = dm_parts(id)?;
                let other = if a == k { b } else if b == k { a } else { return None };
                let name = self.users.get(&other).map(|u| u.name.clone()).unwrap_or(other);
                Some(json!({ "id": id, "kind": "dm", "with": name, "name": name }))
            })
            .collect();
        json!(list)
    }

    fn presence_json(&self) -> Value {
        let mut online: HashMap<String, (&str, Option<String>)> = HashMap::new();
        for c in self.conns.values() {
            let e = online.entry(key(&c.user)).or_insert((c.status.as_str(), None));
            if let Some(v) = &c.voice {
                e.1 = Some(v.room.clone());
            }
        }
        let mut users: Vec<Value> = self
            .users
            .iter()
            .map(|(k, u)| {
                let o = online.get(k);
                json!({
                    "name": u.name, "online": o.is_some(),
                    "status": o.map(|o| o.0).unwrap_or("offline"), "voice": o.and_then(|o| o.1.clone()),
                })
            })
            .collect();
        users.sort_by_key(|u| (!u["online"].as_bool().unwrap_or(false), u["name"].as_str().unwrap_or("").to_lowercase()));
        json!({ "t": "presence", "users": users })
    }

    fn voice_members(&self, room: &str) -> Vec<VoiceMember> {
        self.conns.values().filter_map(|c| c.voice.clone()).filter(|m| m.room == room).collect()
    }

    fn voice_rooms_json(&self) -> Value {
        let mut map: HashMap<String, Vec<VoiceMember>> = HashMap::new();
        for c in self.conns.values() {
            if let Some(v) = &c.voice {
                map.entry(v.room.clone()).or_default().push(v.clone());
            }
        }
        json!({ "t": "voice_rooms", "rooms": map })
    }

    fn drop_call_if_empty(&mut self, room: &str) {
        if self.calls.contains(room) && self.voice_members(room).is_empty() {
            self.calls.remove(room);
        }
    }

    fn leave_voice(&mut self, id: u64) {
        let Some(m) = self.conns.get_mut(&id).and_then(|c| c.voice.take()) else { return };
        for o in self.voice_members(&m.room) {
            self.send(o.conn, &json!({ "t": "voice_left", "room": m.room, "conn": id }));
        }
        self.drop_call_if_empty(&m.room);
        let vr = self.voice_rooms_json();
        self.broadcast(&vr);
        let p = self.presence_json();
        self.broadcast(&p);
    }
}
