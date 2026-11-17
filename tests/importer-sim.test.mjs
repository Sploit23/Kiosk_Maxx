import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyPhoto, freePort, getJson, isWindows, makeLotHash, postJson, readBatch, readMarker, rmrf, root,
  sleep, spawnImporter, startFakePeer, tempDir, waitFor, waitJson, writeBatch,
} from './helpers/importerHarness.mjs';

const skip = !isWindows;
const timeout = 60000;

function batchDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .filter((name) => fs.statSync(path.join(root, name)).isDirectory())
    .sort();
}

function hasMarker(root, name) {
  return fs.existsSync(path.join(root, name, '.natal_done'));
}

async function startImporter(t, options) {
  const port = await freePort();
  const importer = await spawnImporter({ ...options, port });
  t.after(() => importer.stop());
  await waitJson(importer.base, '/api/status', (status) => status && status.ok, {
    message: 'importador nao iniciou',
    timeout: 20000,
  });
  return importer;
}

test('cartao copia fotos, ignora video e nao repete arquivos ja importados', { skip, timeout }, async (t) => {
  const work = tempDir('importer-card');
  t.after(() => rmrf(work));
  const peer = await startFakePeer([]);
  t.after(() => peer.close());
  const dest = path.join(work, 'recebidas');
  const card = path.join(work, 'cartao Ã§');
  const dcim = path.join(card, 'DCIM', '100CANON');
  copyPhoto(dcim, 'IMG_0001.JPG', 'jpg');
  copyPhoto(dcim, 'IMG_0002.PNG', 'png');
  fs.copyFileSync(path.join(dcim, 'IMG_0001.JPG'), path.join(dcim, 'IMG_0003.CR2'));
  fs.copyFileSync(path.join(dcim, 'IMG_0001.JPG'), path.join(dcim, 'VID_0001.MP4'));
  const config = { auto_import: false, include_videos: false, sync_interval: 1, camera_auto_capture: false };

  const first = await startImporter(t, {
    rootDir: dest, config, peerPort: peer.port, importPath: card,
    configPath: path.join(work, 'config-1.json'),
  });
  const firstStatus = await waitJson(first.base, '/api/status', (status) => status.card.state === 'finished', {
    message: 'primeira importacao do cartao nao terminou',
  });
  assert.ok(firstStatus.card.batch);
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001']);
  const firstBatch = path.join(dest, 'NATAL-S0001');
  assert.deepEqual(
    fs.readdirSync(firstBatch).filter((name) => !name.startsWith('.')).sort(),
    ['IMG_0001.JPG', 'IMG_0002.PNG', 'IMG_0003.CR2'],
  );
  const firstMarker = readMarker(firstBatch);
  assert.equal(firstMarker.count, 3);
  assert.equal(Object.keys(firstMarker.files).length, 3);
  assert.ok(!firstMarker.files['VID_0001.MP4']);
  assert.equal(fs.readdirSync(dest).filter((name) => name.startsWith('.tmp_importando_')).length, 0);

  const novo = copyPhoto(dcim, 'IMG_0004.JPG', 'jpg');
  fs.appendFileSync(novo, Buffer.from('conteudo-novo-para-nao-deduplicar'));
  const second = await startImporter(t, {
    rootDir: dest, config, peerPort: peer.port, importPath: card,
    configPath: path.join(work, 'config-2.json'),
  });
  await waitJson(second.base, '/api/status', (status) => status.card.state === 'finished', {
    message: 'segunda importacao do cartao nao terminou',
  });
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001', 'NATAL-S0002']);
  assert.equal(readMarker(path.join(dest, 'NATAL-S0002')).count, 1);

  const third = await startImporter(t, {
    rootDir: dest, config, peerPort: peer.port, importPath: card,
    configPath: path.join(work, 'config-3.json'),
  });
  await waitJson(third.base, '/api/status', (status) => status.card.state === 'all_imported', {
    message: 'cartao ja importado nao foi reconhecido',
  });
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001', 'NATAL-S0002']);
});

