//! SteamGridDB integration: covers (grids), hero banners, logos and icons.
//! Images are downloaded once into the app data folder and then served locally.
//!
//! * `art/`         – automatically matched artwork (can be cleared and re-downloaded)
//! * `art_custom/`  – artwork the user picked for a single game (never touched by auto-matching)

use crate::{norm, AppState, Art};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const BASE: &str = "https://www.steamgriddb.com/api/v2";
const IMG_EXT: [&str; 6] = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const MAX_BYTES: usize = 40 * 1024 * 1024;

async fn get(st: &AppState, key: &str, path: &str) -> Result<Value, String> {
    let r = st
        .http
        .get(format!("{BASE}{path}"))
        .bearer_auth(key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = r.status();
    match status.as_u16() {
        404 => return Ok(Value::Null),
        401 | 403 => return Err("SteamGridDB: invalid API key".into()),
        _ => {}
    }
    if !status.is_success() {
        return Err(format!("SteamGridDB: HTTP {status}"));
    }
    r.json::<Value>().await.map_err(|e| e.to_string())
}

pub async fn test_key(st: &AppState, key: &str) -> Result<String, String> {
    get(st, key.trim(), "/search/autocomplete/portal").await?;
    Ok("Key works".into())
}

/// `steam/<appid>` for Steam games, otherwise `game/<sgdb id>` found by title.
async fn target(
    st: &AppState,
    key: &str,
    id: &str,
    name: &str,
    appid: Option<u32>,
) -> Result<Option<String>, String> {
    if let Some(a) = appid {
        return Ok(Some(format!("steam/{a}")));
    }
    let cached = { st.cache.lock().unwrap().sgdb_ids.get(id).copied() };
    if let Some(sid) = cached {
        return Ok(Some(format!("game/{sid}")));
    }
    let v = get(
        st,
        key,
        &format!("/search/autocomplete/{}", urlencoding::encode(name)),
    )
    .await?;
    let Some(arr) = v["data"].as_array() else {
        return Ok(None);
    };
    let want = norm(name);
    let pick = arr
        .iter()
        .find(|g| g["name"].as_str().map(norm).as_deref() == Some(want.as_str()))
        .or_else(|| arr.first());
    let Some(sid) = pick.and_then(|g| g["id"].as_u64()) else {
        return Ok(None);
    };
    st.cache.lock().unwrap().sgdb_ids.insert(id.to_string(), sid);
    Ok(Some(format!("game/{sid}")))
}

async fn first_url(
    st: &AppState,
    key: &str,
    kind: &str,
    target: &str,
    queries: &[&str],
) -> Result<Option<String>, String> {
    for q in queries {
        let v = get(st, key, &format!("/{kind}/{target}?{q}")).await?;
        if let Some(u) = v["data"]
            .as_array()
            .and_then(|a| a.first())
            .and_then(|x| x["url"].as_str())
        {
            return Ok(Some(u.to_string()));
        }
    }
    Ok(None)
}

fn safe_id(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn url_ext(url: &str) -> &'static str {
    let last = url.split(['?', '#']).next().unwrap_or("").rsplit('.').next().unwrap_or("");
    let last = last.to_ascii_lowercase();
    IMG_EXT.iter().copied().find(|e| *e == last).unwrap_or("png")
}

async fn fetch_bytes(st: &AppState, url: &str) -> Result<Vec<u8>, String> {
    let bytes = st
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("Image is too large (max 40 MB)".into());
    }
    Ok(bytes.to_vec())
}

