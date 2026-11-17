import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const isWindows = process.platform === 'win32';
export const pythonExe = process.env.PYTHON || process.env.PYTHON_EXE || 'python';
export const importerScript = path.join(root, 'tools', 'pegar-fotos', 'app.py');
export const fakeCameraScript = path.join(root, 'tests', 'fixtures', 'importer', 'fake_camera_importer.py');

const photoFixtures = {
  jpg: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg'),
  png: path.join(root, 'public', 'icons', 'pdv-512.png'),
};

export function tempDir(prefix = 'natal-test') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

export function rmrf(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {}
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(check, message = 'timeout', timeout = 20000, interval = 150) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  const suffix = lastError ? ` (${lastError.message})` : '';
  throw new Error(`${message}${suffix}`);
}

export async function getJson(base, route, timeout = 3000) {
  const response = await fetch(base + route, { signal: AbortSignal.timeout(timeout) });
  return await response.json();
}

export async function postJson(base, route, body = {}, timeout = 10000) {
  const response = await fetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  return { status: response.status, json: await response.json().catch(() => null) };
}

export async function waitJson(base, route, predicate, options = {}) {
  return await waitFor(async () => {
    const data = await getJson(base, route, options.requestTimeout || 3000);
    return predicate(data) ? data : null;
  }, options.message || `timeout esperando ${route}`, options.timeout || 20000, options.interval || 150);
}

export function copyPhoto(destDir, name, kind = 'jpg') {
  const source = photoFixtures[kind] || photoFixtures.jpg;
  fs.mkdirSync(destDir, { recursive: true });
  const target = path.join(destDir, name);
  fs.copyFileSync(source, target);
  return target;
}

export function shortFileHash(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16);
}

export function makeLotHash(files) {
  const joined = files
    .map((file) => `${String(file.name).toLowerCase()}:${file.hash}`)
    .sort()
    .join('|');
  return crypto.createHash('sha1').update(joined).digest('hex').slice(0, 10).toLowerCase();
}

function parseSeq(name) {
  const match = String(name || '').match(/-S(\d+)$/i);
  return match ? Number(match[1]) : 0;
}

export function writeBatch(destRoot, name, entries, source = 'teste') {
  const dir = path.join(destRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const files = {};
  let size = 0;
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.src) fs.copyFileSync(entry.src, target);
    else fs.writeFileSync(target, entry.data);
    const buffer = fs.readFileSync(target);
    files[entry.name] = shortFileHash(buffer);
    size += buffer.length;
  }
  fs.writeFileSync(path.join(dir, '.natal_done'), JSON.stringify({
    count: entries.length,
    size,
    source,
    hash: makeLotHash(Object.entries(files).map(([file, hash]) => ({ name: file, hash }))),
    seq: parseSeq(name),
    files,
  }));
  return dir;
}

export function readBatch(dir, name = path.basename(dir)) {
  const files = fs.readdirSync(dir)
    .filter((file) => !file.startsWith('.'))
    .filter((file) => fs.statSync(path.join(dir, file)).isFile())
    .map((file) => {
      const data = fs.readFileSync(path.join(dir, file));
      return { name: file, data, size: data.length, hash: shortFileHash(data) };
    });
  let source = 'PC teste';
  try {
    source = JSON.parse(fs.readFileSync(path.join(dir, '.natal_done'), 'utf8')).source || source;
  } catch {}
  return { name, source, files };
}

export function readMarker(batchDir) {
  return JSON.parse(fs.readFileSync(path.join(batchDir, '.natal_done'), 'utf8'));
}

