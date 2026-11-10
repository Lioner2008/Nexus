#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod art;
mod genres;
mod scan;
mod ts;
mod vdf;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager, State};

// ───────────────────────────── data model ─────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub installed: bool,
    pub install_path: Option<String>,
    pub exe: Option<String>,
    pub args: Option<String>,
    pub launch_uri: Option<String>,
    pub install_uri: Option<String>,
    pub steam_appid: Option<u32>,
    pub size_bytes: Option<u64>,
    pub playtime_min: Option<u64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    pub sgdb_key: String,
    pub steam_key: String,
    pub favorites: Vec<String>,
    pub last_played: HashMap<String, u64>,
    // appearance
    pub theme: String,
    pub accent: String,
    pub bg_tone: String,
    pub no_motion: bool,
    // behaviour
    pub skip_startup_scan: bool,
    pub minimize_on_launch: bool,
    // extra Star Citizen / RSI Launcher library folder
    pub rsi_path: String,
    // social: chat / calls server, remembered login (token only, never the password)
    pub social_server: String,
    pub social_user: String,
    pub social_token: String,
    // TeamSpeak 3 ClientQuery: API key + address, stored locally
    pub ts_api_key: String,
    pub ts_address: String,
    // do not start the local Nexus server together with the launcher
    pub no_local_server: bool,
    // chosen audio/video devices (empty = system default)
    pub mic_id: String,
    pub speaker_id: String,
    pub cam_id: String,
    // internet mode: server reachable from other networks (UPnP + TURN relay + invite code)
    pub internet_mode: bool,
    pub invite_code: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Art {
    pub cover: Option<String>,
    pub hero: Option<String>,
    pub logo: Option<String>,
    pub icon: Option<String>,
    pub cover_tried: bool,
    pub extras_tried: bool,
    // artwork picked by the user: never replaced by automatic matching
    pub cover_custom: bool,
    pub hero_custom: bool,
    pub logo_custom: bool,
    pub icon_custom: bool,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Cache {
    pub library: Vec<Game>,
    pub art: HashMap<String, Art>,
    pub genres: HashMap<String, Vec<String>>,
    pub genre_miss: HashSet<String>,
    pub sgdb_ids: HashMap<String, u64>,
}

pub struct AppState {
    pub dir: PathBuf,
    pub settings: Mutex<Settings>,
    pub cache: Mutex<Cache>,
    pub http: reqwest::Client,
    pub enriching: AtomicBool,
    pub io_lock: Mutex<()>,
    pub ts: tokio::sync::Mutex<Option<ts::TsConn>>,
}

impl AppState {
    pub fn save_settings(&self) {
        let _g = self.io_lock.lock().unwrap();
        let s = self.settings.lock().unwrap().clone();
        if let Ok(b) = serde_json::to_vec_pretty(&s) {
            let _ = std::fs::write(self.dir.join("settings.json"), b);
        }
    }

    pub fn save_cache(&self) {
        let _g = self.io_lock.lock().unwrap();
        let c = self.cache.lock().unwrap();
        if let Ok(b) = serde_json::to_vec(&*c) {
            let _ = std::fs::write(self.dir.join("cache.json"), b);
        }
    }
}

/// Lower-case alphanumerics only – used to compare game titles.
pub fn norm(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn read_json<T: DeserializeOwned + Default>(p: impl AsRef<Path>) -> T {
    std::fs::read(p)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

// ───────────────────────────── OS helpers ─────────────────────────────

#[cfg(windows)]
fn open_uri(uri: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", uri])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn open_uri(uri: &str) -> Result<(), String> {
    Command::new("xdg-open")
        .arg(uri)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn spawn_exe(exe: &str, args: Option<&str>) -> Result<(), String> {
    let p = Path::new(exe);
    let mut c = Command::new(p);
    if let Some(dir) = p.parent() {
        c.current_dir(dir);
    }
    if let Some(a) = args {
        c.args(a.split_whitespace());
    }
    c.spawn().map(|_| ()).map_err(|e| format!("Could not start: {e}"))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ───────────────────────────── commands ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Boot {
    settings: Settings,
    library: Vec<Game>,
    art: HashMap<String, Art>,
    genres: HashMap<String, Vec<String>>,
}

#[tauri::command]
fn bootstrap(state: State<'_, AppState>) -> Boot {
    let c = state.cache.lock().unwrap();
    Boot {
        settings: state.settings.lock().unwrap().clone(),
        library: c.library.clone(),
        art: c.art.clone(),
        genres: c.genres.clone(),
    }
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) {
    *state.settings.lock().unwrap() = settings;
    state.save_settings();
}

#[tauri::command]
async fn scan_library(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<Game>, String> {
    let (steam_key, rsi_path) = {
        let s = state.settings.lock().unwrap();
        (s.steam_key.clone(), s.rsi_path.clone())
    };
    let games = scan::scan_all(&app, &state.http, &steam_key, &rsi_path).await;
    state.cache.lock().unwrap().library = games.clone();
    state.save_cache();
    Ok(games)
}

#[tauri::command]
fn launch_game(game: Game, state: State<'_, AppState>) -> Result<u64, String> {
    if let Some(exe) = &game.exe {
        spawn_exe(exe, game.args.as_deref())?;
    } else if let Some(uri) = &game.launch_uri {
        open_uri(uri)?;
    } else {
        return Err("No launch command found for this game".into());
    }
    let ts = now_secs();
    state
        .settings
        .lock()
        .unwrap()
        .last_played
        .insert(game.id, ts);
    state.save_settings();
    Ok(ts)
}

#[tauri::command]
fn install_game(game: Game) -> Result<(), String> {
    match &game.install_uri {
        Some(uri) => open_uri(uri),
        None => Err("Install this game from its launcher".into()),
    }
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    #[cfg(windows)]
    let prog = "explorer";
    #[cfg(not(windows))]
    let prog = "xdg-open";
    Command::new(prog)
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Deletes all downloaded artwork; it is fetched again on demand.
#[tauri::command]
fn clear_art_cache(state: State<'_, AppState>) -> usize {
    let n = std::fs::read_dir(state.dir.join("art"))
        .map(|d| d.count())
        .unwrap_or(0);
    let _ = std::fs::remove_dir_all(state.dir.join("art"));
    {
        // artwork chosen by the user lives in art_custom/ and is kept
        let mut c = state.cache.lock().unwrap();
        for a in c.art.values_mut() {
            if !a.cover_custom {
                a.cover = None;
                a.cover_tried = false;
            }
            if !a.hero_custom {
                a.hero = None;
            }
            if !a.logo_custom {
                a.logo = None;
            }
            if !a.icon_custom {
                a.icon = None;
            }
            a.extras_tried = false;
        }
        c.art.retain(|_, a| {
            a.cover.is_some() || a.hero.is_some() || a.logo.is_some() || a.icon.is_some()
        });
        c.sgdb_ids.clear();
    }
    state.save_cache();
    n
}

#[tauri::command]
fn open_data_folder(state: State<'_, AppState>) -> Result<(), String> {
    open_folder(state.dir.to_string_lossy().to_string())
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("blocked".into());
    }
    open_uri(&url)
}

#[tauri::command]
async fn fetch_cover(
    state: State<'_, AppState>,
    id: String,
    name: String,
    steam_appid: Option<u32>,
) -> Result<Option<String>, String> {
    art::ensure_cover(&state, &id, &name, steam_appid).await
}

#[tauri::command]
async fn fetch_extras(
    state: State<'_, AppState>,
    id: String,
    name: String,
    steam_appid: Option<u32>,
) -> Result<Art, String> {
    art::ensure_extras(&state, &id, &name, steam_appid).await
}

/// All SteamGridDB alternatives for one artwork type ("cover", "hero", "logo", "icon").
#[tauri::command]
async fn list_art_options(
    state: State<'_, AppState>,
    id: String,
    name: String,
    steam_appid: Option<u32>,
    kind: String,
) -> Result<Vec<art::ArtOption>, String> {
    art::list_options(&state, &id, &name, steam_appid, &kind).await
}

/// Uses an https image URL or a local image file as the artwork for one game.
#[tauri::command]
async fn set_art(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    source: String,
) -> Result<Art, String> {
    art::set_custom(&state, &id, &kind, &source).await
}

/// Removes the user's choice again; automatic matching takes over.
#[tauri::command]
fn reset_art(state: State<'_, AppState>, id: String, kind: String) -> Result<Art, String> {
    art::reset_custom(&state, &id, &kind)
}

#[tauri::command]
async fn test_sgdb_key(state: State<'_, AppState>, key: String) -> Result<String, String> {
    art::test_key(&state, &key).await
}

/// Fetches genres for all games in the background (rate-limited, cached forever).
#[tauri::command]
fn start_enrich(app: AppHandle, state: State<'_, AppState>) {
    if state.enriching.swap(true, Ordering::SeqCst) {
        return;
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        let st = app2.state::<AppState>();
        run_enrich(&app2, &st).await;
        st.enriching.store(false, Ordering::SeqCst);
    });
}

async fn run_enrich(app: &AppHandle, st: &AppState) {
    let mut todo: Vec<Game> = {
        let c = st.cache.lock().unwrap();
        c.library
            .iter()
            .filter(|g| !c.genres.contains_key(&g.id) && !c.genre_miss.contains(&g.id))
            .cloned()
            .collect()
    };
    todo.sort_by_key(|g| !g.installed);

    for (n, g) in todo.iter().enumerate() {
        // Star Citizen is not on Steam: use fixed genres instead of a store lookup.
        if g.platform == "rsi" {
            let list: Vec<String> = ["Simulation", "Action", "MMO"].map(String::from).to_vec();
            st.cache.lock().unwrap().genres.insert(g.id.clone(), list.clone());
            let _ = app.emit(
                "genres-updated",
                serde_json::json!({ "id": g.id, "genres": list }),
            );
            continue;
        }
        match genres::lookup(&st.http, &g.name, g.steam_appid).await {
            Ok(Some(list)) => {
                st.cache
                    .lock()
                    .unwrap()
                    .genres
                    .insert(g.id.clone(), list.clone());
                let _ = app.emit(
                    "genres-updated",
                    serde_json::json!({ "id": g.id, "genres": list }),
                );
            }
            Ok(None) => {
                st.cache.lock().unwrap().genre_miss.insert(g.id.clone());
            }
            Err(e) => {
                let wait = if e == "429" { 60 } else { 5 };
                tokio::time::sleep(Duration::from_secs(wait)).await;
                continue;
            }
        }
        if n % 10 == 9 {
            st.save_cache();
        }
        tokio::time::sleep(Duration::from_millis(1500)).await;
    }
    st.save_cache();
}

// ───────────────────────────── local Nexus server ─────────────────────────────

const LOCAL_SERVER: &str = "127.0.0.1:7777";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ServerStatus {
    running: bool,
    address: String,
    has_binary: bool,
    internet: bool,
    invite_code: String,
    /// network details reported by the server (public address, UPnP, TURN)
    info: Option<serde_json::Value>,
}

fn server_exe() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    ["nexus-server.exe", "nexus-server"]
        .iter()
        .map(|n| dir.join(n))
        .find(|p| p.exists())
}

async fn port_open(addr: &str) -> bool {
    tokio::time::timeout(Duration::from_millis(500), tokio::net::TcpStream::connect(addr))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

/// Command line of the server: local only, or open to the internet with relay and invite code.
fn server_args(internet: bool, invite: &str, data: &Path) -> Vec<String> {
    let mut a = vec![
        "--bind".to_string(),
        if internet { "0.0.0.0:7777".to_string() } else { LOCAL_SERVER.to_string() },
        "--data".to_string(),
        data.to_string_lossy().to_string(),
    ];
    if internet {
        a.push("--turn".into());
        a.push("--upnp".into());
        if !invite.is_empty() {
            a.push("--invite".into());
            a.push(invite.to_string());
        }
    }
    a
}

#[cfg(windows)]
fn spawn_detached(exe: &Path, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // CREATE_NO_WINDOW | DETACHED_PROCESS: the server keeps running without a console
    Command::new(exe)
        .args(args)
        .creation_flags(0x0800_0000 | 0x0000_0008)
        .spawn()
        .map(|_| ())
}

#[cfg(not(windows))]
fn spawn_detached(exe: &Path, args: &[String]) -> std::io::Result<()> {
    Command::new(exe).args(args).spawn().map(|_| ())
}

/// Starts the server when nothing listens on the port yet; waits up to `wait_ms` for it.
async fn ensure_local_server(dir: &Path, internet: bool, invite: &str, wait_ms: u64) -> Result<bool, String> {
    if port_open(LOCAL_SERVER).await {
        return Ok(true);
    }
    let exe = server_exe().ok_or("nexus-server.exe was not found next to Nexus")?;
    let data = dir.join("server");
    std::fs::create_dir_all(&data).ok();
    spawn_detached(&exe, &server_args(internet, invite, &data)).map_err(|e| format!("Could not start the server: {e}"))?;
    let mut waited = 0;
    while waited < wait_ms {
        tokio::time::sleep(Duration::from_millis(150)).await;
        waited += 150;
        if port_open(LOCAL_SERVER).await {
            return Ok(true);
        }
    }
    Err("The server did not start in time".into())
}

async fn status_full(state: &AppState) -> ServerStatus {
    let running = port_open(LOCAL_SERVER).await;
    let (internet, invite_code) = {
        let s = state.settings.lock().unwrap();
        (s.internet_mode, s.invite_code.clone())
    };
    let info = if running {
        match state.http.get(format!("http://{LOCAL_SERVER}/api/admin/info")).send().await {
            Ok(r) => r.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        }
    } else {
        None
    };
    ServerStatus { running, address: LOCAL_SERVER.into(), has_binary: server_exe().is_some(), internet, invite_code, info }
}

async fn stop_server(state: &AppState) {
    let _ = state.http.post(format!("http://{LOCAL_SERVER}/api/admin/shutdown")).send().await;
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(150)).await;
        if !port_open(LOCAL_SERVER).await {
            return;
        }
    }
}

/// 8 readable characters (no 0/O/1/I) for the invite code.
fn new_invite_code() -> String {
    use rand::Rng;
    const A: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut r = rand::thread_rng();
    (0..8).map(|_| A[r.gen_range(0..A.len())] as char).collect()
}

#[tauri::command]
async fn server_status(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    Ok(status_full(&state).await)
}

#[tauri::command]
async fn start_local_server(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    let (internet, invite) = {
        let s = state.settings.lock().unwrap();
        (s.internet_mode, s.invite_code.clone())
    };
    ensure_local_server(&state.dir, internet, &invite, if internet { 60_000 } else { 3_000 }).await?;
    Ok(status_full(&state).await)
}

#[tauri::command]
async fn stop_local_server(state: State<'_, AppState>) -> Result<ServerStatus, String> {
    stop_server(&state).await;
    Ok(status_full(&state).await)
}

/// Switches the server between "this PC only" and "reachable from the internet" (restarts it).
#[tauri::command]
async fn set_internet_mode(state: State<'_, AppState>, enabled: bool) -> Result<ServerStatus, String> {
    let invite = {
        let mut s = state.settings.lock().unwrap();
        s.internet_mode = enabled;
        if enabled && s.invite_code.is_empty() {
            s.invite_code = new_invite_code();
        }
        s.invite_code.clone()
    };
    state.save_settings();
    stop_server(&state).await;
    // UPnP discovery and port mapping can take a while
    ensure_local_server(&state.dir, enabled, &invite, 60_000).await?;
    Ok(status_full(&state).await)
}
// ───────────────────────────── TeamSpeak 3 (ClientQuery) ─────────────────────────────

/// Runs a call on the active TeamSpeak connection and drops the connection when it is dead.
macro_rules! ts_call {
    ($state:expr, $c:ident => $body:expr) => {{
        let mut g = $state.ts.lock().await;
        match g.as_ref() {
            None => Err("Not connected to the TeamSpeak client".to_string()),
            Some($c) => {
                let r = $body.await;
                if let Err(e) = &r {
                    if e.contains("closed") || e.contains("did not answer") || e.contains("lost") {
                        *g = None;
                    }
                }
                r
            }
        }
    }};
}

#[tauri::command]
async fn ts_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    api_key: String,
    address: Option<String>,
) -> Result<(), String> {
    let key = api_key.trim().to_string();
    if key.is_empty() {
        return Err("Enter the ClientQuery API key from TeamSpeak first".into());
    }
    let addr = address
        .map(|a| a.trim().to_string())
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| {
            let a = state.settings.lock().unwrap().ts_address.clone();
            if a.is_empty() { ts::DEFAULT_ADDRESS.to_string() } else { a }
        });
    {
        // remember the key on this PC right away (settings.json in the app data folder)
        let mut s = state.settings.lock().unwrap();
        s.ts_api_key = key.clone();
        s.ts_address = addr.clone();
    }
    state.save_settings();

    let app2 = app.clone();
    let emit: ts::Emit = Arc::new(move |name: &str, v: serde_json::Value| {
        let _ = app2.emit(name, v);
    });
    let conn = ts::connect(&addr, &key, emit, Arc::new(|| {})).await?;
    *state.ts.lock().await = Some(conn);
    Ok(())
}

#[tauri::command]
async fn ts_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    *state.ts.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn ts_connected(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.ts.lock().await.is_some())
}

