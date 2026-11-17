# Nexus Server on a Pterodactyl panel

`egg-nexus-server.json` is a [Pterodactyl](https://pterodactyl.io) **egg** for [`nexus-server`](../server): accounts, chat,
voice/video call signaling and the built-in TURN relay for the Nexus launcher. Import it, create a server, set a few
variables, start – no Docker image of your own is needed:

- the egg runs in the stock Pterodactyl image (`ghcr.io/pterodactyl/yolks:debian`, Alpine selectable)
- the install script downloads `nexus-server-linux-x64` (a static Linux build) from the
  [GitHub release](https://github.com/Lioner2008/Nexus/releases) and checks it against `SHA256SUMS.txt`
- the port comes from the panel, everything else from the egg variables (the server reads them as `NEXUS_*` environment variables)

## 1. Ports (node allocations)

| Purpose              | Protocol | Default        | Egg variable                           |
| -------------------- | -------- | -------------- | -------------------------------------- |
| HTTP / WebSocket     | TCP      | any port       | primary allocation (`SERVER_PORT`)     |
| TURN relay           | UDP      | 3478           | *TURN port*                            |
| Relayed media        | UDP      | 49160–49200    | *Relay ports: first* / *last*          |

Wings publishes every allocation for TCP **and** UDP, so add them as normal allocations
(Admin → Nodes → *node* → Allocation; a range like `49160-49200` is expanded to single ports).
One relayed stream uses one relay port, so 41 ports are enough for about 20 relayed streams at the same time.
A smaller range is fine – keep the variables in sync. If you don't want the relay (calls then only work when the
players can reach each other directly), switch *TURN relay* off and allocate just the TCP port.

## 2. Import the egg

Admin → Nests → *Import Egg* → `egg-nexus-server.json` (into a nest of your choice, e.g. a new nest "Nexus").

## 3. Create the server

Admin → Servers → *Create New*: nest/egg **Nexus Server**, the TCP allocation as the **primary** one, the UDP
allocations as additional ones. 256 MB memory and one CPU are plenty.

The install script needs internet access to github.com. If it fails with *download failed*, the chosen release has no
Linux build yet (they exist from **v0.5.2** on) – pick another *Version* or set *Download URL*, then reinstall.

## 4. Variables (Server → Startup)

| Variable                  | Env variable         | What it does                                                                                                   |
| ------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Invite code               | `NEXUS_INVITE`       | Friends need it to create an account. Set one on a server that is reachable from the internet.                 |
| TURN relay                | `NEXUS_TURN`         | Switch. On = built-in relay for calls behind strict NATs (needs the UDP ports). Off = signaling only.           |
| TURN port                 | `NEXUS_TURN_PORT`    | UDP port of the relay, must be allocated to this server.                                                        |
| Relay ports: first / last | `NEXUS_RELAY_MIN/MAX`| The UDP range for relayed media, must be allocated to this server.                                              |
| Public address            | `NEXUS_PUBLIC_IP`    | Public IP or host name of the node, announced for relayed media. Empty = the allocation's IP, if it is public.   |
| Version                   | `NEXUS_VERSION`      | `latest` or a release tag (`v0.5.2`). Reinstall the server after changing it.                                  |
| Download URL (advanced)   | `NEXUS_DOWNLOAD_URL` | Direct link to a Linux x86_64 `nexus-server`, for forks or own builds. Overrides *Version*.                     |

The startup command is `exec ./nexus-server --bind 0.0.0.0:{{SERVER_PORT}} --data nexus-data`. The `exec` makes
the server the container's main process so the panel's *Stop* reaches it directly (graceful shutdown, state saved).

**Public address**: Wings passes the IP of the server's allocation (`SERVER_IP`) and the server uses it when it is a
public address. On nodes whose allocations use an internal IP (behind NAT, `0.0.0.0`) set the node's public IP or
host name here, otherwise relayed calls will not connect. The console tells you:

```
Nexus Server 0.5.2 listening on http://0.0.0.0:7777  (data: nexus-data)
  public address: http://203.0.113.7:7777
  TURN relay: UDP 3478, relay ports 49160-49200
  accounts need the invite code
```

If a line `Note: relayed media is announced as 172.18.0.2 …` appears, *Public address* is missing.

## 5. Connect

In the launcher under *Chat & Voice → Server* enter `http://<node ip or domain>:<TCP port>`; new accounts need the
invite code. Accounts, rooms, history and the TURN secret live in `nexus-data/` on the server volume and survive
restarts and reinstalls.

The connection is plain HTTP/WebSocket (not encrypted): use a password you use nowhere else, or put the TCP port
behind a reverse proxy with TLS / a VPN.

## Updating

Set *Version* (or leave `latest`), then Server → Settings → *Reinstall Server*. `nexus-data/` is kept.

## Troubleshooting

- **Install fails with "download failed"** – the release has no `nexus-server-linux-x64` (Linux builds exist from v0.5.2 on) or the node has no access to github.com. Choose another *Version* or give a *Download URL*.
- **Console: `cannot listen on 0.0.0.0:7777`** – another process in the container uses the port; the startup command was edited. Restore it (see above).
- **Console: `UDP port 3478 is not available`** – only possible when the startup command was changed; the relay binds inside the container, allocations do not matter for this message.
- **Calls connect on the LAN but not across the internet** – check that the UDP ports are allocated to *this* server, match the variables and are not blocked by a firewall, and that *Public address* is right (see the console lines above).
- **"The selected value is invalid" on the TURN switch** – re-import the egg; the switch saves `1`/`0`.

## Running the Linux build without Pterodactyl

The same binary works on any x86_64 Linux (static, no dependencies):

```bash
curl -fLO https://github.com/Lioner2008/Nexus/releases/latest/download/nexus-server-linux-x64
chmod +x nexus-server-linux-x64
NEXUS_INVITE=secret NEXUS_TURN=1 NEXUS_PUBLIC_IP=203.0.113.7 ./nexus-server-linux-x64 --bind 0.0.0.0:7777
```

Open TCP 7777 and UDP 3478 + 49160–49200 in the firewall. `nexus-server --help` lists every option.
