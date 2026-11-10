//! Automatic detection of installed games for every supported launcher.

use crate::{
    vdf::{self, Vdf},
    Game,
};
use serde::Serialize;
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone)]
struct Progress {
    platform: &'static str,
    state: &'static str,
    count: usize,
}

fn emit(app: &AppHandle, platform: &'static str, state: &'static str, count: usize) {
    let _ = app.emit(
        "scan-progress",
        Progress {
            platform,
            state,
            count,
        },
    );
}

async fn run(app: &AppHandle, platform: &'static str, f: fn() -> Vec<Game>) -> Vec<Game> {
    emit(app, platform, "running", 0);
    let games = tauri::async_runtime::spawn_blocking(f)
        .await
        .unwrap_or_default();
    emit(app, platform, "done", games.len());
    games
}

/// Scans all launchers one after another and reports progress to the UI.
pub async fn scan_all(
    app: &AppHandle,
    http: &reqwest::Client,
    steam_key: &str,
    rsi_path: &str,
) -> Vec<Game> {
    let mut all: Vec<Game> = Vec::new();

    // Steam: installed games from the manifests + (optional) whole library via Web API
    emit(app, "steam", "running", 0);
    let mut steam = tauri::async_runtime::spawn_blocking(steam_installed)
        .await
        .unwrap_or_default();
    let key = steam_key.trim();
    if !key.is_empty() {
        if let Some(uid) = steam_user_id() {
            match crate::genres::steam_owned(http, key, &uid).await {
                Ok(owned) => merge_owned(&mut steam, owned),
                Err(e) => eprintln!("steam owned games: {e}"),
            }
        }
    }
    emit(app, "steam", "done", steam.len());
    all.extend(steam);

    all.extend(run(app, "epic", epic).await);
    all.extend(run(app, "gog", gog).await);
    all.extend(run(app, "ubisoft", ubisoft).await);
    all.extend(run(app, "ea", ea).await);
    all.extend(run(app, "battlenet", battlenet).await);

    emit(app, "rsi", "running", 0);
    let extra = rsi_path.to_string();
    let rsi_games = tauri::async_runtime::spawn_blocking(move || rsi(&extra))
        .await
        .unwrap_or_default();
    emit(app, "rsi", "done", rsi_games.len());
    all.extend(rsi_games);

    let mut seen = std::collections::HashSet::new();
    all.retain(|g| seen.insert(g.id.clone()));
    all
}

// ───────────────────────────── helpers ─────────────────────────────

fn guess_exe(dir: &Path) -> Option<PathBuf> {
    const BAD: [&str; 10] = [
        "unins", "crash", "setup", "redist", "dxsetup", "vcredist", "report", "helper", "cleanup",
        "touchup",
    ];
    let mut best: Option<(u64, PathBuf)> = None;
    for e in fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        let is_exe = p
            .extension()
            .map(|x| x.eq_ignore_ascii_case("exe"))
            .unwrap_or(false);
        if !is_exe {
            continue;
        }
        let Some(n) = p.file_name() else { continue };
        let n = n.to_string_lossy().to_lowercase();
        if BAD.iter().any(|b| n.contains(b)) {
            continue;
        }
        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
        if best.as_ref().map(|b| size > b.0).unwrap_or(true) {
            best = Some((size, p));
        }
    }
    best.map(|b| b.1)
}

fn is_steam_tool(name: &str, appid: u32) -> bool {
    if appid == 228980 {
        return true;
    }
    let n = name.to_lowercase();
    [
        "steamworks common",
        "proton",
        "steam linux runtime",
        "redistributable",
        "steam controller configs",
    ]
    .iter()
    .any(|t| n.contains(t))
}

// ───────────────────────────── Steam ─────────────────────────────

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use winreg::{enums::*, RegKey};
    let p: Option<String> = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Valve\Steam")
        .ok()
        .and_then(|k| k.get_value("SteamPath").ok());
    p.map(PathBuf::from)
        .filter(|p| p.exists())
        .or_else(|| {
            let d = PathBuf::from(r"C:\Program Files (x86)\Steam");
            d.exists().then_some(d)
        })
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    None
}

fn steam_libraries(root: &Path) -> Vec<PathBuf> {
    let mut libs = vec![root.to_path_buf()];
    if let Ok(txt) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) {
        let v = vdf::parse(&txt);
        if let Some(lf) = v.get("libraryfolders") {
            for (k, e) in lf.entries() {
                if !k.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                let path = match e {
                    Vdf::Str(s) => Some(s.as_str()),
                    Vdf::Map(_) => e.str("path"),
                };
                if let Some(p) = path {
                    let p = PathBuf::from(p);
                    if !libs.contains(&p) {
                        libs.push(p);
                    }
                }
            }
        }
    }
    libs
}

