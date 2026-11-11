#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod art;
mod artq;
mod genres;
mod library;
mod scan;
mod sound;
mod ts;
mod update;
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
    // updates: do not check automatically / version the user chose to skip
    pub no_update_check: bool,
    pub skip_version: String,
    /// do not download and install updates automatically (they are still offered)
    pub no_auto_install: bool,
    // calls
    pub no_call_sounds: bool,
    pub no_auto_watch: bool,
    pub sounds: Vec<Sound>,
    pub peer_volumes: HashMap<String, f64>,
    pub sfx_volume: Option<f64>,
}

/// A sound effect the user added to the call soundboard.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default)]
pub struct Sound {
    pub name: String,
    pub path: String,
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
    pub update: tokio::sync::Mutex<Option<update::UpdateInfo>>,
    /// installer downloaded in the background, run when Nexus quits
    pub update_ready: Mutex<Option<update::Ready>>,
    pub update_busy: AtomicBool,
    /// cover downloads for the grid
    pub artq: artq::ArtQueue,
    /// base URL of the `art` protocol as the web view sees it
    pub art_base: Mutex<String>,
    /// web view memory target currently set to "low"
    pub mem_low: AtomicBool,
}

/// Runs `f` with a read-only view of library, artwork, genres and settings.
pub fn with_ctx<R>(st: &AppState, f: impl FnOnce(&library::Ctx) -> R) -> R {
    let c = st.cache.lock().unwrap();
    let s = st.settings.lock().unwrap();
    let base = st.art_base.lock().unwrap().clone();
    let ctx = library::Ctx {
        games: &c.library,
        art: &c.art,
        genres: &c.genres,
        settings: &s,
        art_base: &base,
        now: now_secs(),
    };
    f(&ctx)
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

pub fn now_secs() -> u64 {
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
    has_library: bool,
}

/// First call of the UI. `art_base` is the URL prefix of the `art` protocol in this web view.
#[tauri::command]
fn bootstrap(state: State<'_, AppState>, art_base: Option<String>) -> Boot {
    if let Some(b) = art_base.filter(|b| b.starts_with("http")) {
        *state.art_base.lock().unwrap() = if b.ends_with('/') { b } else { format!("{b}/") };
    }
    let has_library = !state.cache.lock().unwrap().library.is_empty();
    Boot { settings: state.settings.lock().unwrap().clone(), has_library }
}

/// The settings dialog saves everything at once; values Rust owns itself are kept.
#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) -> Settings {
    let (key_changed, out) = {
        let mut cur = state.settings.lock().unwrap();
        let mut next = settings;
        next.favorites = std::mem::take(&mut cur.favorites);
        next.last_played = std::mem::take(&mut cur.last_played);
        next.internet_mode = cur.internet_mode;
        next.invite_code = std::mem::take(&mut cur.invite_code);
        let changed = next.sgdb_key.trim() != cur.sgdb_key.trim();
        *cur = next;
        (changed, cur.clone())
    };
    state.save_settings();
    if key_changed {
        state.artq.dead.store(false, Ordering::SeqCst);
        state.artq.clear();
        artq::queue_all(&state);
    }
    out
}

/// Filtered and sorted library with the ready-made HTML of every card.
#[tauri::command]
fn library_view(state: State<'_, AppState>, query: library::Query) -> library::View {
    with_ctx(&state, |ctx| ctx.view(&query))
}

/// Fetches banner, logo and icon of one game in the background and sends the new header.
fn spawn_extras(app: AppHandle, g: Game) {
    tauri::async_runtime::spawn(async move {
        let st = app.state::<AppState>();
        if art::ensure_extras(&st, &g.id, &g.name, g.steam_appid).await.is_ok() {
            if let Some(h) = with_ctx(&st, |ctx| ctx.hero(&g.id)) {
                let _ = app.emit("hero-updated", h);
            }
        }
    });
}

/// Header of one game. Missing banner/logo/icon are fetched in the background (`hero-updated`).
#[tauri::command]
fn hero_view(app: AppHandle, state: State<'_, AppState>, id: Option<String>) -> Option<library::Hero> {
    let known = id.filter(|i| state.cache.lock().unwrap().library.iter().any(|g| g.id == *i));
    let id = match known {
        Some(i) => i,
        None => with_ctx(&state, |ctx| ctx.default_selection())?,
    };
    let hero = with_ctx(&state, |ctx| ctx.hero(&id));
    let has_key = !state.settings.lock().unwrap().sgdb_key.trim().is_empty();
    let tried = state.cache.lock().unwrap().art.get(&id).map(|a| a.extras_tried).unwrap_or(false);
    if has_key && !tried {
        if let Ok(g) = find_game(&state, &id) {
            spawn_extras(app, g);
        }
    }
    hero
}