export async function startFakePeer(batches = []) {
  const state = { batches, failures: new Map(), truncate: new Set(), hits: [] };
  const summaries = () => state.batches.map((batch) => {
    const total = batch.files.reduce((sum, file) => sum + file.size, 0);
    const remoteHash = makeLotHash(batch.files);
    return {
      name: batch.name,
      count: batch.files.length,
      size: total,
      date: '01/01/2026 00:00',
      source: batch.source || 'PC teste',
      hash: remoteHash,
      seq: parseSeq(batch.name),
      done: true,
    };
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    state.hits.push(url.pathname);
    if (url.pathname === '/api/batches') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(summaries()));
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'batches' && parts[3] === 'files') {
      const batch = state.batches.find((item) => item.name === parts[2]);
      if (!batch) {
        res.statusCode = 404;
        res.end('{}');
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(batch.files.map((file) => ({
        name: file.name, size: file.size, hash: file.hash,
      }))));
      return;
    }
    if (parts[0] === 'files' && parts.length >= 3) {
      const batch = state.batches.find((item) => item.name === parts[1]);
      const file = batch && batch.files.find((item) => item.name === parts.slice(2).join('/'));
      if (!file) {
        res.statusCode = 404;
        res.end();
        return;
      }
      const key = `${batch.name}/${file.name}`;
      const remaining = state.failures.get(key) || 0;
      if (remaining > 0) {
        state.failures.set(key, remaining - 1);
        res.statusCode = 500;
        res.end('falha simulada');
        return;
      }
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(file.data.length));
      if (state.truncate.has(key)) res.end(file.data.subarray(0, Math.max(1, Math.floor(file.data.length / 2))));
      else res.end(file.data);
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    url: `http://127.0.0.1:${server.address().port}`,
    hits: state.hits,
    setBatches(next) { state.batches = next; },
    fail(key, count = 1) { state.failures.set(key, count); },
    truncate(key, value = true) {
      if (value) state.truncate.add(key);
      else state.truncate.delete(key);
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function createConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config || {}, null, 2));
}

export async function spawnImporter(options) {
  const port = options.port;
  const configPath = options.configPath || path.join(path.dirname(options.rootDir), 'importador-config.json');
  createConfig(configPath, options.config || {});
  fs.mkdirSync(options.rootDir, { recursive: true });
  const script = options.fakeCamera ? fakeCameraScript : importerScript;
  const logPath = options.logPath || path.join(options.rootDir, 'importador.log');
  const args = [
    script,
    '--headless',
    '--allow-multiple',
    '--no-firewall',
    '--no-notify',
    '--port', String(port),
    '--root', options.rootDir,
    '--config', configPath,
    '--log', logPath,
  ];
  if (options.peerPort) args.push('--peer', `127.0.0.1:${options.peerPort}`);
  if (options.importPath) args.push('--import', options.importPath);
  const child = spawn(pythonExe, args, {
    cwd: root,
    windowsHide: true,
    env: { ...process.env, PYTHONUNBUFFERED: '1', ...(options.env || {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  async function stop() {
    if (child.exitCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
        resolve();
      }, 2000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    await Promise.race([exited, sleep(2000)]);
  }
  return {
    child,
    port,
    base: `http://127.0.0.1:${port}`,
    rootDir: options.rootDir,
    logPath,
    configPath,
    stop,
    output: () => ({ stdout, stderr }),
  };
}

export async function spawnSidecar(options) {
  const env = {
    ...process.env,
    NATAL_HOST: '127.0.0.1',
    NATAL_PORT: String(options.port),
    NATAL_PHOTOS_FOLDER: options.photosFolder,
    NATAL_DATA_DIR: options.legacyDir || path.join(options.photosFolder, 'legacy'),
    NATAL_IMPORTER_PORT: String(options.importerPort),
    ...(options.env || {}),
  };
  if (options.webDir) env.NATAL_WEB_DIR = options.webDir;
  const child = spawn(process.execPath, [path.join(root, 'sidecar', 'natal-core.cjs')], {
    cwd: root,
    windowsHide: true,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => { stdout += data.toString(); });
  child.stderr.on('data', (data) => { stderr += data.toString(); });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  async function stop() {
    if (child.exitCode !== null) return;
    try { child.stdin.end(); } catch {}
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
    await Promise.race([exited, sleep(2000)]);
  }
  return {
    child,
    port: options.port,
    base: `http://127.0.0.1:${options.port}`,
    stop,
    output: () => ({ stdout, stderr }),
  };
}
