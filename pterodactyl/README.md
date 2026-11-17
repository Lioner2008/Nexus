# Nexus Server on Pterodactyl Panel

This folder contains an **egg** for hosting [`nexus-server`](../server) (chat, voice & video signaling, TURN relay for the Nexus launcher) on a Pterodactyl panel.

The egg runs a prebuilt Linux Docker image (`ghcr.io/lioner2008/nexus-server:latest`), built from `server/` by [.github/workflows/docker.yml](../.github/workflows/docker.yml) and pushed to GHCR:

- push to `main` → `latest`
- tag `v0.5.1` → `0.5.1`, `0.5` and `latest`

> **Image name**: the egg and workflow use `ghcr.io/lioner2008/nexus-server`. If you host this repo under a different account, replace `lioner2008` in `egg-nexus-server.json` (3 places) and push the workflow – the image name is derived automatically from the repo owner.

## 1. Build the image

Push to `main` (or run the **Docker** workflow manually in the *Actions* tab). The panel pulls the image when a server is installed.

### Make the image pullable

GHCR packages are **private by default**, so your panel's node cannot pull the image until you do one of the following:

- **Public package (simplest):** GitHub → your profile → Packages → `nexus-server` → Package Settings → *Danger Zone* → *Change visibility* → **Public**, or
- **Node credentials:** in the panel, add the node's Docker registry credentials (Admin → Nodes → *your node* → System Information → Docker Registry, or via `wings` config) using a GitHub personal access token with `read:packages` scope.

## 2. Prepare the node

The server needs **UDP ports** when the TURN relay is enabled (voice/video across strict NATs):

| Purpose             | Protocol | Default ports        | Egg variable         |
| ------------------- | -------- | -------------------- | -------------------- |
| HTTP / WebSocket    | TCP      | 7777 (any port)      | `{{SERVER_PORT}}`    |
| TURN relay          | UDP      | 3478                 | `TURN_PORT`          |
| TURN relay media    | UDP      | 49160–49200 (41)     | `RELAY_MIN`/`RELAY_MAX` |

Add these as **allocations** on the node (Admin → Nodes → *your node* → Allocation; the panel accepts ranges like `49160-49200` and expands them to individual ports). Each simultaneous relayed call stream uses one relay port, so 41 ports ≈ 20 concurrent relayed streams. You can use a smaller range, just keep `RELAY_MIN`/`RELAY_MAX` in sync.

## 3. Import the egg

Admin → Nests → Import Egg → upload `egg-nexus-server.json`.

## 4. Create the server

Admin → Servers → Create New:

- Nest: **Nexus**, Egg: **Nexus Server**
- Allocations: the **TCP** port from step 2 (primary) plus the **UDP** ports (3478, 49160–49200)
- Memory: 256 MB is plenty (the server is tiny); CPU: 100 % is fine

## 5. Configure and start

Server → Startup, set:

| Variable       | Recommendation                                                     |
| -------------- | ------------------------------------------------------------------ |
| Invite code    | A secret code – only people who know it can create accounts        |
| Enable TURN    | `1` if you allocated the UDP ports                                 |
| TURN port      | Must match an allocated UDP port (default 3478)                    |
| Relay min/max  | Must match the allocated UDP range                                 |
| Public IP      | **The node's public IP** – inside Docker the auto-detected address is wrong and TURN would not work. Leave empty only if TURN is off |

Then start the server. The console should show:

```
Nexus Server 0.5.1 listening on http://0.0.0.0:7777  (data: nexus-data)
  TURN relay: UDP 3478, relay ports 49160-49200
```

All accounts, rooms and the TURN secret live in `nexus-data/` inside the server volume and survive reinstalls and restarts.

Friends connect with `http://<node ip or domain>:<TCP port>` under *Chat & Voice → Server* in the launcher. Remember the connection itself is **not encrypted** (HTTP/WebSocket) – use a password you use nowhere else, put the panel port behind a proxy/reverse proxy, or use a VPN.

## Updating

When a new image is published (push to `main` or a new tag), reinstall the server (Server → Settings → Reinstall Server) to pull the new image. Data in `nexus-data/` is kept.

## Running the image manually

```bash
docker run --rm -p 7777:7777 -p 3478:3478/udp \
  -v nexus-data:/home/container/nexus-data \
  -e INVITE_CODE=secret \
  ghcr.io/lioner2008/nexus-server:latest \
  /usr/local/bin/nexus-server --bind 0.0.0.0:7777 --data nexus-data --turn --invite secret
```
