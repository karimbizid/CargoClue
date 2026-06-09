'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const Docker = require('dockerode');
const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { PassThrough } = require('stream');
const readline = require('readline');

const VERSION = require('./package.json').version;
const PORT = process.env.PORT || 9999;
const SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const STACK_LABEL = 'com.docker.compose.project';
const NO_STACK = '(no stack)';

const docker = new Docker({ socketPath: SOCKET });
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

// Normalize a Docker container summary into the shape the UI needs.
function mapContainer(c) {
  const name = (c.Names && c.Names[0] ? c.Names[0] : c.Id).replace(/^\//, '');
  const labels = c.Labels || {};
  return {
    id: c.Id,
    name,
    image: c.Image,
    state: c.State, // running, exited, paused, ...
    status: c.Status, // human readable, e.g. "Up 3 hours"
    stack: labels[STACK_LABEL] || NO_STACK,
  };
}

app.get('/api/version', (req, res) => {
  res.json({ version: VERSION });
});

/* ---- Self-update check: compare running version with package.json on GitHub ---- */
const REPO_RAW = 'https://raw.githubusercontent.com/karimbizid/CargoClue';
const SELF_TTL_MS = 60 * 60 * 1000;
let latestVersion = { value: null, checkedAt: 0 };

function cmpSemver(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function getLatestVersion() {
  if (latestVersion.value && Date.now() - latestVersion.checkedAt < SELF_TTL_MS) {
    return latestVersion.value;
  }
  for (const branch of ['main', 'master']) {
    try {
      const res = await fetch(`${REPO_RAW}/${branch}/package.json`, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const json = await res.json();
      if (json.version) {
        latestVersion = { value: json.version, checkedAt: Date.now() };
        return json.version;
      }
    } catch { /* try next branch / give up */ }
  }
  return latestVersion.value; // may be null when offline / not yet known
}

app.get('/api/self-update-check', async (req, res) => {
  const latest = await getLatestVersion();
  res.json({
    current: VERSION,
    latest,
    updateAvailable: latest ? cmpSemver(latest, VERSION) > 0 : false,
    repo: 'https://github.com/karimbizid/CargoClue',
  });
});

app.get('/api/health', (req, res) => {
  docker.ping()
    .then(() => res.json({ ok: true }))
    .catch((err) => res.status(500).json({ ok: false, error: err.message }));
});

// List distinct stacks (compose projects) across all containers.
app.get('/api/stacks', async (req, res) => {
  try {
    const containers = await docker.listContainers({ all: true });
    const stacks = new Set();
    for (const c of containers) {
      const labels = c.Labels || {};
      stacks.add(labels[STACK_LABEL] || NO_STACK);
    }
    res.json({ stacks: [...stacks].sort((a, b) => a.localeCompare(b)) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List containers, optionally filtered by stack.
app.get('/api/containers', async (req, res) => {
  try {
    const { stack } = req.query;
    const containers = await docker.listContainers({ all: true });
    let mapped = containers.map(mapContainer);
    if (stack && stack !== 'all') {
      mapped = mapped.filter((c) => c.stack === stack);
    }
    mapped.sort((a, b) => {
      // Running containers first, then alphabetically.
      if (a.state === 'running' && b.state !== 'running') return -1;
      if (b.state === 'running' && a.state !== 'running') return 1;
      return a.name.localeCompare(b.name);
    });
    res.json({ containers: mapped });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ---------------- Image update detection (best effort) ----------------
 * Compares the locally pulled image digest against the registry's current
 * digest for the same tag. Works anonymously for Docker Hub and registries
 * that allow anonymous pulls; silently skips anything it can't resolve
 * (locally built images, private registries needing credentials, offline). */
const MANIFEST_ACCEPT = [
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
].join(', ');

let updatesByContainer = {}; // containerId -> true when an update is available
let lastUpdateScan = 0;
let scanningUpdates = false;

function parseImageRef(ref) {
  let rest = ref.split('@')[0]; // drop any pinned digest
  let registry = 'registry-1.docker.io';
  const slash = rest.indexOf('/');
  if (slash !== -1) {
    const first = rest.slice(0, slash);
    if (first.includes('.') || first.includes(':') || first === 'localhost') {
      registry = first;
      rest = rest.slice(slash + 1);
    }
  }
  let tag = 'latest';
  const colon = rest.lastIndexOf(':');
  if (colon !== -1 && !rest.slice(colon).includes('/')) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  let repo = rest;
  if (registry === 'registry-1.docker.io' && !repo.includes('/')) repo = 'library/' + repo;
  return { registry, repo, tag };
}

async function fetchRegistryToken(wwwAuth) {
  // e.g. Bearer realm="https://auth.docker.io/token",service="registry.docker.io",scope="repository:library/nginx:pull"
  const m = /Bearer\s+(.*)/i.exec(wwwAuth || '');
  if (!m) return null;
  const params = {};
  for (const part of m[1].split(',')) {
    const kv = /(\w+)="([^"]*)"/.exec(part.trim());
    if (kv) params[kv[1]] = kv[2];
  }
  if (!params.realm) return null;
  const url = new URL(params.realm);
  if (params.service) url.searchParams.set('service', params.service);
  if (params.scope) url.searchParams.set('scope', params.scope);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const json = await res.json();
  return json.token || json.access_token || null;
}

async function getRegistryDigest({ registry, repo, tag }) {
  const url = `https://${registry}/v2/${repo}/manifests/${tag}`;
  const opts = (auth) => ({
    method: 'GET',
    headers: { Accept: MANIFEST_ACCEPT, ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    signal: AbortSignal.timeout(8000),
  });
  let res = await fetch(url, opts());
  if (res.status === 401) {
    const token = await fetchRegistryToken(res.headers.get('www-authenticate'));
    if (token) res = await fetch(url, opts(token));
  }
  if (!res.ok) return null;
  return res.headers.get('docker-content-digest');
}

async function getLocalDigest(imageRef) {
  const info = await docker.getImage(imageRef).inspect();
  const digests = info.RepoDigests || [];
  if (!digests.length) return null;
  const entry = digests.find((d) => d.includes('@')) || digests[0];
  return entry.split('@')[1] || null;
}

async function scanUpdates() {
  if (scanningUpdates) return;
  scanningUpdates = true;
  try {
    const containers = await docker.listContainers({ all: true });
    const byImage = new Map(); // imageRef -> [containerId]
    for (const c of containers) {
      const ref = c.Image;
      if (!ref || ref.startsWith('sha256:')) continue;
      if (!byImage.has(ref)) byImage.set(ref, []);
      byImage.get(ref).push(c.Id);
    }
    const result = {};
    await Promise.all([...byImage.entries()].map(async ([ref, ids]) => {
      try {
        const local = await getLocalDigest(ref);
        if (!local) return;
        const remote = await getRegistryDigest(parseImageRef(ref));
        if (!remote) return;
        if (remote !== local) for (const id of ids) result[id] = true;
      } catch { /* per-image failure is non-fatal */ }
    }));
    updatesByContainer = result;
    lastUpdateScan = Date.now();
  } catch { /* ignore */ } finally {
    scanningUpdates = false;
  }
}

const UPDATE_TTL_MS = 30 * 60 * 1000;

app.get('/api/updates', (req, res) => {
  if (Date.now() - lastUpdateScan > UPDATE_TTL_MS) scanUpdates(); // refresh in background
  res.json({ updates: updatesByContainer, checkedAt: lastUpdateScan });
});

// Guess a log level from a raw line so the UI can colour-code it.
function detectLevel(line, stream) {
  const l = line.toLowerCase();
  if (/\b(error|err|fatal|panic|exception|critical|fail(ed|ure)?)\b/.test(l)) return 'error';
  if (/\b(warn|warning)\b/.test(l)) return 'warn';
  if (/\b(debug|trace)\b/.test(l)) return 'debug';
  if (/\b(info|notice)\b/.test(l)) return 'info';
  if (stream === 'stderr') return 'error';
  return 'log';
}

// Docker log lines (with timestamps:true) start with an RFC3339Nano timestamp.
function splitTimestamp(line) {
  const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?(?:[+-]\d{2}:\d{2})?)\s(.*)$/s);
  if (m) return { ts: m[1], text: m[2] };
  return { ts: null, text: line };
}

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/ws/logs') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', async (ws, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;
  // Accept either a single `id` or a comma-separated `ids` list (a whole stack).
  const idsParam = params.get('ids') || params.get('id') || '';
  const ids = idsParam.split(',').map((s) => s.trim()).filter(Boolean);
  const tail = parseInt(params.get('tail') || '200', 10);

  if (ids.length === 0) {
    ws.send(JSON.stringify({ type: 'error', message: 'missing container id(s)' }));
    ws.close();
    return;
  }

  let lineSeq = 0;
  const streams = [];

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  // Build a line handler that tags each line with its source container.
  const handleLine = (containerName, stream) => (line) => {
    if (line === '') return;
    const { ts, text } = splitTimestamp(line);
    send({
      type: 'log',
      seq: lineSeq++,
      container: containerName,
      stream,
      ts,
      level: detectLevel(text, stream),
      text,
    });
  };

  // Attach a follow-stream for one container.
  const followContainer = async (id) => {
    const container = docker.getContainer(id);
    const info = await container.inspect();
    const name = (info.Name || id).replace(/^\//, '');

    const logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      // Spread the tail budget across containers when following several at once.
      tail: Math.max(20, Math.floor((Number.isFinite(tail) ? tail : 200) / ids.length)),
      timestamps: true,
    });
    streams.push(logStream);

    if (info.Config.Tty) {
      // TTY containers produce a raw (non-multiplexed) stream.
      readline.createInterface({ input: logStream }).on('line', handleLine(name, 'stdout'));
    } else {
      // Non-TTY streams are multiplexed; demux into stdout/stderr.
      const out = new PassThrough();
      const err = new PassThrough();
      container.modem.demuxStream(logStream, out, err);
      readline.createInterface({ input: out }).on('line', handleLine(name, 'stdout'));
      readline.createInterface({ input: err }).on('line', handleLine(name, 'stderr'));
    }

    logStream.on('error', (e) => send({ type: 'error', message: `${name}: ${e.message}` }));
  };

  send({ type: 'meta', count: ids.length });

  // Start all follows; report individual failures without killing the socket.
  const results = await Promise.allSettled(ids.map(followContainer));
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === ids.length) {
    send({ type: 'error', message: failed[0].reason?.message || 'failed to attach logs' });
    ws.close();
    return;
  }

  ws.on('close', () => {
    for (const s of streams) {
      if (s && typeof s.destroy === 'function') s.destroy();
    }
  });
});

server.listen(PORT, () => {
  console.log(`CargoClue listening on http://0.0.0.0:${PORT} (docker socket: ${SOCKET})`);
  scanUpdates(); // warm the image-update cache in the background
});