/// Shrinks artwork to the size the UI actually shows. A 600x900 PNG needs ~2 MB of memory once
/// decoded, a 400x600 JPEG only ~1 MB (and ~40 KB on disk): with hundreds of games that is the difference.
pub fn optimize(kind: &str, bytes: &[u8], orig_ext: &'static str) -> (Vec<u8>, &'static str) {
    use image::{
        codecs::{jpeg::JpegEncoder, png::PngEncoder},
        imageops::FilterType,
        ExtendedColorType, ImageEncoder,
    };
    // never allocate more than 160 MB for one picture (a huge PNG used to need GBs while decoding)
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(160 * 1024 * 1024);
    let reader = match image::ImageReader::new(std::io::Cursor::new(bytes)).with_guessed_format() {
        Ok(mut r) => {
            r.limits(limits);
            r
        }
        Err(_) => return (bytes.to_vec(), orig_ext),
    };
    let Ok(img) = reader.decode() else {
        return (bytes.to_vec(), orig_ext);
    };
    let (max_w, max_h, png) = match kind {
        "cover" => (400, 600, false),
        "hero" => (1600, 520, false),
        "logo" => (640, 320, true),
        _ => (128, 128, true),
    };
    let img = if img.width() > max_w || img.height() > max_h {
        img.resize(max_w, max_h, FilterType::Triangle)
    } else {
        img
    };
    let mut out = Vec::new();
    let ok = if png {
        let rgba = img.to_rgba8();
        PngEncoder::new(&mut out)
            .write_image(rgba.as_raw(), rgba.width(), rgba.height(), ExtendedColorType::Rgba8)
            .is_ok()
    } else {
        let rgb = img.to_rgb8();
        JpegEncoder::new_with_quality(&mut out, 85)
            .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
            .is_ok()
    };
    if ok && !out.is_empty() {
        (out, if png { "png" } else { "jpg" })
    } else {
        (bytes.to_vec(), orig_ext)
    }
}

/// Automatic artwork: stable file name per game and type.
async fn download(st: &AppState, url: &str, id: &str, kind: &str) -> Result<String, String> {
    let bytes = fetch_bytes(st, url).await?;
    let (kind_s, ext0) = (kind.to_string(), url_ext(url));
    let (data, ext) = tauri::async_runtime::spawn_blocking(move || optimize(&kind_s, &bytes, ext0))
        .await
        .map_err(|e| e.to_string())?;
    let dir = st.dir.join("art");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}_{kind}.{ext}", safe_id(id)));
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Clean-up of artwork downloaded by older versions (big PNGs). Cheap when nothing is left to do.
/// Returns the artwork map when something changed.
pub fn migrate_existing(st: &AppState) -> Option<std::collections::HashMap<String, Art>> {
    let snapshot = { st.cache.lock().unwrap().art.clone() };
    let mut changed = false;
    for (id, art) in snapshot {
        for (kind, path, limit) in [
            ("cover", art.cover.clone(), 150_000u64),
            ("hero", art.hero.clone(), 600_000),
            ("logo", art.logo.clone(), 200_000),
            ("icon", art.icon.clone(), 40_000),
        ] {
            let Some(path) = path else { continue };
            let p = Path::new(&path);
            let Ok(meta) = std::fs::metadata(p) else { continue };
            let is_png_photo = (kind == "cover" || kind == "hero") && path.to_lowercase().ends_with(".png");
            if meta.len() <= limit && !is_png_photo {
                continue;
            }
            let Ok(bytes) = std::fs::read(p) else { continue };
            let (data, ext) = optimize(kind, &bytes, "png");
            if data.len() >= bytes.len() {
                continue;
            }
            let new_path = p.with_extension(ext);
            if std::fs::write(&new_path, &data).is_err() {
                continue;
            }
            if new_path != p {
                let _ = std::fs::remove_file(p);
            }
            let new_s = new_path.to_string_lossy().to_string();
            let mut c = st.cache.lock().unwrap();
            if let Some(a) = c.art.get_mut(&id) {
                let slot = match kind {
                    "cover" => &mut a.cover,
                    "hero" => &mut a.hero,
                    "logo" => &mut a.logo,
                    _ => &mut a.icon,
                };
                if slot.as_deref() == Some(path.as_str()) {
                    *slot = Some(new_s);
                    changed = true;
                }
            }
        }
    }
    if changed {
        st.save_cache();
        Some(st.cache.lock().unwrap().art.clone())
    } else {
        None
    }
}

fn custom_path(st: &AppState, id: &str, kind: &str, ext: &str) -> Result<PathBuf, String> {
    let dir = st.dir.join("art_custom");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    // unique name so the webview never shows a cached older image
    Ok(dir.join(format!("{}_{kind}_{ts}.{ext}", safe_id(id))))
}

fn sgdb_key(st: &AppState) -> String {
    st.settings.lock().unwrap().sgdb_key.trim().to_string()
}

fn existing(st: &AppState, id: &str) -> Art {
    st.cache.lock().unwrap().art.get(id).cloned().unwrap_or_default()
}

