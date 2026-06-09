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
});
