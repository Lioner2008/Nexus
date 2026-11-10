# Nexus

All-in-one game launcher for Windows. Rust backend ([Tauri 2](https://tauri.app)), plain HTML/CSS/JS frontend,
plus a small Rust server for chat and calls. Everything runs locally on your PC.

## Launcher

- Detects installed games from **Steam, Epic Games, GOG, Ubisoft Connect, EA app, Battle.net and the RSI Launcher (Star Citizen)**
- Optional: shows your **not installed** Steam games (Steam Web API key)
- Cover art, hero banners, logos and icons from [SteamGridDB](https://www.steamgriddb.com);
  per game you can pick another image from SteamGridDB, choose a file or paste a link (right click a game, or the image button in the header)
- Genres via the Steam Store, cached locally; favorites, recently played, search, sorting
- Themes: six accent colors, custom accent, backgrounds Black / Slate / Midnight / Clear (light), animated intro

## Social: chat, voice, video, screen sharing

`server/` is **nexus-server**, a standalone Rust server (axum + tokio) with

- accounts (Argon2 password hashes, session tokens), login / register
- text rooms, direct messages, history (persisted in `state.json`), typing indicators, online status
- voice rooms and 1:1 / group calls with or without video, screen sharing (game audio is mixed in), many rooms at the same time

Audio and video flow **peer-to-peer** (WebRTC, mesh up to 8 people per room); the server only relays the signaling.
Without a TURN server this works on a LAN and across most home routers. Optional environment variables for strict NATs:
`NEXUS_TURN_URL`, `NEXUS_TURN_USER`, `NEXUS_TURN_PASS`.

Nexus starts the local server together with the launcher (`127.0.0.1:7777`, data in `%APPDATA%\app.nexus.launcher\server`).
You can switch that off in the settings or start / stop it on the login screen of the *Chat & Voice* page.
To host for friends run it yourself on a reachable address: `nexus-server --bind 0.0.0.0:7777` (and forward the port).

```bash
cd server
cargo build --release
node tests/e2e.mjs http://127.0.0.1:7777     # smoke test against a running server (use a throw-away data dir)
```

### Devices

*Settings → Audio & video devices*: choose the microphone, headphones / speakers and camera, test them (level meter, camera preview,
test sound). Changes also apply to a running call.

### Playing with friends in other networks

By default the server only listens on this PC. **Settings → Play with friends over the internet** (Internet mode) restarts it with

```bash
nexus-server --bind 0.0.0.0:7777 --turn --upnp --invite <code>
```

- `--upnp` asks the router to forward TCP 7777 and the relay ports automatically (if the router has no UPnP, forward **TCP 7777** and **UDP 3478 + 49160-49200** yourself)
- `--turn` starts a built-in **TURN relay**; clients that reach the server over a non-local address get time-limited relay credentials,
  so calls work even when both players are behind strict NATs (voice and video stay peer-to-peer whenever possible)
- `--invite` makes creating an account require a code; the launcher generates one and shows it together with the address to give to friends

Friends enter `http://<your public IP>:7777` under *Chat & Voice → Server* and the invite code when creating their account.
Windows asks once to allow `nexus-server.exe` through the firewall. Not possible behind carrier-grade NAT (use a VPN such as Tailscale then).
**The connection is not encrypted** (HTTP/WebSocket): use a password you use nowhere else, or run everything over a VPN.

```bash
node server/tests/internet.mjs <nexus-server.exe> <lan-ip>   # invite code, STUN, TURN allocation
```

### TeamSpeak 3

The *TeamSpeak* tab talks to your running TeamSpeak 3 client through its **ClientQuery** interface
(no SDK needed): channel tree, who is talking, join channels, mute microphone / speakers, send channel messages.
In TeamSpeak enable *Tools → Options → Addons → ClientQuery* and paste the API key into Nexus.
The key is stored locally only (`%APPDATA%\app.nexus.launcher\settings.json`).

## Build

Requirements: [Rust](https://rustup.rs) and the Visual Studio C++ Build Tools.

```bash
cd src-tauri && cargo build --release      # launcher  -> target/release/nexus.exe
cd ../server && cargo build --release      # server    -> target/release/nexus-server.exe
```

Copy `nexus-server.exe` next to `nexus.exe` so the launcher can start it.
On Windows very long project paths can break the build; set `CARGO_TARGET_DIR` to a short path (e.g. `C:\nexus-build`).

## Setup

Open the settings (gear icon) and add:

- a **SteamGridDB API key** (https://www.steamgriddb.com/profile/preferences/api) for artwork
- optionally a **Steam Web API key** (https://steamcommunity.com/dev/apikey) to list your not installed Steam games

All keys are stored locally in `%APPDATA%\app.nexus.launcher\settings.json`; they only leave your PC in requests to the respective service.

## UI preview without Rust

`ui/` can be served by any static server (`python -m http.server` inside `ui/`); without Tauri a small mock backend with demo games is used.
The chat page talks directly to a running nexus-server.