fn file_ok(p: &Option<String>) -> bool {
    p.as_deref().map(|p| Path::new(p).exists()).unwrap_or(false)
}

/// Tall cover (600x900) for the library grid.
pub async fn ensure_cover(
    st: &AppState,
    id: &str,
    name: &str,
    appid: Option<u32>,
) -> Result<Option<String>, String> {
    let art = existing(st, id);
    if file_ok(&art.cover) {
        return Ok(art.cover); // also covers user-chosen images
    }
    let key = sgdb_key(st);
    if key.is_empty() {
        return Ok(None);
    }
    if art.cover_tried && !art.cover_custom {
        return Ok(None);
    }
    let mut cover = None;
    if let Some(t) = target(st, &key, id, name, appid).await? {
        let qs = [
            "dimensions=600x900&types=static&nsfw=false",
            "dimensions=342x482&types=static&nsfw=false",
        ];
        if let Some(u) = first_url(st, &key, "grids", &t, &qs).await? {
            cover = Some(download(st, &u, id, "cover").await?);
        }
    }
    {
        let mut c = st.cache.lock().unwrap();
        let a = c.art.entry(id.to_string()).or_default();
        a.cover = cover.clone();
        a.cover_custom = false; // a missing custom file falls back to automatic matching
        a.cover_tried = true;
    }
    st.save_cache();
    Ok(cover)
}

/// Hero banner, logo and icon for the detail header (skips what the user chose manually).
pub async fn ensure_extras(
    st: &AppState,
    id: &str,
    name: &str,
    appid: Option<u32>,
) -> Result<Art, String> {
    let key = sgdb_key(st);
    let art = existing(st, id);
    if key.is_empty() || art.extras_tried {
        return Ok(art);
    }
    let (mut hero, mut logo, mut icon) = (None, None, None);
    if let Some(t) = target(st, &key, id, name, appid).await? {
        if !art.hero_custom {
            let q = [
                "dimensions=1920x620,3840x1240,1600x650&types=static&nsfw=false",
                "types=static&nsfw=false",
            ];
            if let Some(u) = first_url(st, &key, "heroes", &t, &q).await? {
                hero = Some(download(st, &u, id, "hero").await?);
            }
        }
        if !art.logo_custom {
            if let Some(u) = first_url(st, &key, "logos", &t, &["types=static&nsfw=false"]).await? {
                logo = Some(download(st, &u, id, "logo").await?);
            }
        }
        if !art.icon_custom {
            if let Some(u) = first_url(st, &key, "icons", &t, &["nsfw=false"]).await? {
                icon = Some(download(st, &u, id, "icon").await?);
            }
        }
    }
    let out = {
        let mut c = st.cache.lock().unwrap();
        let a = c.art.entry(id.to_string()).or_default();
        if !a.hero_custom {
            a.hero = hero;
        }
        if !a.logo_custom {
            a.logo = logo;
        }
        if !a.icon_custom {
            a.icon = icon;
        }
        a.extras_tried = true;
        a.clone()
    };
    st.save_cache();
    Ok(out)
}

// ───────────────────────────── user-chosen artwork ─────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtOption {
    pub url: String,
    pub thumb: String,
    pub width: u64,
    pub height: u64,
    pub style: String,
    pub author: String,
}

pub async fn list_options(
    st: &AppState,
    id: &str,
    name: &str,
    appid: Option<u32>,
    kind: &str,
) -> Result<Vec<ArtOption>, String> {
    let key = sgdb_key(st);
    if key.is_empty() {
        return Err("Add a SteamGridDB API key in the settings to browse artwork".into());
    }
    let (endpoint, query) = match kind {
        "cover" => ("grids", "dimensions=600x900,342x482,660x930&types=static&nsfw=false"),
        "hero" => ("heroes", "types=static&nsfw=false"),
        "logo" => ("logos", "types=static&nsfw=false"),
        "icon" => ("icons", "nsfw=false"),
        _ => return Err("Unknown artwork type".into()),
    };
    let Some(t) = target(st, &key, id, name, appid).await? else {
        return Ok(Vec::new());
    };
    let v = get(st, &key, &format!("/{endpoint}/{t}?{query}")).await?;
    let items = v["data"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .take(40)
        .filter_map(|x| {
            let url = x["url"].as_str()?.to_string();
            Some(ArtOption {
                thumb: x["thumb"].as_str().unwrap_or(&url).to_string(),
                width: x["width"].as_u64().unwrap_or(0),
                height: x["height"].as_u64().unwrap_or(0),
                style: x["style"].as_str().unwrap_or("").to_string(),
                author: x["author"]["name"].as_str().unwrap_or("").to_string(),
                url,
            })
        })
        .collect())
}