/// Cards currently on screen: their covers are downloaded first.
#[tauri::command]
fn art_visible(state: State<'_, AppState>, ids: Vec<String>) {
    if state.artq.dead.load(Ordering::SeqCst) || state.settings.lock().unwrap().sgdb_key.trim().is_empty() {
        return;
    }
    let need: Vec<String> = {
        let c = state.cache.lock().unwrap();
        ids.into_iter()
            .filter(|id| c.art.get(id).map(|a| a.cover.is_none() && !a.cover_tried).unwrap_or(true))
            .filter(|id| c.library.iter().any(|g| g.id == *id))
            .take(64)
            .collect()
    };
    if !need.is_empty() {
        state.artq.push_front(&need);
    }
}

#[tauri::command]
fn toggle_favorite(state: State<'_, AppState>, id: String) -> bool {
    let on = {
        let mut s = state.settings.lock().unwrap();
        if let Some(i) = s.favorites.iter().position(|f| *f == id) {
            s.favorites.remove(i);
            false
        } else {
            s.favorites.push(id);
            true
        }
    };
    state.save_settings();
    on
}

/// Starts genre lookups and cover downloads for everything that is still missing.
fn start_background_work(app: &AppHandle) {
    let st = app.state::<AppState>();
    artq::queue_all(&st);
    start_enrich(app.clone(), st);
}

#[tauri::command]
async fn scan_library(app: AppHandle, state: State<'_, AppState>) -> Result<usize, String> {
    let (steam_key, rsi_path) = {
        let s = state.settings.lock().unwrap();
        (s.steam_key.clone(), s.rsi_path.clone())
    };
    let games = scan::scan_all(&app, &state.http, &steam_key, &rsi_path).await;
    let n = games.len();
    state.cache.lock().unwrap().library = games;
    state.save_cache();
    start_background_work(&app);
    Ok(n)
}

