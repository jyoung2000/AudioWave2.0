# Now Playing Hub

A self-hosted music hub in one container: your library, group listening in sync, device pairing,
shared links, provider connections and a Discord bot. It runs on a laptop, a NAS or a small VPS, and
it keeps its data in one directory you can back up and move.

It is optional. The [player](../music-player/README.md) works entirely on its own, and so does the
[Windows companion](../windows-companion/README.md). The hub is what connects them.

## Install it

```sh
git clone https://github.com/jyoung2000/AudioWave2.0.git
cd AudioWave2.0/docker-container
./nowplaying install
```

Then open <http://localhost:4546> and sign in with **admin / admin**. You will be asked to choose a
real password before anything else is enabled — until you do, the hub stays on this machine: no
pairing, no providers, no group listening, no Discord bot, no remote access. That gate is enforced by
the server, not by the interface hiding buttons.

`install` builds the image and starts the containers **detached**, and the compose file sets
`restart: unless-stopped`. Close the terminal, log out, reboot — the hub comes back on its own, as
long as Docker itself starts at boot (`sudo systemctl enable --now docker` on most Linux systems).

### If the build is slow or your connection is unreliable

```sh
./nowplaying install --detach
```

This runs the whole install in a process with no controlling terminal, so an SSH drop cannot
interrupt it. It prints a log path and returns immediately:

```
Started in the background (pid 51234). You can close this terminal.
Log:    …/docker-container/data/logs/20260904T161200Z-install.log
Follow: tail -f "…/data/logs/20260904T161200Z-install.log"
```

## Keep it up to date

```sh
./nowplaying update              # fetch, rebuild, restart — in the foreground
./nowplaying update --detach     # …in the background, survives the terminal closing
./nowplaying schedule --weekly   # …on its own, with nobody logged in
```

`schedule` installs a systemd timer where systemd exists, and a cron entry otherwise. It picks up
missed runs after the machine was off, and staggers itself by up to an hour so every install in the
world does not update at the same minute. `schedule --off` removes it.

If the timer is installed for your user rather than system-wide, it only runs while you are logged
in unless you allow lingering — the command tells you so, and prints the exact line:

```sh
sudo loginctl enable-linger "$USER"
```

Updates keep whatever you started with: if you installed with `--discord`, the bot comes back after
every update. Local edits to the source are respected — the script rebuilds what is on disk rather
than throwing your changes away.

## The rest of the commands

|  |  |
| --- | --- |
| `./nowplaying status` | what is running, and whether the hub is answering |
| `./nowplaying logs -f` | follow the container logs |
| `./nowplaying start` / `stop` / `restart` | the obvious things |
| `./nowplaying backup [DIR]` | stop, archive `data/`, start again |
| `./nowplaying uninstall` | remove the containers; **your data is left alone** |

A backup archive holds the database, the library index, artwork **and the installation key**. The key
decrypts stored provider credentials, so treat the archive as a secret.

## Reaching it from other devices

A fresh install publishes the port to `127.0.0.1` only. Making it reachable is two deliberate edits
to `compose.yaml` — the published port *and* `NP_BIND_MODE` — and this script will not make either of
them for you. `./nowplaying install --lan` prints what to change and why; it does not change it.

The hub never opens a port on your behalf: no UPnP, no NAT hole punching, no relay service. What
works from where, and what each option actually costs, is in
[docs/REMOTE_ACCESS.md](../docs/REMOTE_ACCESS.md) and in the admin GUI under **Network**.

## Configuration

Everything is an environment variable in `compose.yaml`, and every one of them is commented there.
The ones worth knowing:

| Variable | Default | What it does |
| --- | --- | --- |
| `NP_DATA_DIR` | `/data` | Everything the hub owns. Back this up and the hub is portable. |
| `NP_PORT` | `4546` | Port inside the container. |
| `NP_BIND_MODE` | `localhost` | `localhost`, `lan` or `remote`. Anything but `localhost` stays inactive until the admin password is changed. |
| `NP_PUBLIC_ENDPOINT` | — | Absolute `https://` URL when behind a reverse proxy. Pairing and share links are unreachable for others until this is set. |
| `NP_TRUSTED_PROXY_CIDRS` | — | CIDRs whose `X-Forwarded-For` is believed. Leave empty unless a proxy you control sits in front. |
| `NP_IP_LOGGING` | `truncated` | `truncated`, `hashed` or `full`. |
| `NP_DISCORD_TOKEN` | — | Prefer setting this in the admin GUI, where it is encrypted at rest with the installation key. |

## The Discord bot

```sh
./nowplaying install --discord      # or, later:
docker compose --profile discord up -d
```

It runs as its own container so a gateway outage cannot take the API down with it. Slash commands
and prefix commands go through one shared command service, so they behave identically —
[docs/DISCORD_BOT.md](../docs/DISCORD_BOT.md).

## Running from source

```sh
pnpm install
pnpm --filter @now-playing/hub dev     # API on 4546, admin GUI on Vite with hot reload
pnpm --filter @now-playing/hub build   # dist/server.js + dist/web/
pnpm --filter @now-playing/hub test    # unit, integration and security
pnpm --filter @now-playing/hub test:e2e
```

The e2e suite boots the built server against a fresh data directory and drives the admin GUI in a
real browser, including the first-run gate — checked at the API as well as in the interface, because
a gate you can walk around by calling the API directly is not a gate.

## What it will not do

- It does not bypass DRM, scrape sites, or read your browser's cookies. Providers are used through
  their own APIs, within their terms — [docs/PROVIDER_CAPABILITIES.md](../docs/PROVIDER_CAPABILITIES.md).
- A stream URL never implies a download. Where a provider does not allow downloading, the interface
  says so instead of offering a button that fails.
- No telemetry, no analytics, no crash reporting. IP addresses are truncated by default.
- It never opens a port for you.