pub fn steam_user_id() -> Option<String> {
    let root = steam_root()?;
    let txt = fs::read_to_string(root.join("config").join("loginusers.vdf")).ok()?;
    let v = vdf::parse(&txt);
    let users = v.get("users")?;
    let mut first = None;
    for (id, u) in users.entries() {
        if first.is_none() {
            first = Some(id.clone());
        }
        if u.str("MostRecent") == Some("1") {
            return Some(id.clone());
        }
    }
    first
}

fn steam_installed() -> Vec<Game> {
    let mut out = Vec::new();
    let Some(root) = steam_root() else { return out };
    for lib in steam_libraries(&root) {
        let apps = lib.join("steamapps");
        let Ok(rd) = fs::read_dir(&apps) else { continue };
        for e in rd.flatten() {
            let fname = e.file_name().to_string_lossy().to_string();
            if !(fname.starts_with("appmanifest_") && fname.ends_with(".acf")) {
                continue;
            }
            let Ok(txt) = fs::read_to_string(e.path()) else { continue };
            let v = vdf::parse(&txt);
            let Some(st) = v.get("AppState") else { continue };
            let Some(appid) = st.str("appid").and_then(|s| s.parse::<u32>().ok()) else {
                continue;
            };
            let name = st.str("name").unwrap_or("").to_string();
            if name.is_empty() || is_steam_tool(&name, appid) {
                continue;
            }
            let flags = st
                .str("StateFlags")
                .and_then(|s| s.parse::<u32>().ok())
                .unwrap_or(0);
            if flags & 4 == 0 {
                continue; // not fully installed
            }
            let dir = apps.join("common").join(st.str("installdir").unwrap_or(""));
            out.push(Game {
                id: format!("steam:{appid}"),
                name,
                platform: "steam".into(),
                installed: true,
                install_path: Some(dir.to_string_lossy().to_string()),
                launch_uri: Some(format!("steam://rungameid/{appid}")),
                install_uri: Some(format!("steam://install/{appid}")),
                steam_appid: Some(appid),
                size_bytes: st.str("SizeOnDisk").and_then(|s| s.parse().ok()),
                ..Default::default()
            });
        }
    }
    out
}

fn merge_owned(games: &mut Vec<Game>, owned: Vec<(u32, String, u64)>) {
    for (appid, name, playtime) in owned {
        let id = format!("steam:{appid}");
        if let Some(g) = games.iter_mut().find(|g| g.id == id) {
            g.playtime_min = Some(playtime);
        } else if !is_steam_tool(&name, appid) {
            games.push(Game {
                id,
                name,
                platform: "steam".into(),
                installed: false,
                launch_uri: Some(format!("steam://rungameid/{appid}")),
                install_uri: Some(format!("steam://install/{appid}")),
                steam_appid: Some(appid),
                playtime_min: Some(playtime),
                ..Default::default()
            });
        }
    }
}

// ───────────────────────────── Epic Games ─────────────────────────────

fn epic() -> Vec<Game> {
    let base = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    let dir = PathBuf::from(base)
        .join("Epic")
        .join("EpicGamesLauncher")
        .join("Data")
        .join("Manifests");
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(&dir) else { return out };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("item") {
            continue;
        }
        let Ok(txt) = fs::read_to_string(&p) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) else {
            continue;
        };
        let s = |k: &str| v[k].as_str().unwrap_or("").to_string();
        let app_name = s("AppName");
        let name = s("DisplayName");
        if app_name.is_empty() || name.is_empty() {
            continue;
        }
        let main = s("MainGameAppName");
        if !main.is_empty() && main != app_name {
            continue; // DLC
        }
        if v["bIsIncompleteInstall"].as_bool().unwrap_or(false) {
            continue;
        }
        if let Some(cats) = v["AppCategories"].as_array() {
            if !cats.iter().any(|c| c.as_str() == Some("games")) {
                continue;
            }
        }
        let launch = format!(
            "com.epicgames.launcher://apps/{}%3A{}%3A{}?action=launch&silent=true",
            s("CatalogNamespace"),
            s("CatalogItemId"),
            app_name
        );
        out.push(Game {
            id: format!("epic:{app_name}"),
            name,
            platform: "epic".into(),
            installed: true,
            install_path: Some(s("InstallLocation")),
            launch_uri: Some(launch),
            size_bytes: v["InstallSize"].as_u64(),
            ..Default::default()
        });
    }
    out
}

