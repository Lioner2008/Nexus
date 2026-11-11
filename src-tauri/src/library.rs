//! Library view model: filtering, sorting, counters, genre chips and the HTML of every card and of
//! the hero header. The web view only inserts what this module renders; it keeps no game logic itself.

use crate::{Art, Game, Settings};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
};

pub const PLATFORMS: [(&str, &str, &str, &str); 7] = [
    ("steam", "Steam", "ST", "#66c0f4"),
    ("epic", "Epic Games", "EP", "#e7ecf1"),
    ("gog", "GOG", "GG", "#b57bff"),
    ("ubisoft", "Ubisoft Connect", "UB", "#4aa8ff"),
    ("ea", "EA app", "EA", "#ff6a5a"),
    ("battlenet", "Battle.net", "BN", "#3d9cff"),
    ("rsi", "RSI Launcher", "RS", "#5ec8ff"),
];

const IC_PLAY: &str = r#"<svg viewBox="0 0 24 24"><path d="M7 4.5v15a1 1 0 0 0 1.5.9l12-7.5a1 1 0 0 0 0-1.8l-12-7.5A1 1 0 0 0 7 4.5z"/></svg>"#;
const IC_DOWNLOAD: &str = r#"<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 11l5 5 5-5M5 20h14"/></svg>"#;
const IC_HEART: &str = r#"<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.5-9.2C1 8 3.2 4.5 6.7 4.5c2 0 3.5 1 5.3 3 1.8-2 3.3-3 5.3-3 3.5 0 5.7 3.5 4.2 7.3C19.5 16.4 12 21 12 21z"/></svg>"#;

pub fn platform_name(id: &str) -> &str {
    PLATFORMS.iter().find(|p| p.0 == id).map(|p| p.1).unwrap_or(id)
}

fn platform_color(id: &str) -> &'static str {
    PLATFORMS.iter().find(|p| p.0 == id).map(|p| p.3).unwrap_or("#fff")
}

/// HTML escaping (same characters as the old `esc()` in the UI).
pub fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '&' => o.push_str("&amp;"),
            '<' => o.push_str("&lt;"),
            '>' => o.push_str("&gt;"),
            '"' => o.push_str("&quot;"),
            '\'' => o.push_str("&#39;"),
            _ => o.push(c),
        }
    }
    o
}

/// Stable color per title for the generated artwork (identical to the former JS version).
pub fn hue(name: &str) -> u32 {
    let mut h: u32 = 7;
    for u in name.encode_utf16() {
        h = h.wrapping_mul(31).wrapping_add(u as u32);
    }
    h % 360
}

pub fn fmt_play(m: u64) -> String {
    if m < 60 {
        format!("{m}m")
    } else if m < 600 {
        format!("{:.1}h", m as f64 / 60.0)
    } else {
        format!("{:.0}h", m as f64 / 60.0)
    }
}

pub fn fmt_size(b: u64) -> String {
    if b >= 1_000_000_000 {
        format!("{:.1} GB", b as f64 / 1e9)
    } else {
        format!("{} MB", (b as f64 / 1e6).round() as u64)
    }
}

pub fn ago(ts: u64, now: u64) -> String {
    let d = now.saturating_sub(ts) / 86_400;
    match d {
        0 => "today".into(),
        1 => "yesterday".into(),
        2..=29 => format!("{d} days ago"),
        _ => format!("{} mo ago", d / 30),
    }
}

// ───────────────────────────── query ─────────────────────────────

#[derive(Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Query {
    pub view: String,
    pub platform: Option<String>,
    pub install: String,
    pub genre: String,
    pub q: String,
    pub sort: String,
}

impl Default for Query {
    fn default() -> Self {
        Query {
            view: "all".into(),
            platform: None,
            install: "all".into(),
            genre: "ALL".into(),
            q: String::new(),
            sort: "recent".into(),
        }
    }
}

/// Everything the library needs from the shared state, borrowed for one call.
pub struct Ctx<'a> {
    pub games: &'a [Game],
    pub art: &'a HashMap<String, Art>,
    pub genres: &'a HashMap<String, Vec<String>>,
    pub settings: &'a Settings,
    /// base URL of the `art` protocol, e.g. `http://art.localhost/`
    pub art_base: &'a str,
    pub now: u64,
}

