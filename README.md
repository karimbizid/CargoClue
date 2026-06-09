<p align="center">
  <img src="public/logo.png" alt="CargoClue" width="360" />
</p>

<h1 align="center">CargoClue</h1>

<p align="center">
  A simple web app to browse, filter and pin logs from Docker containers and stacks.
</p>

---

CargoClue runs as a single container that talks to the host Docker socket, so one
instance can monitor **all** stacks (Compose projects) on the machine.

## Features

- **Stack selector** — a dropdown to switch between Compose projects, or *All stacks*.
- **Grouped container list** (left) — containers are grouped under their stack with a
  `running/total` count.
  - Click a **stack header** to follow the **aggregated logs of every container** in that
    stack at once; each line is tagged with its source container (colour-coded).
  - Click a **single container** to follow just that one.
  - Collapse/expand each stack with the caret; standalone (non-Compose) containers are
    listed under *Standalone*.
  - The list auto-refreshes every 10 s so state changes (start/stop) show up.
- **Live log window** (right) — logs stream in real time over a WebSocket and are
  **colour-coded by level**: errors red, warnings yellow, info blue, debug/plain dimmed.
- **Level filter chips** — toggle **Error / Warning / Info / Debug** to show only those
  levels (combine multiple; none selected = show everything).
- **Text filter & autoscroll** — free-text filter over the visible lines, with an
  autoscroll toggle that sticks to the bottom only when you're already there.
- **Time-window export** — set a number of minutes and copy or download that slice of the
  current log to the clipboard / a `.log` file. The minutes value is remembered.
- **Pin entries** — hover a log line and click the 📌 to pin it; each line also has a copy
  button that copies the whole entry.
- **Pinned list** (bottom, full width) — pinned entries persist per browser via
  `localStorage` and survive reloads; unpin individually or clear all.
- **Light & dark mode** — toggle with the sun/moon button top-right, remembered per browser.
- **Version indicator & GitHub link** — the running version is shown top-right with a
  GitHub link that flags when a newer CargoClue release is available.
- **Watchtower** — actively scans recent logs for secrets/PII (API keys, tokens,
  passwords, private keys, credentials in URLs, e-mails, IPs). The header chip lists which
  containers expose sensitive data and **blinks** when a new sensitive line streams in.
- **Incognito export** — toggle the 🥸 mask in the export toolbar to redact all sensitive
  data from copies/downloads, so a log slice is safe to paste into e.g. an AI chat.

## Quick start

Pull and run — **one command**, no files needed. It pulls the image automatically the
first time:

```bash
docker run -d --name cargoclue \
  -p 9999:9999 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  karimbizid/cargoclue:latest
```

Then open **http://localhost:9999**. That's it.

The two flags are required: `-p` publishes the web UI, and `-v` mounts the host Docker
socket **read-only** so CargoClue can see your containers. No other configuration needed.

### Updating

CargoClue tells you when a newer release exists: the **GitHub icon** in the top-right
gets a dot and tooltip. To update, run the bundled one-liner script:

```bash
curl -fsSL https://raw.githubusercontent.com/karimbizid/CargoClue/main/update.sh | sh
```

It pulls the latest image and recreates the container with the same settings. You can
override `CARGOCLUE_PORT` / `CARGOCLUE_IMAGE` / `CARGOCLUE_NAME` as env vars if you run it
on a non-default setup.

Prefer to do it by hand? That's just:

```bash
docker pull karimbizid/cargoclue:latest
docker rm -f cargoclue
# then run the docker run command above again
```

> Prefer Compose? Copy [`docker-compose.deploy.yml`](docker-compose.deploy.yml) to the
> machine, set its `image:` line, and run `docker compose -f docker-compose.deploy.yml pull && docker compose -f docker-compose.deploy.yml up -d`.

## Build from source (development)

```bash
docker compose up -d --build
```

> **Note:** after changing files you must rebuild the image (`--build`).
> `docker compose --force-recreate` alone reuses the old image and keeps serving the
> previous version. Also hard-refresh the browser (Cmd/Ctrl + Shift + R) to bypass
> cached `app.js` / `style.css`.

