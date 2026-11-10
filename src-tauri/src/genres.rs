//! Steam Web API (owned games) and Steam Store lookups (genres).
//! Genres are used for every game, regardless of launcher, by matching the title.

use crate::norm;
use serde_json::Value;

/// Whole Steam library of the user (needs a Steam Web API key + public game details).
pub async fn steam_owned(
    http: &reqwest::Client,
    key: &str,
    steamid: &str,
) -> Result<Vec<(u32, String, u64)>, String> {
    let url = format!(
        "https://api.steampowered.com/IPlayerService/GetOwnedGames/v0001/?key={key}&steamid={steamid}&include_appinfo=1&include_played_free_games=1&format=json"
    );
    let r = http.get(url).send().await.map_err(|e| e.to_string())?;
    if !r.status().is_success() {
        return Err(format!("Steam API: HTTP {}", r.status()));
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let games = v["response"]["games"].as_array().cloned().unwrap_or_default();
    Ok(games
        .iter()
        .filter_map(|g| {
            Some((
                g["appid"].as_u64()? as u32,
                g["name"].as_str()?.to_string(),
                g["playtime_forever"].as_u64().unwrap_or(0),
            ))
        })
        .collect())
}

const DROP: [&str; 17] = [
    "Free To Play",
    "Early Access",
    "Utilities",
    "Education",
    "Game Development",
    "Design & Illustration",
    "Animation & Modeling",
    "Video Production",
    "Audio Production",
    "Photo Editing",
    "Web Publishing",
    "Software Training",
    "Accounting",
    "Movie",
    "Nudity",
    "Sexual Content",
    "Violent",
];

async fn search_store(http: &reqwest::Client, name: &str) -> Result<Option<u32>, String> {
    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        urlencoding::encode(name)
    );
    let r = http.get(url).send().await.map_err(|e| e.to_string())?;
    if r.status().as_u16() == 429 {
        return Err("429".into());
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let want = norm(name);
    Ok(v["items"].as_array().and_then(|items| {
        items
            .iter()
            .find(|i| i["name"].as_str().map(norm).as_deref() == Some(want.as_str()))
            .and_then(|i| i["id"].as_u64())
            .map(|i| i as u32)
    }))
}

/// Ok(None) = no match found, Err("429") = rate limited.
pub async fn lookup(
    http: &reqwest::Client,
    name: &str,
    appid: Option<u32>,
) -> Result<Option<Vec<String>>, String> {
    let id = match appid {
        Some(a) => a,
        None => match search_store(http, name).await? {
            Some(i) => i,
            None => return Ok(None),
        },
    };
    let url = format!(
        "https://store.steampowered.com/api/appdetails?appids={id}&l=english&filters=genres"
    );
    let r = http.get(url).send().await.map_err(|e| e.to_string())?;
    if r.status().as_u16() == 429 {
        return Err("429".into());
    }
    let v: Value = r.json().await.map_err(|e| e.to_string())?;
    let d = &v[id.to_string().as_str()];
    if d["success"].as_bool() != Some(true) {
        return Ok(None);
    }
    let list = d["data"]["genres"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|g| g["description"].as_str())
                .filter(|g| !DROP.contains(g))
                .map(|g| {
                    if g == "Massively Multiplayer" {
                        "MMO".to_string()
                    } else {
                        g.to_string()
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(Some(list))
}
