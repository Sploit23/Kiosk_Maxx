import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyPhoto, freePort, getJson, isWindows, postJson, root, spawnImporter, spawnSidecar,
  startFakePeer, tempDir, waitJson, writeBatch, rmrf,
} from './helpers/importerHarness.mjs';

const skip = !isWindows;
const timeout = 90000;

test('sidecar enxerga o importador na porta configurada e cria sessao do lote', { skip, timeout }, async (t) => {
  const work = tempDir('sidecar-importer');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'fotos');
  const importFolder = path.join(photosFolder, '_cartao');
  fs.mkdirSync(importFolder, { recursive: true });
  const peer = await startFakePeer([]);
  t.after(() => peer.close());

  const importerPort = await freePort();
  const importer = await spawnImporter({
    port: importerPort,
    rootDir: importFolder,
    peerPort: peer.port,
    config: { auto_import: false, sync_interval: 1 },
    configPath: path.join(work, 'importador-config.json'),
  });
  t.after(() => importer.stop());
  await waitJson(importer.base, '/api/status', (status) => status && status.ok, {
    message: 'importador nao iniciou para o teste do sidecar',
    timeout: 20000,
  });

  const sidecarPort = await freePort();
  const sidecar = await spawnSidecar({
    port: sidecarPort,
    photosFolder,
    importerPort,
    webDir: path.join(root, 'dist'),
  });
  t.after(() => sidecar.stop());
  await waitJson(sidecar.base, '/api/health', (health) => health && health.ok, {
    message: 'sidecar nao iniciou',
    timeout: 20000,
  });

  const importStatus = await waitJson(sidecar.base, '/api/import/status', (status) => (
    status.success && status.online
  ), { message: 'sidecar nao alcancou o importador', timeout: 20000 });
  assert.equal(path.resolve(importStatus.importFolder), path.resolve(importFolder));
  assert.ok(importStatus.importer);

  writeBatch(importFolder, 'NATAL-S0001', [
    { name: 'sessao-a.jpg', src: path.join(root, 'public', 'catalogos', 'catalogo-1-thumb.jpg') },
    { name: 'sessao-b.png', src: path.join(root, 'public', 'icons', 'pdv-512.png') },
  ], 'importador');

  const list = await waitJson(sidecar.base, '/api/sessoes', (data) => (
    data.success && data.sessoes.length === 1
      && data.sessoes[0].estado === 'PRONTA'
      && data.sessoes[0].fotosQtd === 2
  ), { message: 'sidecar nao finalizou a sessao do lote', timeout: 30000 });
  const sessao = list.sessoes[0];
  assert.equal(sessao.estado, 'PRONTA');
  assert.equal(sessao.fotosQtd, 2);
  assert.equal(sessao.importadaDe, 'NATAL-S0001');
  const originalsDir = path.join(photosFolder, 'natal-app', 'sessoes', sessao.id, 'originais');
  const previewsDir = path.join(photosFolder, 'natal-app', 'sessoes', sessao.id, 'previews');
  assert.equal(fs.readdirSync(originalsDir).length, 2);
  assert.equal(fs.readdirSync(previewsDir).length, 2);
  assert.ok(fs.statSync(path.join(originalsDir, fs.readdirSync(originalsDir)[0])).nlink >= 2);

  const resumo = await waitJson(sidecar.base, '/api/sessoes?resumo=1', (data) => (
    data.success && data.sessoes.some((s) => s.id === sessao.id && s.fotosQtd === 2)
  ), { message: 'resumo do painel nao contou as fotos importadas do cartao', timeout: 15000 });
  assert.equal(resumo.sessoes.find((s) => s.id === sessao.id).fotosQtd, 2);

  copyPhoto(importFolder, 'nao-deve-entrar.jpg', 'jpg');
  const sync = await postJson(sidecar.base, '/api/import/sincronizar');
  assert.equal(sync.status, 200);
  assert.equal(sync.json.success, true);

  sidecar.stop();
  fs.rmSync(path.join(photosFolder, 'natal-app', 'database', 'pasta-importadas.json'), { force: true });
  const sidecar2Port = await freePort();
  const sidecar2 = await spawnSidecar({
    port: sidecar2Port,
    photosFolder,
    importerPort,
    webDir: path.join(root, 'dist'),
  });
  t.after(() => sidecar2.stop());
  await waitJson(sidecar2.base, '/api/health', (health) => health && health.ok, {
    message: 'sidecar nao reiniciou',
    timeout: 20000,
  });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  const list2 = await getJson(sidecar2.base, '/api/sessoes');
  assert.equal(list2.sessoes.length, 1, 'registro perdido recriou a sessao');
});

test('lote com marcador aparece antes dos previews ficarem prontos', { skip, timeout: 90000 }, async (t) => {
  const work = tempDir('sidecar-preview-early');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'fotos');
  const importFolder = path.join(photosFolder, '_cartao');
  fs.mkdirSync(importFolder, { recursive: true });

  const port = await freePort();
  const sidecar = await spawnSidecar({
    port,
    photosFolder,
    importerPort: await freePort(),
    webDir: path.join(root, 'dist'),
  });
  t.after(() => sidecar.stop());
  await waitJson(sidecar.base, '/api/health', (health) => health && health.ok, {
    message: 'sidecar nao iniciou',
    timeout: 20000,
  });

  const foto = path.join(root, 'public', 'catalogos', 'catalogo-1.jpg');
  const t0 = Date.now();
  writeBatch(importFolder, 'NATAL-S9999', Array.from({ length: 24 }, (_, i) => ({
    name: `foto-${i}.jpg`,
    src: foto,
  })), 'teste');

  // O settle de 3s fazia a sessão só aparecer depois que todos os previews
  // ficavam prontos. Com o marcador, ela precisa aparecer em ~1s.
  const list = await waitJson(sidecar.base, '/api/sessoes', (data) => (
    data.success && data.sessoes.some((s) => s.importadaDe === 'NATAL-S9999')
  ), { message: 'sessao do lote nao apareceu', timeout: 15000, interval: 50 });
  const apareceuMs = Date.now() - t0;
  assert.ok(apareceuMs < 3000, `sessao demorou ${apareceuMs}ms para aparecer`);

  const pronta = await waitJson(sidecar.base, '/api/sessoes', (data) => (
    data.success && data.sessoes.some((s) => (
      s.importadaDe === 'NATAL-S9999' && s.estado === 'PRONTA' && s.fotosQtd === 24
    ))
  ), { message: 'sessao nao ficou pronta', timeout: 60000, interval: 200 });
  const sessao = pronta.sessoes.find((s) => s.importadaDe === 'NATAL-S9999');
  assert.ok(sessao);
  const previewsDir = path.join(photosFolder, 'natal-app', 'sessoes', sessao.id, 'previews');
  assert.equal(fs.readdirSync(previewsDir).length, 24);
});
