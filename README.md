# Nexus

All-in-one game launcher for Windows. Rust backend ([Tauri 2](https://tauri.app)), plain HTML/CSS/JS frontend.

- Detects installed games from **Steam, Epic Games, GOG, Ubisoft Connect, EA app and Battle.net**
- Optional: shows your **not installed** Steam games (Steam Web API key)
- Cover art, hero banners, logos and icons from [SteamGridDB](https://www.steamgriddb.com)
- Genres via the Steam Store, cached locally; favorites, recently played, search, sorting

## Build

Requirements: [Rust](https://rustup.rs) and the Visual Studio C++ Build Tools.

```bash
cd src-tauri
cargo build --release
```

The executable is `target/release/nexus.exe`. On Windows, very long project paths can break the build;
set `CARGO_TARGET_DIR` to a short path (e.g. `C:\nexus-build`) if that happens.

## Setup

Open the settings (gear icon) and add:

- a **SteamGridDB API key** (https://www.steamgriddb.com/profile/preferences/api) for artwork
- optionally a **Steam Web API key** (https://steamcommunity.com/dev/apikey) to list your not installed Steam games

Keys are stored locally in `%APPDATA%\app.nexus.launcher\settings.json` and never leave your PC except in requests to the respective service.

## UI preview without Rust

`ui/` can be served by any static server (`python -m http.server` inside `ui/`); without Tauri a small mock backend with demo games is used.