// ───────────────────────────── GOG ─────────────────────────────

#[cfg(windows)]
fn gog() -> Vec<Game> {
    use winreg::{enums::*, RegKey};
    let mut out = Vec::new();
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games")
    else {
        return out;
    };
    for key in root.enum_keys().flatten() {
        let Ok(sk) = root.open_subkey(&key) else { continue };
        let val = |n: &str| -> String { sk.get_value(n).unwrap_or_default() };
        if !val("dependsOn").is_empty() {
            continue; // DLC
        }
        let name = val("gameName");
        let exe = val("exe");
        if name.is_empty() || exe.is_empty() {
            continue;
        }
        let args = val("launchParam");
        out.push(Game {
            id: format!("gog:{key}"),
            name,
            platform: "gog".into(),
            installed: true,
            install_path: Some(val("path")),
            exe: Some(exe),
            args: if args.is_empty() { None } else { Some(args) },
            ..Default::default()
        });
    }
    out
}

#[cfg(not(windows))]
fn gog() -> Vec<Game> {
    Vec::new()
}

// ───────────────────────────── Ubisoft Connect ─────────────────────────────

#[cfg(windows)]
fn ubisoft() -> Vec<Game> {
    use winreg::{enums::*, RegKey};
    let mut out = Vec::new();
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs")
    else {
        return out;
    };
    for key in root.enum_keys().flatten() {
        let Ok(sk) = root.open_subkey(&key) else { continue };
        let dir: String = sk.get_value("InstallDir").unwrap_or_default();
        let dir = dir.trim_end_matches(['/', '\\']).to_string();
        let name = Path::new(&dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() || !Path::new(&dir).exists() {
            continue;
        }
        out.push(Game {
            id: format!("ubisoft:{key}"),
            name,
            platform: "ubisoft".into(),
            installed: true,
            install_path: Some(dir),
            launch_uri: Some(format!("uplay://launch/{key}/0")),
            ..Default::default()
        });
    }
    out
}

#[cfg(not(windows))]
fn ubisoft() -> Vec<Game> {
    Vec::new()
}

// ───────────────────────────── EA app ─────────────────────────────

fn ea() -> Vec<Game> {
    let mut out = Vec::new();
    let mut parents = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            for sub in ["EA Games", "Electronic Arts"] {
                parents.push(PathBuf::from(&pf).join(sub));
            }
        }
    }
    for parent in parents {
        let Ok(rd) = fs::read_dir(&parent) else { continue };
        for e in rd.flatten() {
            let dir = e.path();
            if !dir.is_dir() {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            let Some(exe) = guess_exe(&dir) else { continue };
            out.push(Game {
                id: format!("ea:{}", crate::norm(&name)),
                name,
                platform: "ea".into(),
                installed: true,
                install_path: Some(dir.to_string_lossy().to_string()),
                exe: Some(exe.to_string_lossy().to_string()),
                ..Default::default()
            });
        }
    }
    out
}

// ───────────────────────────── Battle.net ─────────────────────────────

#[cfg(windows)]
fn battlenet() -> Vec<Game> {
    use winreg::{enums::*, RegKey};
    let mut out = Vec::new();
    for path in [
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ] {
        let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path) else {
            continue;
        };
        for key in root.enum_keys().flatten() {
            let Ok(sk) = root.open_subkey(&key) else { continue };
            let publisher: String = sk.get_value("Publisher").unwrap_or_default();
            if publisher != "Blizzard Entertainment" {
                continue;
            }
            let name: String = sk.get_value("DisplayName").unwrap_or_default();
            let loc: String = sk.get_value("InstallLocation").unwrap_or_default();
            if name.is_empty() || name == "Battle.net" || loc.is_empty() {
                continue;
            }
            let dir = PathBuf::from(&loc);
            let Some(exe) = guess_exe(&dir) else { continue };
            out.push(Game {
                id: format!("battlenet:{key}"),
                name,
                platform: "battlenet".into(),
                installed: true,
                install_path: Some(loc),
                exe: Some(exe.to_string_lossy().to_string()),
                ..Default::default()
            });
        }
    }
    out
}

#[cfg(not(windows))]
fn battlenet() -> Vec<Game> {
    Vec::new()
}