fn find_game(state: &AppState, id: &str) -> Result<Game, String> {
    state
        .cache
        .lock()
        .unwrap()
        .library
        .iter()
        .find(|g| g.id == id)
        .cloned()
        .ok_or_else(|| "This game is no longer in the library".to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Played {
    launched: bool,
    ts: u64,
    minimize: bool,
    message: String,
}

/// Play button: starts an installed game, otherwise opens its launcher to install it.
#[tauri::command]
fn play_game(id: String, state: State<'_, AppState>) -> Result<Played, String> {
    let game = find_game(&state, &id)?;
    if !game.installed {
        let message = install_game(id, state)?;
        return Ok(Played { launched: false, ts: 0, minimize: false, message });
    }
    let l = launch_game(id, state)?;
    Ok(Played { launched: true, ts: l.ts, minimize: l.minimize, message: format!("Launching {}…", l.name) })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Launched {
    ts: u64,
    name: String,
    minimize: bool,
}

#[tauri::command]
fn launch_game(id: String, state: State<'_, AppState>) -> Result<Launched, String> {
    let game = find_game(&state, &id)?;
    if let Some(exe) = &game.exe {
        spawn_exe(exe, game.args.as_deref())?;
    } else if let Some(uri) = &game.launch_uri {
        open_uri(uri)?;
    } else {
        return Err("No launch command found for this game".into());
    }
    let ts = now_secs();
    let minimize = {
        let mut s = state.settings.lock().unwrap();
        s.last_played.insert(game.id.clone(), ts);
        s.minimize_on_launch
    };
    state.save_settings();
    Ok(Launched { ts, name: game.name, minimize })
}

/// Opens the store page / launcher to install a game. Returns the message for the UI.
#[tauri::command]
fn install_game(id: String, state: State<'_, AppState>) -> Result<String, String> {
    let game = find_game(&state, &id)?;
    let launcher = library::platform_name(&game.platform).to_string();
    match &game.install_uri {
        Some(uri) => open_uri(uri).map(|_| format!("Opening {launcher} to install {}", game.name)),
        None => Err(format!("Install {} from its launcher", game.name)),
    }
}

#[tauri::command]
fn open_game_folder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let game = find_game(&state, &id)?;
    match game.install_path {
        Some(p) if game.installed => open_folder(p),
        _ => Err("This game is not installed".into()),
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

/// Deletes all downloaded artwork; it is fetched again in the background.
#[tauri::command]
fn clear_art_cache(state: State<'_, AppState>) -> usize {
    state.artq.clear();
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
    state.artq.dead.store(false, Ordering::SeqCst);
    artq::queue_all(&state);
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

/// What the UI needs after the artwork of one game changed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtChange {
    cover: Option<String>,
    card: Option<String>,
    hero: Option<library::Hero>,
    current: ArtCurrent,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct ArtCurrent {
    url: Option<String>,
    custom: bool,
}

fn art_current_of(ctx: &library::Ctx, id: &str, kind: &str) -> ArtCurrent {
    let Some(a) = ctx.art.get(id) else {
        return ArtCurrent::default();
    };
    let (p, custom) = match kind {
        "cover" => (&a.cover, a.cover_custom),
        "hero" => (&a.hero, a.hero_custom),
        "logo" => (&a.logo, a.logo_custom),
        _ => (&a.icon, a.icon_custom),
    };
    ArtCurrent { url: p.as_deref().map(|p| ctx.art_url(id, kind, p)), custom }
}

fn art_change(state: &AppState, id: &str, kind: &str) -> ArtChange {
    with_ctx(state, |ctx| {
        let fav: HashSet<&str> = ctx.settings.favorites.iter().map(String::as_str).collect();
        let g = ctx.games.iter().find(|g| g.id == id);
        ArtChange {
            cover: ctx.art.get(id).and_then(|a| a.cover.as_deref()).map(|p| ctx.art_url(id, "cover", p)),
            card: g.map(|g| ctx.card_html(g, 0, &fav)),
            hero: ctx.hero(id),
            current: art_current_of(ctx, id, kind),
        }
    })
}

/// The image currently used for one artwork type of one game (artwork picker).
#[tauri::command]
fn art_current(state: State<'_, AppState>, id: String, kind: String) -> ArtCurrent {
    with_ctx(&state, |ctx| art_current_of(ctx, &id, &kind))
}

/// All SteamGridDB alternatives for one artwork type ("cover", "hero", "logo", "icon").
#[tauri::command]
async fn list_art_options(
    state: State<'_, AppState>,
    id: String,
    kind: String,
) -> Result<Vec<art::ArtOption>, String> {
    let g = find_game(&state, &id)?;
    art::list_options(&state, &id, &g.name, g.steam_appid, &kind).await
}

/// Uses an https image URL or a local image file as the artwork for one game.
#[tauri::command]
async fn set_art(
    state: State<'_, AppState>,
    id: String,
    kind: String,
    source: String,
) -> Result<ArtChange, String> {
    art::set_custom(&state, &id, &kind, &source).await?;
    Ok(art_change(&state, &id, &kind))
}

/// Removes the user's choice again; automatic matching takes over.
#[tauri::command]
fn reset_art(app: AppHandle, state: State<'_, AppState>, id: String, kind: String) -> Result<ArtChange, String> {
    art::reset_custom(&state, &id, &kind)?;
    if kind == "cover" {
        state.artq.push_front(&[id.clone()]);
    } else if let Ok(g) = find_game(&state, &id) {
        spawn_extras(app, g);
    }
    Ok(art_change(&state, &id, &kind))
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

// ───────────────────────────── soundboard ─────────────────────────────

fn safe_stem(src: &Path) -> (String, String) {
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "sound".into());
    let safe: String = stem
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(40)
        .collect();
    (stem, if safe.is_empty() { "sound".to_string() } else { safe })
}

/// Decodes an audio file once and stores the first seconds as a small mono WAV in the app data
/// folder, so the soundboard keeps working if the original moves and needs little memory to play.
#[tauri::command]
async fn import_sound(state: State<'_, AppState>, path: String) -> Result<Sound, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !["mp3", "wav", "ogg", "m4a", "flac"].contains(&ext.as_str()) {
        return Err("Choose an MP3, WAV, OGG, M4A or FLAC file".into());
    }
    let meta = std::fs::metadata(&src).map_err(|_| "File not found".to_string())?;
    if !meta.is_file() || meta.len() > 64 * 1024 * 1024 {
        return Err("A sound effect must be a file under 64 MB".into());
    }
    let dir = state.dir.join("sounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let (stem, safe) = safe_stem(&src);
    let dest = dir.join(format!("{safe}_{}.wav", now_secs()));
    let d2 = dest.clone();
    tauri::async_runtime::spawn_blocking(move || sound::to_short_wav(&src, &d2))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Sound { name: stem.chars().take(24).collect(), path: dest.to_string_lossy().to_string() })
}

#[tauri::command]
fn remove_sound(state: State<'_, AppState>, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.starts_with(state.dir.join("sounds")) {
        let _ = std::fs::remove_file(p);
    }
    let changed = {
        let mut s = state.settings.lock().unwrap();
        let before = s.sounds.len();
        s.sounds.retain(|x| x.path != path);
        before != s.sounds.len()
    };
    if changed {
        state.save_settings();
    }
    Ok(())
}

/// Sounds imported by older versions are full copies of the original file: shrink them once.
fn migrate_sounds(st: &AppState) -> bool {
    let sounds = st.settings.lock().unwrap().sounds.clone();
    let dir = st.dir.join("sounds");
    let mut changed = false;
    let mut out = Vec::with_capacity(sounds.len());
    for s in sounds {
        let p = PathBuf::from(&s.path);
        let small = p.extension().map(|e| e.eq_ignore_ascii_case("wav")).unwrap_or(false)
            && std::fs::metadata(&p).map(|m| m.len() < 1_000_000).unwrap_or(false);
        if small || !p.exists() {
            out.push(s);
            continue;
        }
        let (_, safe) = safe_stem(&p);
        let dest = dir.join(format!("{safe}_{}_s.wav", now_secs()));
        match sound::to_short_wav(&p, &dest) {
            Ok(_) => {
                if p.starts_with(&dir) {
                    let _ = std::fs::remove_file(&p);
                }
                out.push(Sound { name: s.name, path: dest.to_string_lossy().to_string() });
                changed = true;
            }
            Err(_) => out.push(s),
        }
    }
    if changed {
        st.settings.lock().unwrap().sounds = out;
        st.save_settings();
    }
    changed
}

// ───────────────────────────── updates ─────────────────────────────

#[tauri::command]
fn app_version() -> String {
    update::CURRENT.to_string()
}

#[tauri::command]
async fn check_update(state: State<'_, AppState>) -> Result<update::UpdateInfo, String> {
    let info = update::check(&state.http).await?;
    *state.update.lock().await = Some(info.clone());
    Ok(info)
}

/// Is an update already downloaded and waiting for the next restart?
#[tauri::command]
fn update_ready(state: State<'_, AppState>) -> Option<String> {
    state.update_ready.lock().unwrap().as_ref().map(|r| r.version.clone())
}

/// Installs now: uses the installer downloaded in the background, otherwise downloads it first.
/// Starts the installer and quits so it can replace the files; Nexus opens again afterwards.
#[tauri::command]
async fn install_update(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let ready = state.update_ready.lock().unwrap().take();
    match ready {
        Some(r) if r.path.exists() => update::run_installer(&r.path, true)?,
        _ => {
            let info = match state.update.lock().await.clone() {
                Some(i) if i.available => i,
                _ => update::check(&state.http).await?,
            };
            if !info.available {
                return Err("Nexus is already up to date".into());
            }
            update::download_and_run(&app, &state.http, &info).await?;
        }
    }
    let a = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(600)).await;
        a.exit(0);
    });
    Ok(())
}