test('peer nao cria lotes aninhados nem baixa o mesmo conteudo duas vezes', { skip, timeout: 90000 }, async (t) => {
  const work = tempDir('peer-dedupe');
  t.after(() => rmrf(work));
  const dest = path.join(work, 'recebidas');
  fs.mkdirSync(dest, { recursive: true });

  writeBatch(dest, 'NATAL-S0001', [
    { name: 'local.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'PC A');
  const local = readBatch(path.join(dest, 'NATAL-S0001'));

  const remoteBDir = path.join(work, 'remote-b');
  copyPhoto(remoteBDir, 'remoto-b.jpg', 'png');
  fs.appendFileSync(path.join(remoteBDir, 'remoto-b.jpg'), Buffer.from('conteudo-B'));
  const remoteB = readBatch(remoteBDir, 'NATAL-S0001');

  const remoteCDir = path.join(work, 'remote-c');
  copyPhoto(remoteCDir, 'remoto-c.jpg', 'jpg');
  fs.appendFileSync(path.join(remoteCDir, 'remoto-c.jpg'), Buffer.from('conteudo-C'));
  const remoteC = readBatch(remoteCDir, 'NATAL-S0001');

  const peer = await startFakePeer([{ name: 'NATAL-S0001', files: remoteB.files, source: 'PC B' }]);
  t.after(() => peer.close());

  const importer = await startImporter(t, {
    rootDir: dest,
    peerPort: peer.port,
    config: { auto_download: true, sync_interval: 1, auto_import: false },
    configPath: path.join(work, 'config-peer.json'),
  });

  const hashB = makeLotHash(remoteB.files).slice(0, 6);
  const altB = `NATAL-S0001-${hashB}`;
  await waitFor(() => batchDirs(dest).length === 2, 'peer nao baixou o lote B', 30000);
  assert.deepEqual(batchDirs(dest).sort(), ['NATAL-S0001', altB].sort());
  assert.equal(readBatch(path.join(dest, altB)).files.length, remoteB.files.length);
  assert.equal(fs.readdirSync(dest).filter((name) => name.startsWith(altB + '-')).length, 0);

  peer.setBatches([
    { name: 'NATAL-S0001', files: remoteB.files, source: 'PC B' },
    { name: altB, files: remoteC.files, source: 'PC B' },
  ]);
  const hashC = makeLotHash(remoteC.files).slice(0, 6);
  const altC = `NATAL-S0001-${hashC}`;
  await waitFor(() => batchDirs(dest).length === 3, 'peer nao baixou o lote C', 30000);
  assert.deepEqual(batchDirs(dest).sort(), ['NATAL-S0001', altB, altC].sort());
  assert.equal(fs.readdirSync(dest).filter((name) => name.startsWith(altB + '-')).length, 0);

  const count = batchDirs(dest).length;
  await sleep(3500);
  assert.equal(batchDirs(dest).length, count, 'peer duplicou um conteudo ja existente');
  assert.equal(readBatch(path.join(dest, 'NATAL-S0001')).files.length, local.files.length);
});

test('camera falsa importa, marca indice e segunda captura fica vazia', { skip, timeout }, async (t) => {
  const work = tempDir('importer-camera');
  t.after(() => rmrf(work));
  const peer = await startFakePeer([]);
  t.after(() => peer.close());
  const source = path.join(work, 'camera-source');
  copyPhoto(source, 'IMG_1001.JPG', 'jpg');
  copyPhoto(source, 'IMG_1002.PNG', 'png');
  const dest = path.join(work, 'recebidas');

  const importer = await startImporter(t, {
    rootDir: dest,
    peerPort: peer.port,
    fakeCamera: true,
    config: { auto_import: false, sync_interval: 1, camera_auto_capture: false },
    configPath: path.join(work, 'config.json'),
    env: {
      NATAL_FAKE_CAMERA_DEVICES: JSON.stringify([{ name: 'Canon EOS REBEL T5' }]),
      NATAL_FAKE_CAMERA_SOURCE: source,
      NATAL_FAKE_CAMERA_NAME: 'Canon EOS REBEL T5',
    },
  });

  const scan = await postJson(importer.base, '/api/camera/scan');
  assert.equal(scan.status, 200);
  assert.equal(scan.json.ok, true);
  assert.equal(scan.json.connected, true);
  assert.equal(scan.json.newCount, 2);
  assert.equal(scan.json.name, 'Canon EOS REBEL T5');

  const capture = await postJson(importer.base, '/api/camera/capture');
  assert.equal(capture.status, 200);
  assert.equal(capture.json.ok, true);
  const done = await waitJson(importer.base, '/api/status', (status) => (
    status.camera.capturing === false && status.card.state === 'finished'
  ), { message: 'captura da camera nao terminou' });
  assert.equal(done.camera.lastCount, 2);
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001']);
  const marker = readMarker(path.join(dest, 'NATAL-S0001'));
  assert.equal(marker.count, 2);
  const index = JSON.parse(fs.readFileSync(path.join(dest, '.natal_camera_index.json'), 'utf8'));
  assert.equal(index.keys.length, 2);
  assert.equal(fs.readdirSync(dest).filter((name) => name.startsWith('.tmp_importando_camera_')).length, 0);

  const empty = await postJson(importer.base, '/api/camera/capture');
  assert.equal(empty.status, 200);
  await waitJson(importer.base, '/api/status', (status) => (
    status.camera.capturing === false && status.card.state === 'camera_empty'
  ), { message: 'segunda captura nao ficou vazia' });
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001']);

  const settings = await postJson(importer.base, '/api/camera/settings', { autoCapture: true });
  assert.equal(settings.status, 200);
  assert.equal(settings.json.settings.autoCapture, true);
  const saved = await getJson(importer.base, '/api/camera/settings');
  assert.equal(saved.settings.autoCapture, true);
});

test('camera falsa cobre sem camera, erro de leitura e erro de captura', { skip, timeout }, async (t) => {
  const work = tempDir('importer-camera-errors');
  t.after(() => rmrf(work));
  const peer = await startFakePeer([]);
  t.after(() => peer.close());

  const noCamera = await startImporter(t, {
    rootDir: path.join(work, 'sem-camera'),
    peerPort: peer.port,
    fakeCamera: true,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config-no-camera.json'),
    env: { NATAL_FAKE_CAMERA_DEVICES: '[]' },
  });
  const missing = await postJson(noCamera.base, '/api/camera/capture');
  assert.equal(missing.status, 409);
  assert.equal(missing.json.error, 'no_camera');

  const scanErrorDir = path.join(work, 'scan-error');
  const scanError = await startImporter(t, {
    rootDir: scanErrorDir,
    peerPort: peer.port,
    fakeCamera: true,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config-scan-error.json'),
    env: {
      NATAL_FAKE_CAMERA_DEVICES: JSON.stringify([{ name: 'Canon EOS REBEL T5' }]),
      NATAL_FAKE_CAMERA_ERROR: 'scan',
    },
  });
  const scanFailed = await postJson(scanError.base, '/api/camera/scan');
  assert.equal(scanFailed.status, 200);
  assert.equal(scanFailed.json.ok, false);
  assert.match(scanFailed.json.error, /fake camera scan failure/);

  const captureErrorDir = path.join(work, 'capture-error');
  const source = path.join(work, 'camera-source');
  copyPhoto(source, 'IMG_2001.JPG', 'jpg');
  const captureError = await startImporter(t, {
    rootDir: captureErrorDir,
    peerPort: peer.port,
    fakeCamera: true,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config-capture-error.json'),
    env: {
      NATAL_FAKE_CAMERA_DEVICES: JSON.stringify([{ name: 'Canon EOS REBEL T5' }]),
      NATAL_FAKE_CAMERA_SOURCE: source,
      NATAL_FAKE_CAMERA_ERROR: 'capture',
    },
  });
  const okScan = await postJson(captureError.base, '/api/camera/scan');
  assert.equal(okScan.json.newCount, 1);
  const failedCapture = await postJson(captureError.base, '/api/camera/capture');
  assert.equal(failedCapture.status, 200);
  const failed = await waitJson(captureError.base, '/api/status', (status) => status.card.state === 'camera_error', {
    message: 'erro de captura nao apareceu',
  });
  assert.match(failed.camera.lastError, /fake camera capture failure/);
  assert.deepEqual(batchDirs(captureErrorDir), []);
});

test('peer baixa lotes novos e opcionalmente evita duplicatas por conteudo', { skip, timeout }, async (t) => {
  const work = tempDir('importer-peer');
  t.after(() => rmrf(work));
  const peerRoot = path.join(work, 'peer');
  writeBatch(peerRoot, 'NATAL-S0001', [
    { name: 'A.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
    { name: 'B.png', src: path.join(root, 'public', 'icons', 'pdv-512.png') },
  ], 'PC origem');
  writeBatch(peerRoot, 'NATAL-S0002', [
    { name: 'C.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'PC origem');
  const peer = await startFakePeer([
    readBatch(path.join(peerRoot, 'NATAL-S0001')),
    readBatch(path.join(peerRoot, 'NATAL-S0002')),
  ]);
  t.after(() => peer.close());
  const dest = path.join(work, 'destino');

  const importer = await startImporter(t, {
    rootDir: dest, peerPort: peer.port,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config.json'),
  });

  await waitFor(() => hasMarker(dest, 'NATAL-S0001') && hasMarker(dest, 'NATAL-S0002'), 'peer nao baixou os dois lotes');
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001', 'NATAL-S0002']);
  assert.equal(readMarker(path.join(dest, 'NATAL-S0001')).source, 'PC origem');
  assert.deepEqual(
    fs.readdirSync(path.join(dest, 'NATAL-S0001')).filter((name) => !name.startsWith('.')).sort(),
    ['A.jpg', 'B.png'],
  );
  const status = await waitJson(importer.base, '/api/status', (value) => value.peer.batches.length === 2, {
    message: 'status do peer nao listou os lotes',
  });
  assert.equal(status.peer.found, true);
});

test('peer preserva lote local em conflito e baixa com sufixo', { skip, timeout }, async (t) => {
  const work = tempDir('importer-peer-conflict');
  t.after(() => rmrf(work));
  const dest = path.join(work, 'destino');
  const local = writeBatch(dest, 'NATAL-S0001', [
    { name: 'local.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'local');
  const localHash = readMarker(local).hash;
  const peerRoot = path.join(work, 'peer');
  writeBatch(peerRoot, 'NATAL-S0001', [
    { name: 'remoto.png', src: path.join(root, 'public', 'icons', 'pdv-512.png') },
  ], 'remoto');
  const remote = readBatch(path.join(peerRoot, 'NATAL-S0001'));
  const peer = await startFakePeer([remote]);
  t.after(() => peer.close());

  await startImporter(t, {
    rootDir: dest, peerPort: peer.port,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config.json'),
  });
  const altName = `NATAL-S0001-${makeLotHash(remote.files).slice(0, 6)}`;
  await waitFor(() => hasMarker(dest, altName), 'lote em conflito nao foi baixado com sufixo');
  assert.equal(readMarker(local).hash, localHash);
  assert.equal(readMarker(path.join(dest, altName)).hash, makeLotHash(remote.files));
  assert.ok(!fs.existsSync(path.join(dest, 'NATAL-S0001', 'remoto.png')));
});

test('peer nao baixa de novo o mesmo conteudo com outro nome', { skip, timeout }, async (t) => {
  const work = tempDir('importer-peer-duplicate');
  t.after(() => rmrf(work));
  const dest = path.join(work, 'destino');
  writeBatch(dest, 'NATAL-S0001', [
    { name: 'igual.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'local');
  const peerRoot = path.join(work, 'peer');
  writeBatch(peerRoot, 'NATAL-S0009', [
    { name: 'igual.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'remoto');
  const peer = await startFakePeer([readBatch(path.join(peerRoot, 'NATAL-S0009'))]);
  t.after(() => peer.close());

  const importer = await startImporter(t, {
    rootDir: dest, peerPort: peer.port,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config.json'),
  });
  await waitJson(importer.base, '/api/status', (status) => status.peer.batches.length === 1, {
    message: 'peer nao listou o lote duplicado',
  });
  await sleep(2500);
  assert.deepEqual(batchDirs(dest), ['NATAL-S0001']);
  assert.ok(peer.hits.includes('/api/batches'));
});

test('peer so grava marcador depois de completar arquivo truncado', { skip, timeout }, async (t) => {
  const work = tempDir('importer-peer-retry');
  t.after(() => rmrf(work));
  const dest = path.join(work, 'destino');
  const peerRoot = path.join(work, 'peer');
  writeBatch(peerRoot, 'NATAL-S0001', [
    { name: 'retry.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
  ], 'remoto');
  const peer = await startFakePeer([readBatch(path.join(peerRoot, 'NATAL-S0001'))]);
  t.after(() => peer.close());
  peer.truncate('NATAL-S0001/retry.jpg', true);

  const importer = await startImporter(t, {
    rootDir: dest, peerPort: peer.port,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'config.json'),
  });
  const failed = await waitJson(importer.base, '/api/status', (status) => /faltaram/.test(status.peer.error || ''), {
    message: 'falha de download truncado nao foi reportada',
    timeout: 30000,
  });
  assert.match(failed.peer.error, /faltaram/);
  assert.equal(hasMarker(dest, 'NATAL-S0001'), false);

  peer.truncate('NATAL-S0001/retry.jpg', false);
  await waitFor(() => hasMarker(dest, 'NATAL-S0001'), 'lote nao completou depois do retry', 30000);
  const marker = readMarker(path.join(dest, 'NATAL-S0001'));
  assert.equal(marker.count, 1);
  assert.equal(marker.files['retry.jpg'], readBatch(path.join(peerRoot, 'NATAL-S0001')).files[0].hash);
});


