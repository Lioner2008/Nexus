#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod art;
mod genres;
mod scan;
mod vdf;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
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
        let mut c = state.cache.lock().unwrap();
        c.art.clear();
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

// ───────────────────────────── entry point ─────────────────────────────

fn main() {
    tauri::Builder::default()
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
            });
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
            start_enrich,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nexus");
}