// ───────────────────────────── memory ─────────────────────────────

/// Asks the web view to trim its memory while Nexus is minimized or hidden (e.g. during a game)
/// and to go back to normal when it is shown again.
#[cfg(windows)]
fn apply_memory_mode(app: &AppHandle, low: bool) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let st = app.state::<AppState>();
    if st.mem_low.swap(low, Ordering::SeqCst) == low {
        return Ok(());
    }
    let win = app.get_webview_window("main").ok_or("window not found")?;
    win.with_webview(move |wv| unsafe {
        if let Ok(core) = wv.controller().CoreWebView2() {
            if let Ok(c) = core.cast::<ICoreWebView2_19>() {
                let level = if low {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
                } else {
                    COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
                };
                let _ = c.SetMemoryUsageTargetLevel(level);
            }
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(windows))]
fn apply_memory_mode(_app: &AppHandle, _low: bool) -> Result<(), String> {
    Ok(())
}

#[tauri::command]
fn set_memory_mode(app: AppHandle, low: bool) -> Result<(), String> {
    apply_memory_mode(&app, low)
}

// ───────────────────────────── artwork protocol ─────────────────────────────

/// `art://<kind>/<game id>` (in the web view: `http://art.localhost/<kind>/<id>`): serves the
/// downloaded or chosen image of one game straight from disk. The UI never handles file paths.
fn serve_art(app: &AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap()
    };
    let mut parts = path.trim_start_matches('/').splitn(2, '/');
    let (Some(kind), Some(raw_id)) = (parts.next(), parts.next()) else {
        return not_found();
    };
    let Ok(id) = urlencoding::decode(raw_id) else {
        return not_found();
    };
    let st = app.state::<AppState>();
    let file = {
        let c = st.cache.lock().unwrap();
        c.art.get(id.as_ref()).and_then(|a| match kind {
            "cover" => a.cover.clone(),
            "hero" => a.hero.clone(),
            "logo" => a.logo.clone(),
            "icon" => a.icon.clone(),
            _ => None,
        })
    };
    let Some(file) = file.map(PathBuf::from) else {
        return not_found();
    };
    if !file.starts_with(&st.dir) {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&file) else {
        return not_found();
    };
    let ext = file
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", mime)
        // the URL carries a version, so the web view may cache the file for good
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .body(bytes)
        .unwrap()
}

