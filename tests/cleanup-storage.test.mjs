import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, tempDir, rmrf } from './helpers/importerHarness.mjs';

const script = path.join(root, 'scripts', 'cleanup-storage.mjs');

function writeImage(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(content));
}

function addSession(sessionsDir, id, importadaDe, file, content, prontaEm) {
  const dir = path.join(sessionsDir, id);
  writeImage(path.join(dir, 'originais', file), content);
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    id,
    estado: 'PRONTA',
    importadaDe,
    prontaEm,
    fotosQtd: 1,
  }));
}

function addBatch(importFolder, name, file, content) {
  const dir = path.join(importFolder, name);
  writeImage(path.join(dir, file), content);
  fs.writeFileSync(path.join(dir, '.natal_done'), '{}');
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('cleanup dry-run protege pedidos, remove duplicatas exatas e planeja hardlink', { timeout: 60000 }, (t) => {
  const work = tempDir('cleanup-dry');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'Natal_Recebidas');
  const dbDir = path.join(photosFolder, 'natal-app', 'database');
  const sessionsDir = path.join(photosFolder, 'natal-app', 'sessoes');
  const importFolder = path.join(photosFolder, '_cartao');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(importFolder, { recursive: true });
  fs.writeFileSync(path.join(dbDir, 'config.json'), JSON.stringify({ photosFolder, importFolder: '' }));
  fs.writeFileSync(path.join(dbDir, 'pedidos.json'), JSON.stringify([
    { id: 'PED-1', sessaoId: 'NATAL-00001', sessoes: [{ id: 'NATAL-00001' }], itens: [] },
    { id: 'PED-2', sessaoId: 'NATAL-00079', sessoes: [{ id: 'NATAL-00079' }], itens: [] },
  ]));

  addSession(sessionsDir, 'NATAL-00001', 'NATAL-S0001', 'A.jpg', 'conteudo-A', 100);
  addSession(sessionsDir, 'NATAL-00004', 'NATAL-S0004', 'B.jpg', 'conteudo-B', 200);
  addSession(sessionsDir, 'NATAL-00005', 'NATAL-S0004', 'B.jpg', 'conteudo-B', 300);
  addSession(sessionsDir, 'NATAL-00006', 'NATAL-S0020', 'D.jpg', 'conteudo-D', 400);
  addSession(sessionsDir, 'NATAL-00079', 'NATAL-S0010', 'C.jpg', 'conteudo-C', 500);
  fs.mkdirSync(path.join(sessionsDir, 'NATAL-00031'), { recursive: true });

  addBatch(importFolder, 'NATAL-S0001', 'A.jpg', 'conteudo-A');
  addBatch(importFolder, 'NATAL-S0004', 'B.jpg', 'conteudo-B');
  addBatch(importFolder, 'NATAL-S0004-abcd', 'B.jpg', 'conteudo-B');
  addBatch(importFolder, 'NATAL-S0010', 'C.jpg', 'conteudo-C');
  addBatch(importFolder, 'NATAL-S0020', 'D.jpg', 'conteudo-D');
  addBatch(importFolder, 'NATAL-S0020-nested', 'D.jpg', 'conteudo-D');

  const registry = {};
  for (const [session, batch] of [
    ['NATAL-00001', 'NATAL-S0001'],
    ['NATAL-00004', 'NATAL-S0004'],
    ['NATAL-00005', 'NATAL-S0004'],
    ['NATAL-00006', 'NATAL-S0020'],
    ['NATAL-00079', 'NATAL-S0010'],
  ]) {
    registry[path.resolve(path.join(importFolder, batch))] = { id: session, snap: '{}', importadaEm: 1 };
  }
  fs.writeFileSync(path.join(dbDir, 'pasta-importadas.json'), JSON.stringify(registry));

  const reportFile = path.join(work, 'report.json');
  const result = run([
    '--photos-folder', photosFolder,
    '--report', reportFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const removed = new Set(report.sessoes.remover.map((item) => item.id));
  assert.ok(removed.has('NATAL-00004'));
  assert.ok(removed.has('NATAL-00031'));
  assert.ok(!removed.has('NATAL-00001'));
  assert.ok(!removed.has('NATAL-00005'));
  assert.ok(!removed.has('NATAL-00079'));
  assert.deepEqual(
    report.lotes.remover.map((item) => item.lote).sort(),
    ['NATAL-S0004-abcd', 'NATAL-S0020-nested']
  );
  assert.equal(report.hardlinks.planejados, 4);
  assert.ok(fs.existsSync(path.join(sessionsDir, 'NATAL-00004')));
  assert.ok(fs.existsSync(path.join(importFolder, 'NATAL-S0004-abcd')));
  assert.ok(!fs.existsSync(path.join(work, 'quarantine')));
});

test('cleanup apply move para quarentena, remapeia registro e confirma hardlinks', { timeout: 60000 }, (t) => {
  const work = tempDir('cleanup-apply');
  t.after(() => rmrf(work));
  const photosFolder = path.join(work, 'Natal_Recebidas');
  const dbDir = path.join(photosFolder, 'natal-app', 'database');
  const sessionsDir = path.join(photosFolder, 'natal-app', 'sessoes');
  const importFolder = path.join(photosFolder, '_cartao');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(importFolder, { recursive: true });
  fs.writeFileSync(path.join(dbDir, 'config.json'), JSON.stringify({ photosFolder, importFolder: '' }));
  fs.writeFileSync(path.join(dbDir, 'pedidos.json'), '[]');

  addSession(sessionsDir, 'NATAL-00004', 'NATAL-S0004', 'B.jpg', 'conteudo-B', 200);
  addSession(sessionsDir, 'NATAL-00005', 'NATAL-S0004', 'B.jpg', 'conteudo-B', 300);
  addBatch(importFolder, 'NATAL-S0004', 'B.jpg', 'conteudo-B');
  addBatch(importFolder, 'NATAL-S0004-abcd', 'B.jpg', 'conteudo-B');
  fs.writeFileSync(path.join(dbDir, 'pasta-importadas.json'), JSON.stringify({
    [path.resolve(path.join(importFolder, 'NATAL-S0004'))]: { id: 'NATAL-00005', snap: '{}', importadaEm: 1 },
    [path.resolve(path.join(importFolder, 'NATAL-S0004-abcd'))]: { id: 'NATAL-00004', snap: '{}', importadaEm: 1 },
  }));

  const backup = path.join(work, 'backup');
  const quarantine = path.join(work, 'quarantine');
  const reportFile = path.join(work, 'report.json');
  const result = run([
    '--photos-folder', photosFolder,
    '--apply', '--force',
    '--backup', backup,
    '--quarantine', quarantine,
    '--report', reportFile,
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(!fs.existsSync(path.join(sessionsDir, 'NATAL-00004')));
  assert.ok(fs.existsSync(path.join(quarantine, 'sessoes', 'NATAL-00004')));
  assert.ok(!fs.existsSync(path.join(importFolder, 'NATAL-S0004-abcd')));
  assert.ok(fs.existsSync(path.join(quarantine, '_cartao', 'NATAL-S0004-abcd')));
  assert.ok(fs.existsSync(path.join(backup, 'database', 'pedidos.json')));

  const registry = JSON.parse(fs.readFileSync(path.join(dbDir, 'pasta-importadas.json'), 'utf8'));
  assert.equal(Object.keys(registry).length, 1);
  assert.equal(registry[path.resolve(path.join(importFolder, 'NATAL-S0004'))].id, 'NATAL-00005');

  const original = path.join(sessionsDir, 'NATAL-00005', 'originais', 'B.jpg');
  const canonical = path.join(importFolder, 'NATAL-S0004', 'B.jpg');
  assert.equal(fs.statSync(original).ino, fs.statSync(canonical).ino);
  assert.ok(fs.statSync(original).nlink >= 2);

  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  assert.equal(report.modo, 'apply');
  assert.equal(report.hardlinks.aplicados, 1);
  assert.equal(report.hardlinks.falhas.length, 0);
});