impl<'a> Ctx<'a> {
    fn fav(&self) -> HashSet<&str> {
        self.settings.favorites.iter().map(String::as_str).collect()
    }

    fn last_played(&self, g: &Game) -> u64 {
        self.settings.last_played.get(&g.id).copied().unwrap_or(0)
    }

    fn genres_of(&self, g: &Game) -> &[String] {
        self.genres.get(&g.id).map(Vec::as_slice).unwrap_or(&[])
    }

    /// URL under which the `art` protocol serves one image of one game. The revision
    /// changes whenever the file changes, so the web view never shows a stale cached image.
    pub fn art_url(&self, id: &str, kind: &str, path: &str) -> String {
        format!(
            "{}{kind}/{}?v={:x}",
            self.art_base,
            urlencoding::encode(id),
            short_hash(path)
        )
    }

    fn cover_url(&self, g: &Game) -> Option<String> {
        let p = self.art.get(&g.id)?.cover.as_deref()?;
        Some(self.art_url(&g.id, "cover", p))
    }

    fn filtered(&self, q: &Query, skip_genre: bool, fav: &HashSet<&str>) -> Vec<&'a Game> {
        let needle = q.q.trim().to_lowercase();
        self.games
            .iter()
            .filter(|g| {
                if q.view == "fav" && !fav.contains(g.id.as_str()) {
                    return false;
                }
                if q.view == "recent" && self.last_played(g) == 0 {
                    return false;
                }
                if let Some(p) = q.platform.as_deref() {
                    if g.platform != p {
                        return false;
                    }
                }
                if q.install == "installed" && !g.installed {
                    return false;
                }
                if q.install == "missing" && g.installed {
                    return false;
                }
                if !needle.is_empty() && !g.name.to_lowercase().contains(&needle) {
                    return false;
                }
                if !skip_genre && q.genre != "ALL" && !self.genres_of(g).iter().any(|t| *t == q.genre) {
                    return false;
                }
                true
            })
            .collect()
    }

    pub fn sort(&self, list: &mut [&Game], sort: &str) {
        let by_name = |a: &Game, b: &Game| cmp_name(&a.name, &b.name);
        match sort {
            "az" => list.sort_by(|a, b| by_name(a, b)),
            "played" => list.sort_by(|a, b| {
                b.playtime_min
                    .unwrap_or(0)
                    .cmp(&a.playtime_min.unwrap_or(0))
                    .then_with(|| self.last_played(b).cmp(&self.last_played(a)))
                    .then_with(|| by_name(a, b))
            }),
            "platform" => list.sort_by(|a, b| a.platform.cmp(&b.platform).then_with(|| by_name(a, b))),
            _ => list.sort_by(|a, b| {
                b.installed
                    .cmp(&a.installed)
                    .then_with(|| self.last_played(b).cmp(&self.last_played(a)))
                    .then_with(|| by_name(a, b))
            }),
        }
    }

    /// The game shown in the hero when nothing is selected: most recent installed game.
    pub fn default_selection(&self) -> Option<String> {
        let mut inst: Vec<&Game> = self.games.iter().filter(|g| g.installed).collect();
        if inst.is_empty() {
            inst = self.games.iter().collect();
        }
        self.sort(&mut inst, "recent");
        inst.first().map(|g| g.id.clone())
    }

    // ───────────── rendering ─────────────

    pub fn card_html(&self, g: &Game, i: usize, fav: &HashSet<&str>) -> String {
        let pname = platform_name(&g.platform);
        let genre = self.genres_of(g).first();
        let meta = if g.installed {
            format!(
                r#"<i class="dot"></i>{}{}"#,
                esc(pname),
                genre.map(|t| format!(" · {}", esc(t))).unwrap_or_default()
            )
        } else {
            format!("{} · Not installed", esc(pname))
        };
        let cover = self
            .cover_url(g)
            .map(|u| {
                format!(
                    r#"<img class="cover" src="{}" alt="" draggable="false" loading="lazy" decoding="async">"#,
                    esc(&u)
                )
            })
            .unwrap_or_default();
        let name = esc(&g.name);
        let (play_label, play_icon) = if g.installed { ("Play", IC_PLAY) } else { ("Install", IC_DOWNLOAD) };
        format!(
            r#"<article class="card{missing}" data-id="{id}" style="--i:{i};--h:{h}"><div class="card-art"><div class="gen"><b>{name}</b><small>{pn}</small></div>{cover}<div class="glare"></div>{favb}{dlb}<button class="card-play" data-act="play" aria-label="{play_label}">{play_icon}</button></div><div class="card-info"><b title="{name}">{name}</b><span>{meta}</span></div></article>"#,
            missing = if g.installed { "" } else { " missing" },
            id = esc(&g.id),
            i = i.min(26),
            h = hue(&g.name),
            pn = esc(pname),
            favb = if fav.contains(g.id.as_str()) {
                format!(r#"<span class="fav-badge">{IC_HEART}</span>"#)
            } else {
                String::new()
            },
            dlb = if g.installed {
                String::new()
            } else {
                format!(r#"<span class="dl-badge">{IC_DOWNLOAD}</span>"#)
            },
        )
    }

    fn chips_html(&self, q: &Query, fav: &HashSet<&str>) -> (String, String) {
        let list = self.filtered(q, true, fav);
        let mut counts: HashMap<&str, usize> = HashMap::new();
        for g in &list {
            for t in self.genres_of(g) {
                *counts.entry(t.as_str()).or_default() += 1;
            }
        }
        let genre = if q.genre != "ALL" && !counts.contains_key(q.genre.as_str()) {
            "ALL".to_string()
        } else {
            q.genre.clone()
        };
        let mut top: Vec<(&str, usize)> = counts.into_iter().collect();
        top.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(b.0)));
        top.truncate(18);
        let mut html = format!(
            r#"<button class="chip{}" data-g="ALL">All<sup>{}</sup></button>"#,
            if genre == "ALL" { " on" } else { "" },
            list.len()
        );
        for (t, n) in top {
            html.push_str(&format!(
                r#"<button class="chip{}" data-g="{e}">{e}<sup>{n}</sup></button>"#,
                if t == genre { " on" } else { "" },
                e = esc(t)
            ));
        }
        (html, genre)
    }

    pub fn counts(&self, fav: &HashSet<&str>) -> Counts {
        let mut platforms: HashMap<String, usize> = PLATFORMS.iter().map(|p| (p.0.to_string(), 0)).collect();
        let (mut favs, mut recent, mut installed, mut covered, mut tried) = (0, 0, 0, 0, 0);
        for g in self.games {
            *platforms.entry(g.platform.clone()).or_default() += 1;
            if fav.contains(g.id.as_str()) {
                favs += 1;
            }
            if self.last_played(g) > 0 {
                recent += 1;
            }
            if g.installed {
                installed += 1;
            }
            if let Some(a) = self.art.get(&g.id) {
                if a.cover.is_some() {
                    covered += 1;
                }
                if a.cover.is_some() || a.cover_tried {
                    tried += 1;
                }
            }
        }
        Counts { all: self.games.len(), fav: favs, recent, installed, platforms, covered, tried }
    }

    /// The whole library view for one query: ordered ids, the card of every id, chips and counters.
    pub fn view(&self, q: &Query) -> View {
        let fav = self.fav();
        let (chips, genre) = self.chips_html(q, &fav);
        let q2 = Query { genre: genre.clone(), ..q.clone() };
        let mut list = self.filtered(&q2, false, &fav);
        self.sort(&mut list, &q.sort);
        View {
            ids: list.iter().map(|g| g.id.clone()).collect(),
            cards: list.iter().enumerate().map(|(i, g)| self.card_html(g, i, &fav)).collect(),
            chips,
            genre,
            counts: self.counts(&fav),
        }
    }

    pub fn hero(&self, id: &str) -> Option<Hero> {
        let g = self.games.iter().find(|g| g.id == id)?;
        let default_art = Art::default();
        let a = self.art.get(&g.id).unwrap_or(&default_art);
        let url = |kind: &str, p: &Option<String>| p.as_deref().map(|p| self.art_url(&g.id, kind, p));
        let icon = url("icon", &a.icon);
        let status = format!(
            r#"{}<i class="dot"></i>{}"#,
            icon.as_deref()
                .map(|u| format!(r#"<img class="hero-icon" src="{}" alt="">"#, esc(u)))
                .unwrap_or_default(),
            if g.installed { "Installed" } else { "Not installed" }
        );
        let mut pills = vec![format!(
            r#"<span class="pill"><i style="--c:{}"></i>{}</span>"#,
            platform_color(&g.platform),
            esc(platform_name(&g.platform))
        )];
        for t in self.genres_of(g).iter().take(3) {
            pills.push(format!(r#"<span class="pill">{}</span>"#, esc(t)));
        }
        if let Some(m) = g.playtime_min.filter(|m| *m > 0) {
            pills.push(format!(r#"<span class="pill">{} played</span>"#, fmt_play(m)));
        }
        let lp = self.last_played(g);
        if lp > 0 {
            pills.push(format!(r#"<span class="pill">Last played {}</span>"#, ago(lp, self.now)));
        }
        if let (true, Some(b)) = (g.installed, g.size_bytes.filter(|b| *b > 0)) {
            pills.push(format!(r#"<span class="pill">{}</span>"#, fmt_size(b)));
        }
        let (bg_kind, bg_url) = match (&a.hero, &a.cover) {
            (Some(h), _) => ("hero", Some(self.art_url(&g.id, "hero", h))),
            (None, Some(c)) => ("blur", Some(self.art_url(&g.id, "cover", c))),
            _ => ("gen", None),
        };
        Some(Hero {
            id: g.id.clone(),
            name: g.name.clone(),
            installed: g.installed,
            status_html: status,
            logo: url("logo", &a.logo),
            meta_html: pills.concat(),
            can_play: g.installed || g.install_uri.is_some(),
            fav: self.settings.favorites.iter().any(|f| *f == g.id),
            folder: g.installed && g.install_path.is_some(),
            credit: if a.hero.is_some() || a.cover.is_some() { "Artwork · SteamGridDB".into() } else { String::new() },
            bg_kind: bg_kind.into(),
            bg_url,
            hue: hue(&g.name),
        })
    }
}

/// Title comparison close to `localeCompare`: case-insensitive first, then exact.
pub fn cmp_name(a: &str, b: &str) -> Ordering {
    let (la, lb) = (a.to_lowercase(), b.to_lowercase());
    la.cmp(&lb).then_with(|| a.cmp(b))
}

fn short_hash(s: &str) -> u32 {
    // FNV-1a: only used to version image URLs
    let mut h: u32 = 0x811c_9dc5;
    for b in s.bytes() {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Counts {
    pub all: usize,
    pub fav: usize,
    pub recent: usize,
    pub installed: usize,
    pub platforms: HashMap<String, usize>,
    pub covered: usize,
    pub tried: usize,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct View {
    pub ids: Vec<String>,
    pub cards: Vec<String>,
    pub chips: String,
    pub genre: String,
    pub counts: Counts,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Hero {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub status_html: String,
    pub logo: Option<String>,
    pub meta_html: String,
    pub can_play: bool,
    pub fav: bool,
    pub folder: bool,
    pub credit: String,
    pub bg_kind: String,
    pub bg_url: Option<String>,
    pub hue: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn game(id: &str, name: &str, platform: &str, installed: bool) -> Game {
        Game {
            id: id.into(),
            name: name.into(),
            platform: platform.into(),
            installed,
            ..Default::default()
        }
    }

    fn fixture() -> (Vec<Game>, HashMap<String, Art>, HashMap<String, Vec<String>>, Settings) {
        let games = vec![
            game("steam:1", "Zeta <Run>", "steam", true),
            game("epic:2", "alpha", "epic", false),
            game("gog:3", "Beta", "gog", true),
        ];
        let mut art = HashMap::new();
        art.insert(
            "steam:1".to_string(),
            Art { cover: Some("C:\\x\\steam_1_cover.jpg".into()), cover_tried: true, ..Default::default() },
        );
        let mut genres = HashMap::new();
        genres.insert("steam:1".to_string(), vec!["Action".to_string(), "Indie".to_string()]);
        genres.insert("gog:3".to_string(), vec!["Action".to_string()]);
        let mut settings = Settings::default();
        settings.favorites = vec!["gog:3".into()];
        settings.last_played.insert("gog:3".into(), 1000);
        (games, art, genres, settings)
    }

    fn ctx<'a>(f: &'a (Vec<Game>, HashMap<String, Art>, HashMap<String, Vec<String>>, Settings)) -> Ctx<'a> {
        Ctx { games: &f.0, art: &f.1, genres: &f.2, settings: &f.3, art_base: "http://art.localhost/", now: 1000 + 86_400 * 3 }
    }

    #[test]
    fn hue_matches_js() {
        // JS: let h = 7; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0; h % 360
        assert_eq!(hue("A"), (7 * 31 + 65) % 360);
        assert_eq!(hue(""), 7);
        let long = "Star Citizen: Squadron 42 – Ünïcödé";
        assert!(hue(long) < 360);
    }

    #[test]
    fn sorts_recent_installed_first() {
        let f = fixture();
        let v = ctx(&f).view(&Query::default());
        assert_eq!(v.ids, vec!["gog:3", "steam:1", "epic:2"]);
        assert_eq!(v.cards.len(), 3);
        assert_eq!(v.counts.all, 3);
        assert_eq!(v.counts.fav, 1);
        assert_eq!(v.counts.recent, 1);
        assert_eq!(v.counts.covered, 1);
        assert_eq!(v.counts.platforms["steam"], 1);
    }

    #[test]
    fn filters_and_genres() {
        let f = fixture();
        let c = ctx(&f);
        let v = c.view(&Query { genre: "Indie".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["steam:1"]);
        assert!(v.chips.contains(r#"<button class="chip on" data-g="Indie">Indie<sup>1</sup></button>"#));
        assert!(v.chips.contains(r#"data-g="Action">Action<sup>2</sup>"#));
        // unknown genre falls back to ALL
        let v = c.view(&Query { genre: "Nope".into(), ..Default::default() });
        assert_eq!(v.genre, "ALL");
        assert_eq!(v.ids.len(), 3);
        let v = c.view(&Query { q: "ALP".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["epic:2"]);
        let v = c.view(&Query { view: "fav".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["gog:3"]);
        let v = c.view(&Query { install: "missing".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["epic:2"]);
        let v = c.view(&Query { platform: Some("steam".into()), sort: "az".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["steam:1"]);
        let v = c.view(&Query { sort: "az".into(), ..Default::default() });
        assert_eq!(v.ids, vec!["epic:2", "gog:3", "steam:1"]);
    }

    #[test]
    fn card_is_escaped_and_has_cover() {
        let f = fixture();
        let c = ctx(&f);
        let v = c.view(&Query { sort: "az".into(), ..Default::default() });
        let zeta = &v.cards[2];
        assert!(zeta.contains("Zeta &lt;Run&gt;"));
        assert!(zeta.contains(r#"src="http://art.localhost/cover/steam%3A1?v="#));
        assert!(zeta.contains(r#"<i class="dot"></i>Steam · Action"#));
        let alpha = &v.cards[0];
        assert!(alpha.contains(r#"class="card missing""#));
        assert!(alpha.contains("Epic Games · Not installed"));
        assert!(alpha.contains("dl-badge"));
        assert!(v.cards[1].contains("fav-badge"));
    }

    #[test]
    fn hero_view() {
        let f = fixture();
        let c = ctx(&f);
        let h = c.hero("gog:3").unwrap();
        assert!(h.fav && h.can_play && !h.folder);
        assert!(h.meta_html.contains("Last played 3 days ago"));
        assert_eq!(h.bg_kind, "gen");
        let h = c.hero("steam:1").unwrap();
        assert_eq!(h.bg_kind, "blur");
        assert_eq!(c.default_selection().as_deref(), Some("gog:3"));
    }

    #[test]
    fn formats() {
        assert_eq!(fmt_play(59), "59m");
        assert_eq!(fmt_play(90), "1.5h");
        assert_eq!(fmt_play(6000), "100h");
        assert_eq!(fmt_size(12_300_000_000), "12.3 GB");
        assert_eq!(fmt_size(450_000_000), "450 MB");
        assert_eq!(ago(0, 86_400 * 65), "2 mo ago");
    }
}