// ───────────────────────────── RSI Launcher (Star Citizen) ─────────────────────────────

/// Finds "RSI Launcher.exe": default install paths first, then the uninstall record.
fn rsi_launcher_exe() -> Option<PathBuf> {
    let mut cands: Vec<PathBuf> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            cands.push(
                PathBuf::from(pf)
                    .join("Roberts Space Industries")
                    .join("RSI Launcher")
                    .join("RSI Launcher.exe"),
            );
        }
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        cands.push(
            PathBuf::from(la)
                .join("Programs")
                .join("rsi-launcher")
                .join("RSI Launcher.exe"),
        );
    }
    if let Some(p) = rsi_launcher_from_registry() {
        cands.push(p);
    }
    cands.into_iter().find(|p| p.exists())
}

#[cfg(windows)]
fn rsi_launcher_from_registry() -> Option<PathBuf> {
    use winreg::{enums::*, RegKey};
    const KEY: &str = r"Microsoft\Windows\CurrentVersion\Uninstall\81bfc699-f883-50c7-b674-2483b6baae23";
    for (hive, base) in [
        (HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node"),
        (HKEY_LOCAL_MACHINE, r"SOFTWARE"),
        (HKEY_CURRENT_USER, r"SOFTWARE"),
    ] {
        let Ok(k) = RegKey::predef(hive).open_subkey(format!(r"{base}\{KEY}")) else {
            continue;
        };
        let un: String = k.get_value("UninstallString").unwrap_or_default();
        // "C:\...\Uninstall RSI Launcher.exe" /allusers  → take the quoted path
        let path = un.trim().trim_start_matches('"').split('"').next().unwrap_or("");
        if let Some(dir) = Path::new(path).parent() {
            return Some(dir.join("RSI Launcher.exe"));
        }
    }
    None
}

#[cfg(not(windows))]
fn rsi_launcher_from_registry() -> Option<PathBuf> {
    None
}

/// Star Citizen channels (LIVE, PTU, EPTU, …) installed through the RSI Launcher.
/// `extra` is an optional user-provided folder (library root, StarCitizen or a channel folder).
fn rsi(extra: &str) -> Vec<Game> {
    let mut roots: Vec<PathBuf> = Vec::new();
    let mut add = |p: PathBuf| {
        if !roots.contains(&p) {
            roots.push(p);
        }
    };

    let extra = extra.trim();
    if !extra.is_empty() {
        let p = PathBuf::from(extra);
        add(p.join("StarCitizen"));
        add(p.clone());
        if let Some(parent) = p.parent() {
            add(parent.to_path_buf()); // the user pointed at a channel folder itself
        }
    }
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Ok(pf) = std::env::var(var) {
            add(PathBuf::from(pf)
                .join("Roberts Space Industries")
                .join("StarCitizen"));
        }
    }
    for drive in 'C'..='Z' {
        for rel in [
            r"Roberts Space Industries\StarCitizen",
            r"Program Files\Roberts Space Industries\StarCitizen",
            r"Games\Roberts Space Industries\StarCitizen",
            r"Games\StarCitizen",
            r"StarCitizen",
        ] {
            add(PathBuf::from(format!(r"{drive}:\{rel}")));
        }
    }

    let launcher = rsi_launcher_exe();
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for root in roots {
        let Ok(rd) = fs::read_dir(&root) else { continue };
        for e in rd.flatten() {
            let dir = e.path();
            let game_exe = dir.join("Bin64").join("StarCitizen.exe");
            if !game_exe.exists() {
                continue;
            }
            let channel = e.file_name().to_string_lossy().to_string();
            if !seen.insert(dir.to_string_lossy().to_lowercase()) {
                continue;
            }
            let name = if channel.eq_ignore_ascii_case("LIVE") {
                "Star Citizen".to_string()
            } else {
                format!("Star Citizen ({})", channel.to_uppercase())
            };
            // Starting through the RSI Launcher keeps login/patching working.
            let exe = launcher.clone().unwrap_or(game_exe);
            out.push(Game {
                id: format!("rsi:{}", channel.to_uppercase()),
                name,
                platform: "rsi".into(),
                installed: true,
                install_path: Some(dir.to_string_lossy().to_string()),
                exe: Some(exe.to_string_lossy().to_string()),
                size_bytes: fs::metadata(dir.join("Data.p4k")).ok().map(|m| m.len()),
                ..Default::default()
            });
        }
    }
    out
}
