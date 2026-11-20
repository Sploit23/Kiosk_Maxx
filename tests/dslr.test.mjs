import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  copyPhoto, freePort, getJson, isWindows, postJson, root, sleep, spawnSidecar,
  tempDir, waitJson, rmrf,
} from './helpers/importerHarness.mjs';

const skip = !isWindows;
const timeout = 90000;

async function startSidecarComDslr(t, work, dslrFolder) {
  const photosFolder = path.join(work, 'fotos');
  fs.mkdirSync(photosFolder, { recursive: true });
  // O modo agora é ligado pelo botão do PDV (grava dslrEnabled=true). Simula
  // isso no config da máquina; ter só a pasta configurada não liga o modo.
  const cfgDir = path.join(photosFolder, 'natal-app', 'database');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({
    photosFolder, dslrEnabled: true, dslrFolder,
  }, null, 2));
  const ports = { sidecar: await freePort(), importer: await freePort() };
  const sidecar = await spawnSidecar({
    port: ports.sidecar,
    photosFolder,
    importerPort: ports.importer,
    webDir: path.join(root, 'dist'),
    env: { NATAL_DSLR_FOLDER: dslrFolder },
  });
  t.after(() => sidecar.stop());
  await waitJson(sidecar.base, '/api/health', (h) => h && h.ok, {
    message: 'sidecar nao iniciou', timeout: 20000,
  });
  return { sidecar, photosFolder };
}

test('modo direto: status, fechar sessao, arquivar e limpar a pasta', { skip, timeout }, async (t) => {
  const work = tempDir('dslr-fechar');
  t.after(() => rmrf(work));
  const dslrFolder = path.join(work, 'Session1');
  const { sidecar, photosFolder } = await startSidecarComDslr(t, work, dslrFolder);

  const vazio = await getJson(sidecar.base, '/api/dslr/status');
  assert.equal(vazio.success, true);
  assert.equal(vazio.enabled, true);
  assert.equal(vazio.exists, false);
  assert.equal(vazio.total, 0);

  const semFotos = await postJson(sidecar.base, '/api/dslr/fechar');
  assert.equal(semFotos.status, 409);
  assert.equal(semFotos.json.error, 'SEM_FOTOS');

  fs.mkdirSync(dslrFolder, { recursive: true });
  const primeira = copyPhoto(dslrFolder, 'IMG_0001.jpg');
  const segunda = copyPhoto(dslrFolder, 'IMG_0002.jpg');
  // Ordem do disparo = mtime: fixa explicitamente para nao depender do relogio
  // do sistema de arquivos (FAT/NTFS arredondam de forma diferente).
  const t0 = new Date(Date.now() - 60000);
  fs.utimesSync(primeira, t0, t0);
  fs.utimesSync(segunda, new Date(t0.getTime() + 1000), new Date(t0.getTime() + 1000));

  const recebendo = await waitJson(sidecar.base, '/api/dslr/status', (s) => s.total === 2, {
    message: 'sidecar nao viu as fotos da camera', timeout: 15000,
  });
  assert.equal(recebendo.pending, 2);

  const pronto = await waitJson(sidecar.base, '/api/dslr/status', (s) => s.count === 2 && s.pending === 0, {
    message: 'fotos nao estabilizaram', timeout: 15000,
  });
  // online depende de o CameraControl estar rodando nesta máquina (o teste não
  // controla o processo); o que importa aqui é o contador/pasta.
  assert.equal(typeof pronto.online, 'boolean');
  assert.equal(pronto.folder, dslrFolder);

  const fechou = await postJson(sidecar.base, '/api/dslr/fechar');
  assert.equal(fechou.status, 200);
  assert.equal(fechou.json.success, true);
  assert.equal(fechou.json.count, 2);
  assert.equal(fechou.json.arquivadas, 2);
  assert.ok(fechou.json.sessaoId.startsWith('NATAL-'));
  assert.equal(fs.readdirSync(dslrFolder).length, 0);

  const backup = fechou.json.backup;
  assert.ok(backup && fs.existsSync(backup));
  assert.deepEqual(fs.readdirSync(backup).sort(), ['IMG_0001.jpg', 'IMG_0002.jpg']);

  const sessaoDir = path.join(photosFolder, 'natal-app', 'sessoes', fechou.json.sessaoId);
  const originais = fs.readdirSync(path.join(sessaoDir, 'originais')).sort();
  assert.deepEqual(originais, ['f0001_IMG_0001.jpg', 'f0002_IMG_0002.jpg']);

  // "Fechar sessão" não pode esperar a geração dos previews: a sessão já volta
  // PRONTA (preview = cópia do original) e a versão leve vem em background.
  const imediata = await getJson(sidecar.base, `/api/sessoes/${fechou.json.sessaoId}`);
  assert.equal(imediata.sessao.estado, 'PRONTA');
  assert.equal(imediata.sessao.fotosQtd, 2);
  const previews = fs.readdirSync(path.join(sessaoDir, 'previews')).sort();
  assert.deepEqual(previews, ['f0001_IMG_0001.jpg', 'f0002_IMG_0002.jpg']);

  const sessao = await waitJson(sidecar.base, `/api/sessoes/${fechou.json.sessaoId}`, (s) => (
    s.success && s.sessao && s.sessao.estado === 'PRONTA' && s.sessao.fotosQtd === 2
  ), { message: 'sessao da camera nao ficou PRONTA', timeout: 30000 });
  assert.equal(sessao.sessao.importadaDe, 'dslr');
  assert.equal(sessao.sessao.origem, 'dslr');

  // O background ainda gera as miniaturas leves (a lista já usa o preview).
  const thumbsDir = path.join(sessaoDir, 'thumbs');
  for (let i = 0; i < 60 && fs.readdirSync(thumbsDir).length < 2; i++) await sleep(250);
  assert.equal(fs.readdirSync(thumbsDir).length, 2);

  const depois = await getJson(sidecar.base, '/api/dslr/status');
  assert.equal(depois.total, 0);
});

