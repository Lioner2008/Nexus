//! SteamGridDB integration: covers (grids), hero banners, logos and icons.
//! Images are downloaded once into the app data folder and then served locally.

use crate::{norm, AppState, Art};
use serde_json::Value;
use std::path::Path;

const BASE: &str = "https://www.steamgriddb.com/api/v2";

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

async fn download(st: &AppState, url: &str, id: &str, kind: &str) -> Result<String, String> {
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
    let ext = url
        .rsplit('.')
        .next()
        .filter(|e| e.len() <= 4 && e.chars().all(|c| c.is_ascii_alphanumeric()))
        .unwrap_or("png");
    let safe: String = id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect();
    let dir = st.dir.join("art");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{safe}_{kind}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
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
    let key = sgdb_key(st);
    if key.is_empty() {
        return Ok(None);
    }
    let art = existing(st, id);
    if file_ok(&art.cover) {
        return Ok(art.cover);
    }
    if art.cover_tried {
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
        a.cover_tried = true;
    }
    st.save_cache();
    Ok(cover)
}

/// Hero banner, logo and icon for the detail header.
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
        let hero_q = [
            "dimensions=1920x620,3840x1240,1600x650&types=static&nsfw=false",
            "types=static&nsfw=false",
        ];
        if let Some(u) = first_url(st, &key, "heroes", &t, &hero_q).await? {
            hero = Some(download(st, &u, id, "hero").await?);
        }
        if let Some(u) = first_url(st, &key, "logos", &t, &["types=static&nsfw=false"]).await? {
            logo = Some(download(st, &u, id, "logo").await?);
        }
        if let Some(u) = first_url(st, &key, "icons", &t, &["nsfw=false"]).await? {
            icon = Some(download(st, &u, id, "icon").await?);
        }
    }
    let out = {
        let mut c = st.cache.lock().unwrap();
        let a = c.art.entry(id.to_string()).or_default();
        a.hero = hero;
        a.logo = logo;
        a.icon = icon;
        a.extras_tried = true;
        a.clone()
    };
    st.save_cache();
    Ok(out)
}
