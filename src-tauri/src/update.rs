//! In-app updates: asks GitHub for the latest release, downloads the installer, checks its
//! SHA-256 and runs it silently. The installer closes Nexus, replaces the files and starts the new version.
//!
//! The repository must be public for other people's copies to see releases.
//! Developer overrides: NEXUS_UPDATE_API (releases/latest URL), NEXUS_UPDATE_ARGS (installer arguments).

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::PathBuf, process::Command};
use tauri::{AppHandle, Emitter};

pub const REPO: &str = "Lioner2008/Nexus";
pub const CURRENT: &str = env!("CARGO_PKG_VERSION");

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub notes: String,
    pub page: String,
    pub installer_name: String,
    pub installer_url: String,
    pub sha_url: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: String,
    #[serde(default)]
    html_url: String,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    #[serde(default)]
    size: u64,
}

fn api_url() -> String {
    std::env::var("NEXUS_UPDATE_API")
        .unwrap_or_else(|_| format!("https://api.github.com/repos/{REPO}/releases/latest"))
}

fn dev_override() -> bool {
    std::env::var("NEXUS_UPDATE_API").is_ok()
}

/// "v1.2.10" -> [1, 2, 10]; ignores anything after a '-' or '+'.
pub fn parse_version(v: &str) -> Vec<u64> {
    v.trim()
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse::<u64>().unwrap_or(0))
        .collect()
}

pub fn is_newer(latest: &str, current: &str) -> bool {
    let (a, b) = (parse_version(latest), parse_version(current));
    let n = a.len().max(b.len());
    for i in 0..n {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

pub async fn check(http: &reqwest::Client) -> Result<UpdateInfo, String> {
    let r = http
        .get(api_url())
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| format!("Could not reach GitHub: {e}"))?;
    if r.status().as_u16() == 404 {
        return Err("No release found. (The GitHub repository must be public for update checks.)".into());
    }
    if !r.status().is_success() {
        return Err(format!("GitHub answered {}", r.status()));
    }
    let rel: Release = r.json().await.map_err(|e| format!("Unexpected answer from GitHub: {e}"))?;
    let installer = rel
        .assets
        .iter()
        .find(|a| a.name.starts_with("Nexus-Setup") && a.name.ends_with(".exe"));
    let sha = rel.assets.iter().find(|a| a.name.eq_ignore_ascii_case("SHA256SUMS.txt"));
    Ok(UpdateInfo {
        available: installer.is_some() && is_newer(&rel.tag_name, CURRENT),
        current: CURRENT.to_string(),
        latest: rel.tag_name.trim_start_matches(['v', 'V']).to_string(),
        notes: rel.body,
        page: rel.html_url,
        installer_name: installer.map(|a| a.name.clone()).unwrap_or_default(),
        installer_url: installer.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        sha_url: sha.map(|a| a.browser_download_url.clone()).unwrap_or_default(),
        size: installer.map(|a| a.size).unwrap_or(0),
    })
}

/// Only downloads from this repository's releases (or anything when a developer override is set).
fn url_allowed(url: &str) -> bool {
    dev_override() || url.starts_with(&format!("https://github.com/{REPO}/releases/download/"))
}

fn expected_hash(sums: &str, file: &str) -> Option<String> {
    sums.lines().find_map(|l| {
        let mut it = l.split_whitespace();
        let hash = it.next()?;
        let name = it.next()?.trim_start_matches('*');
        (name == file).then(|| hash.to_lowercase())
    })
}

#[cfg(windows)]
fn spawn_installer(path: &PathBuf, args: &[String]) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    // DETACHED_PROCESS | CREATE_NO_WINDOW: keeps running after Nexus quits
    Command::new(path).args(args).creation_flags(0x0000_0008 | 0x0800_0000).spawn().map(|_| ())
}

#[cfg(not(windows))]
fn spawn_installer(path: &PathBuf, args: &[String]) -> std::io::Result<()> {
    Command::new(path).args(args).spawn().map(|_| ())
}

/// Downloads the installer (progress via the `update-progress` event), verifies it and starts it.
/// The caller quits the app afterwards.
pub async fn download_and_run(app: &AppHandle, http: &reqwest::Client, info: &UpdateInfo) -> Result<(), String> {
    if info.installer_url.is_empty() {
        return Err("This release has no installer".into());
    }
    if !url_allowed(&info.installer_url) {
        return Err("Refusing to download from an unexpected address".into());
    }
    let dir = std::env::temp_dir().join("Nexus-Update");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // keep only a plain file name
    let name: String = info.installer_name.chars().filter(|c| c.is_ascii_alphanumeric() || "-._".contains(*c)).collect();
    let path = dir.join(if name.is_empty() { "Nexus-Setup.exe".to_string() } else { name });

    let mut resp = http
        .get(&info.installer_url)
        .send()
        .await
        .map_err(|e| format!("Download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("Download failed: {e}"))?;
    let total = resp.content_length().unwrap_or(info.size);
    let mut file = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let (mut done, mut last_emit) = (0u64, 0u64);
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("Download failed: {e}"))? {
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        done += chunk.len() as u64;
        if done - last_emit > 256 * 1024 || done == total {
            last_emit = done;
            let _ = app.emit("update-progress", serde_json::json!({ "done": done, "total": total }));
        }
    }
    drop(file);

    // integrity: compare with SHA256SUMS.txt from the same release
    if !info.sha_url.is_empty() && url_allowed(&info.sha_url) {
        let sums = http
            .get(&info.sha_url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("Could not fetch the checksum: {e}"))?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        if let Some(expected) = expected_hash(&sums, &info.installer_name) {
            let got: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
            if got != expected {
                let _ = std::fs::remove_file(&path);
                return Err("The downloaded installer is damaged (checksum mismatch). Nothing was installed.".into());
            }
        }
    }

    let args: Vec<String> = match std::env::var("NEXUS_UPDATE_ARGS") {
        Ok(a) if dev_override() => a.split_whitespace().map(String::from).collect(),
        _ => vec!["/S".into(), "--launch".into()],
    };
    spawn_installer(&path, &args).map_err(|e| format!("Could not start the installer: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_versions() {
        assert!(is_newer("v0.3.0", "0.2.0"));
        assert!(is_newer("0.10.0", "0.9.9"));
        assert!(is_newer("1.0", "0.9.9"));
        assert!(!is_newer("0.2.0", "0.2.0"));
        assert!(!is_newer("v0.2.0", "0.2.1"));
        assert!(is_newer("0.2.1-beta", "0.2.0"));
    }

    #[test]
    fn reads_checksums() {
        let s = "AAAA1111  Nexus-Setup-v0.3.0.exe\nbbbb2222 *nexus.exe\n";
        assert_eq!(expected_hash(s, "Nexus-Setup-v0.3.0.exe").as_deref(), Some("aaaa1111"));
        assert_eq!(expected_hash(s, "nexus.exe").as_deref(), Some("bbbb2222"));
        assert_eq!(expected_hash(s, "other.exe"), None);
    }
}