## Run locally (without Docker)

Requires Node 20+ and access to a Docker socket on the host:

```bash
npm install
npm start
```

## Configuration

| Env var         | Default                | Description                       |
| --------------- | ---------------------- | --------------------------------- |
| `PORT`          | `9999`                 | HTTP port the app listens on.     |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Path to the Docker socket to use. |

## How it works

- `dockerode` talks to the Docker Engine API over the mounted socket.
- `GET /api/stacks` and `GET /api/containers?stack=…` drive the UI lists.
- `GET /api/version` exposes the version shown in the header.
- `GET /api/self-update-check` compares the running version with `package.json` on the
  GitHub repo to flag when a newer CargoClue release exists (cached for an hour).
- `GET /api/sensitive-scan` reads each container's recent logs and reports which expose
  secrets/PII (regex-based; samples are returned already masked). Cached, refreshed in the
  background. The same rules power the incognito export masking.
- `GET /api/updates` reports, per container, whether a newer image exists. It compares the
  locally pulled image digest with the registry's current digest for the same tag
  (best-effort, anonymous; results are cached and refreshed in the background).
- `WS /ws/logs?ids=<id1,id2,…>&tail=300` streams logs. A single id follows one
  container; a comma-separated list follows a whole stack, multiplexing all of them
  onto one socket. Non-TTY streams are demultiplexed into stdout/stderr and a log level
  is inferred per line for colour-coding.

## Versioning

The version in `package.json` is bumped on **every** change and surfaced in the UI
(top-right). Use it to confirm a rebuild actually took effect. Each version is recorded
in the changelog below.

## Changelog

### v0.4.0
- **Watchtower**: header chip that scans recent logs for sensitive data (keys, tokens,
  passwords, private keys, URL credentials, e-mails, IPs), lists exposing containers, and
  blinks when a new sensitive line arrives until you open it.
- **Incognito export**: a 🥸 toggle that masks all sensitive data in copied/downloaded log
  slices, so they're safe to share (e.g. paste into an AI chat).

### v0.3.1
- Cleaned up the minutes input (hid the cramped native number spinners).
- Downloaded log files now get a readable name: `CONTAINER - YYYY-MM-DD HH-MM-SS - LAST N MINUTES.log`.

### v0.3.0
- **Time-window export**: a minutes input + copy/download buttons in the log toolbar to
  grab the last N minutes of the current log (the value is remembered).
- **GitHub link** next to the version, opening the repo in a new tab.
- **New-version indicator**: the GitHub link flags when a newer CargoClue release is
  available (compares against `package.json` on GitHub).
- **`update.sh`** one-liner script for easy updates when installed via `docker run`.

### v0.2.0
- **Light mode** with a sun/moon toggle (top-right), remembered per browser.
- **Expand/collapse all stacks** via the `+` / `−` buttons next to *Containers*
  (individual stacks remain collapsible with their caret).
- **Copy button** on every log line — copies the full entry to the clipboard.
- **Per-entry unpin** in the pinned list (pushpin-with-cross icon).
- **Update indicator** (⬆) on a container when a newer image is available in the
  registry (best-effort; anonymous registries / Docker Hub).

### v0.1.4
- Image now builds as `cargoclue` instead of `cargoclue-cargoclue`; added a deploy guide
  and `docker-compose.deploy.yml` for running from a published image.

### v0.1.3
- Enlarged the header logo (the top bar scales with it).

### v0.1.2
- Made the logo background transparent (removed the white badge).

### v0.1.1
- README with the full feature list and logo header.

### v0.1.0
- Initial release: stack dropdown, grouped container list, live colour-coded log
  streaming over WebSocket, level chips, text filter, autoscroll, and pinning.

## Security note

The Docker socket is mounted read-only, but access to it is still powerful.
Run CargoClue only on trusted networks, or put it behind authentication / a
reverse proxy if exposing it beyond localhost.

**Watchtower / incognito masking are best-effort.** Detection and redaction are
regex-based, so they can miss unusual secret formats or occasionally over-match. Always
sanity-check a masked export before sharing it — don't treat it as a guarantee.