fn check_kind(kind: &str) -> Result<(), String> {
    match kind {
        "cover" | "hero" | "logo" | "icon" => Ok(()),
        _ => Err("Unknown artwork type".into()),
    }
}

/// Removes a previously chosen custom file (only inside art_custom/).
fn drop_custom_file(st: &AppState, p: &Option<String>) {
    if let Some(p) = p {
        let path = Path::new(p);
        if path.starts_with(st.dir.join("art_custom")) {
            let _ = std::fs::remove_file(path);
        }
    }
}

pub async fn set_custom(st: &AppState, id: &str, kind: &str, source: &str) -> Result<Art, String> {
    check_kind(kind)?;
    let source = source.trim();
    let target_path = if source.starts_with("https://") {
        let bytes = fetch_bytes(st, source).await?;
        let (k, e0) = (kind.to_string(), url_ext(source));
        let (data, ext) = tauri::async_runtime::spawn_blocking(move || optimize(&k, &bytes, e0))
            .await
            .map_err(|e| e.to_string())?;
        let p = custom_path(st, id, kind, ext)?;
        std::fs::write(&p, &data).map_err(|e| e.to_string())?;
        p
    } else if source.starts_with("http://") {
        return Err("Only https:// links are supported".into());
    } else {
        let src = Path::new(source);
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();
        if !IMG_EXT.contains(&ext.as_str()) {
            return Err("Choose a PNG, JPG, WEBP, GIF or BMP image".into());
        }
        let meta = std::fs::metadata(src).map_err(|_| "File not found".to_string())?;
        if !meta.is_file() || meta.len() as usize > MAX_BYTES {
            return Err("Image is missing or too large (max 40 MB)".into());
        }
        let raw = std::fs::read(src).map_err(|e| e.to_string())?;
        let (k, e0) = (kind.to_string(), IMG_EXT.iter().copied().find(|x| *x == ext).unwrap_or("png"));
        let (data, ext2) = tauri::async_runtime::spawn_blocking(move || optimize(&k, &raw, e0))
            .await
            .map_err(|e| e.to_string())?;
        let p = custom_path(st, id, kind, ext2)?;
        std::fs::write(&p, &data).map_err(|e| e.to_string())?;
        p
    };
    let path = target_path.to_string_lossy().to_string();

    let (old, out) = {
        let mut c = st.cache.lock().unwrap();
        let a = c.art.entry(id.to_string()).or_default();
        let old = match kind {
            "cover" => {
                a.cover_tried = true;
                a.cover_custom = true;
                a.cover.replace(path)
            }
            "hero" => {
                a.hero_custom = true;
                a.hero.replace(path)
            }
            "logo" => {
                a.logo_custom = true;
                a.logo.replace(path)
            }
            _ => {
                a.icon_custom = true;
                a.icon.replace(path)
            }
        };
        (old, a.clone())
    };
    drop_custom_file(st, &old);
    st.save_cache();
    Ok(out)
}

pub fn reset_custom(st: &AppState, id: &str, kind: &str) -> Result<Art, String> {
    check_kind(kind)?;
    let (old, out) = {
        let mut c = st.cache.lock().unwrap();
        let a = c.art.entry(id.to_string()).or_default();
        let old = match kind {
            "cover" => {
                a.cover_custom = false;
                a.cover_tried = false;
                a.cover.take()
            }
            "hero" => {
                a.hero_custom = false;
                a.extras_tried = false;
                a.hero.take()
            }
            "logo" => {
                a.logo_custom = false;
                a.extras_tried = false;
                a.logo.take()
            }
            _ => {
                a.icon_custom = false;
                a.extras_tried = false;
                a.icon.take()
            }
        };
        (old, a.clone())
    };
    drop_custom_file(st, &old);
    st.save_cache();
    Ok(out)
}
