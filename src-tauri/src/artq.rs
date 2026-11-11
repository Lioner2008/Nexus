//! Background artwork downloads for the library grid. Runs entirely in Rust: the UI only says which
//! cards are on screen (those are fetched first) and receives an `art-updated` event per finished cover.

use crate::{art, AppState};
use serde_json::json;
use std::{
    collections::{HashSet, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Notify;

const WORKERS: usize = 3;

#[derive(Default)]
struct Inner {
    queue: VecDeque<String>,
    queued: HashSet<String>,
}

#[derive(Default)]
pub struct ArtQueue {
    inner: Mutex<Inner>,
    notify: Notify,
    /// set after SteamGridDB rejected the key; cleared when the key changes
    pub dead: AtomicBool,
}

impl ArtQueue {
    fn wake(&self) {
        for _ in 0..WORKERS {
            self.notify.notify_one();
        }
    }

    /// Appends games (in this order) that still need a cover.
    pub fn push_back(&self, ids: impl IntoIterator<Item = String>) {
        {
            let mut q = self.inner.lock().unwrap();
            for id in ids {
                if q.queued.insert(id.clone()) {
                    q.queue.push_back(id);
                }
            }
        }
        self.wake();
    }

    /// Moves the given games to the front (cards that are on screen right now).
    pub fn push_front(&self, ids: &[String]) {
        {
            let mut q = self.inner.lock().unwrap();
            let set: HashSet<&String> = ids.iter().collect();
            q.queue.retain(|x| !set.contains(x));
            for id in ids.iter().rev() {
                q.queued.insert(id.clone());
                q.queue.push_front(id.clone());
            }
        }
        self.wake();
    }

    pub fn clear(&self) {
        let mut q = self.inner.lock().unwrap();
        q.queue.clear();
        q.queued.clear();
    }

    fn pop(&self) -> Option<String> {
        let mut q = self.inner.lock().unwrap();
        let id = q.queue.pop_front()?;
        q.queued.remove(&id);
        Some(id)
    }
}

/// Ids of all games without a cover attempt, in the order of the default sorting.
pub fn missing_ids(st: &AppState) -> Vec<String> {
    let c = st.cache.lock().unwrap();
    let s = st.settings.lock().unwrap();
    let base = st.art_base.lock().unwrap().clone();
    let ctx = crate::library::Ctx {
        games: &c.library,
        art: &c.art,
        genres: &c.genres,
        settings: &s,
        art_base: &base,
        now: crate::now_secs(),
    };
    let mut list: Vec<&crate::Game> = c
        .library
        .iter()
        .filter(|g| c.art.get(&g.id).map(|a| a.cover.is_none() && !a.cover_tried).unwrap_or(true))
        .collect();
    ctx.sort(&mut list, "recent");
    list.into_iter().map(|g| g.id.clone()).collect()
}

/// Queues every game that still needs a cover (after a scan, at startup, after a new key).
pub fn queue_all(st: &AppState) {
    if st.settings.lock().unwrap().sgdb_key.trim().is_empty() {
        return;
    }
    let ids = missing_ids(st);
    st.artq.push_back(ids);
}

pub fn start_workers(app: &AppHandle) {
    for _ in 0..WORKERS {
        let app = app.clone();
        tauri::async_runtime::spawn(async move { worker(app).await });
    }
}

async fn worker(app: AppHandle) {
    loop {
        let id = {
            let st = app.state::<AppState>();
            match st.artq.pop() {
                Some(id) => id,
                None => {
                    st.artq.notify.notified().await;
                    continue;
                }
            }
        };
        let st = app.state::<AppState>();
        if st.artq.dead.load(Ordering::SeqCst) || st.settings.lock().unwrap().sgdb_key.trim().is_empty() {
            st.artq.clear();
            continue;
        }
        let game = {
            let c = st.cache.lock().unwrap();
            let need = c.art.get(&id).map(|a| a.cover.is_none() && !a.cover_tried).unwrap_or(true);
            c.library.iter().find(|g| g.id == id).filter(|_| need).cloned()
        };
        let Some(g) = game else { continue };
        match art::ensure_cover(&st, &g.id, &g.name, g.steam_appid).await {
            Ok(_) => {
                let payload = crate::with_ctx(&st, |ctx| {
                    let fav: HashSet<&str> = ctx.settings.favorites.iter().map(String::as_str).collect();
                    let counts = ctx.counts(&fav);
                    let cover = ctx
                        .art
                        .get(&g.id)
                        .and_then(|a| a.cover.as_deref())
                        .map(|p| ctx.art_url(&g.id, "cover", p));
                    json!({
                        "id": g.id,
                        "cover": cover,
                        "card": ctx.card_html(&g, 0, &fav),
                        "covered": counts.covered,
                        "tried": counts.tried,
                        "total": counts.all,
                    })
                });
                let _ = app.emit("art-updated", payload);
            }
            Err(e) if e.contains("API key") => {
                st.artq.dead.store(true, Ordering::SeqCst);
                st.artq.clear();
                let _ = app.emit("art-error", e);
            }
            Err(_) => {} // offline or rate limited: tried again on the next start
        }
    }
}