// ───────────────────────────── entry point ─────────────────────────────

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .register_asynchronous_uri_scheme_protocol("art", |ctx, req, responder| {
            let app = ctx.app_handle().clone();
            let path = req.uri().path().to_string();
            std::thread::spawn(move || responder.respond(serve_art(&app, &path)));
        })
        .setup(|app| {
            // NEXUS_DATA_DIR: developer override (tests run against a separate data folder)
            let dir = match std::env::var_os("NEXUS_DATA_DIR") {
                Some(d) => PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            std::fs::create_dir_all(&dir).ok();
            let settings: Settings = read_json(dir.join("settings.json"));
            let cache: Cache = read_json(dir.join("cache.json"));
            let http = reqwest::Client::builder()
                .user_agent(concat!("Nexus/", env!("CARGO_PKG_VERSION")))
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
                update: tokio::sync::Mutex::new(None),
                update_ready: Mutex::new(None),
                update_busy: AtomicBool::new(false),
                artq: artq::ArtQueue::default(),
                art_base: Mutex::new(if cfg!(windows) { "http://art.localhost/".into() } else { "art://localhost/".into() }),
                mem_low: AtomicBool::new(false),
            });
            artq::start_workers(app.handle());
            update::spawn_background(app.handle().clone());
            // shrink artwork and sounds stored by older versions, then start the background work
            {
                let h = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(3)).await;
                    let h2 = h.clone();
                    let res = tauri::async_runtime::spawn_blocking(move || {
                        let st = h2.state::<AppState>();
                        migrate_sounds(&st);
                        art::migrate_existing(&st).is_some()
                    })
                    .await;
                    if let Ok(true) = res {
                        let _ = h.emit("library-changed", ());
                    }
                    let skip_scan = {
                        let st = h.state::<AppState>();
                        let s = st.settings.lock().unwrap();
                        s.skip_startup_scan
                    };
                    let has_library = !h.state::<AppState>().cache.lock().unwrap().library.is_empty();
                    // with a startup scan, scan_library starts the downloads itself when it is done
                    if skip_scan && has_library {
                        start_background_work(&h);
                    }
                });
            }
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
        .on_window_event(|window, event| {
            // minimized: let the web view give memory back (games get it), restored: back to normal
            if let tauri::WindowEvent::Resized(_) = event {
                if let Ok(min) = window.is_minimized() {
                    let _ = apply_memory_mode(window.app_handle(), min);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            save_settings,
            library_view,
            hero_view,
            art_visible,
            toggle_favorite,
            scan_library,
            play_game,
            launch_game,
            install_game,
            open_game_folder,
            open_folder,
            open_url,
            clear_art_cache,
            open_data_folder,
            art_current,
            test_sgdb_key,
            server_status,
            start_local_server,
            stop_local_server,
            set_internet_mode,
            app_version,
            import_sound,
            remove_sound,
            set_memory_mode,
            check_update,
            update_ready,
            install_update,
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
        .build(tauri::generate_context!())
        .expect("error while building Nexus");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // an update downloaded in the background is installed now, silently
            let ready = handle.state::<AppState>().update_ready.lock().unwrap().take();
            if let Some(r) = ready {
                if r.path.exists() {
                    let _ = update::run_installer(&r.path, false);
                }
            }
        }
    });
}