#[tauri::command]
async fn ts_overview(state: State<'_, AppState>) -> Result<ts::TsOverview, String> {
    ts_call!(state, c => ts::overview(c))
}

#[tauri::command]
async fn ts_join_channel(state: State<'_, AppState>, clid: i64, cid: i64) -> Result<(), String> {
    ts_call!(state, c => ts::join_channel(c, clid, cid))
}

#[tauri::command]
async fn ts_set_mute(
    state: State<'_, AppState>,
    input: Option<bool>,
    output: Option<bool>,
) -> Result<(), String> {
    ts_call!(state, c => ts::set_mute(c, input, output))
}

#[tauri::command]
async fn ts_send_text(state: State<'_, AppState>, cid: i64, msg: String) -> Result<(), String> {
    ts_call!(state, c => ts::send_channel_text(c, cid, &msg))
}

// ───────────────────────────── entry point ─────────────────────────────
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir).ok();
            let settings: Settings = read_json(dir.join("settings.json"));
            let cache: Cache = read_json(dir.join("cache.json"));
            let http = reqwest::Client::builder()
                .user_agent("Nexus/0.1")
                .timeout(Duration::from_secs(30))
                .build()?;
            app.manage(AppState {
                dir,
                settings: Mutex::new(settings),
                cache: Mutex::new(cache),
                http,
                enriching: AtomicBool::new(false),
                io_lock: Mutex::new(()),
                ts: tokio::sync::Mutex::new(None),
            });
            // start the local social server in the background unless the user switched that off
            let (auto, internet, invite) = {
                let st = app.state::<AppState>();
                let s = st.settings.lock().unwrap();
                (!s.no_local_server, s.internet_mode, s.invite_code.clone())
            };
            if auto {
                let dir = app.state::<AppState>().dir.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = ensure_local_server(&dir, internet, &invite, 60_000).await {
                        eprintln!("local server: {e}");
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_settings,
            scan_library,
            launch_game,
            install_game,
            open_folder,
            open_url,
            clear_art_cache,
            open_data_folder,
            fetch_cover,
            fetch_extras,
            test_sgdb_key,
            server_status,
            start_local_server,
            stop_local_server,
            set_internet_mode,
            ts_connect,
            ts_disconnect,
            ts_connected,
            ts_overview,
            ts_join_channel,
            ts_set_mute,
            ts_send_text,
            list_art_options,
            set_art,
            reset_art,
            start_enrich,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