test('modo direto: descartar fotos nao cria sessao', { skip, timeout }, async (t) => {
  const work = tempDir('dslr-descartar');
  t.after(() => rmrf(work));
  const dslrFolder = path.join(work, 'Session1');
  fs.mkdirSync(dslrFolder, { recursive: true });
  const { sidecar, photosFolder } = await startSidecarComDslr(t, work, dslrFolder);

  copyPhoto(dslrFolder, 'IMG_0100.jpg');
  await waitJson(sidecar.base, '/api/dslr/status', (s) => s.count === 1, {
    message: 'digital nao apareceu', timeout: 15000,
  });

  const r = await postJson(sidecar.base, '/api/dslr/descartar');
  assert.equal(r.status, 200);
  assert.equal(r.json.success, true);
  assert.equal(r.json.descartadas, 1);
  assert.equal(fs.readdirSync(dslrFolder).length, 0);
  assert.ok(fs.existsSync(path.join(photosFolder, 'natal-app', 'dslr-descartadas')));

  const lista = await getJson(sidecar.base, '/api/sessoes');
  assert.equal(lista.sessoes.length, 0);
});

test('modo direto: pasta dentro de photosFolder nao vira sessao pelo watcher', { skip, timeout }, async (t) => {
  const work = tempDir('dslr-watcher');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'fotos');
  const dslrFolder = path.join(photosFolder, '_camera');
  fs.mkdirSync(dslrFolder, { recursive: true });
  const { sidecar } = await startSidecarComDslr(t, work, dslrFolder);

  copyPhoto(dslrFolder, 'IMG_0200.jpg');
  await waitJson(sidecar.base, '/api/dslr/status', (s) => s.count === 1, {
    message: 'digital nao apareceu', timeout: 15000,
  });
  // O watcher da drop zone roda a cada 900ms com settle de 3s: espera passar
  // duas janelas para garantir que a pasta reservada nao gerou sessao.
  await sleep(5000);
  const lista = await getJson(sidecar.base, '/api/sessoes');
  assert.equal(lista.sessoes.length, 0);

  const fechou = await postJson(sidecar.base, '/api/dslr/fechar');
  assert.equal(fechou.json.success, true);
  assert.equal(fechou.json.count, 1);
});

test('modo direto: desligado nao expoe status como habilitado', { skip, timeout }, async (t) => {
  const work = tempDir('dslr-off');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'fotos');
  fs.mkdirSync(photosFolder, { recursive: true });
  const port = await freePort();
  const importerPort = await freePort();
  const sidecar = await spawnSidecar({
    port, photosFolder, importerPort, webDir: path.join(root, 'dist'),
  });
  t.after(() => sidecar.stop());
  await waitJson(sidecar.base, '/api/health', (h) => h && h.ok, { message: 'sidecar nao iniciou', timeout: 20000 });

  const status = await getJson(sidecar.base, '/api/dslr/status');
  assert.equal(status.success, true);
  assert.equal(status.enabled, false);
  const r = await postJson(sidecar.base, '/api/dslr/fechar');
  assert.equal(r.status, 409);

  const cfg = await getJson(sidecar.base, '/api/config');
  assert.equal(cfg.dslrEnabled, false);
  assert.ok(String(cfg.dslrFolderResolved).includes('digiCamControl'));
});
