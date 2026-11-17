import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => readFileSync(path.join(root, ...partes), 'utf8');

test('main guarda instaladores de versao anterior para rollback', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /const ROLLBACK_DIR = path\.join\('C:', 'ProgramData', 'MaxxNatal', 'installers'\)/);
  assert.match(main, /function nomeInstalador\(versao\)/);
  assert.match(main, /Maxx-Foto-Vendas-Setup-\$\{/);
  assert.match(main, /function listarRollback\(\)/);
  assert.match(main, /function cmpVersao\(a, b\)/);
  assert.match(main, /function podarRollback\(\)/);
});

test('main baixa o instalador da release correta do GitHub', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /api\.github\.com\/repos\/Sploit23\/Kiosk_Maxx\/releases/);
  assert.match(main, /github\.com\/Sploit23\/Kiosk_Maxx\/releases\/download/);
  assert.match(main, /function versaoAnteriorRemota\(\)/);
  assert.match(main, /function baixarInstalador\(versao\)/);
  assert.match(main, /0x4d/);
  assert.match(main, /0x5a/);
  assert.match(main, /function garantirRollbackCache\(\)/);
});

test('rollback so aceita versao anterior e roda o instalador em silencio', () => {
  const main = ler('electron-main.cjs');
  const inicio = main.indexOf("ipcMain.handle('natal:rollbackInstall'");
  assert.ok(inicio >= 0, 'handler natal:rollbackInstall ausente');
  const trecho = main.slice(inicio, inicio + 1600);
  assert.match(trecho, /cmpVersao\(v, app\.getVersion\(\)\) >= 0/);
  assert.match(trecho, /spawn\(alvo\.path, \['\/S', '--force-run'\]/);
  assert.match(trecho, /app\.exit\(0\)/);
  assert.match(trecho, /blockedVersion: app\.getVersion\(\)/);
});

test('versao de onde se voltou fica bloqueada no auto-update', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /function versaoBloqueada\(\)/);
  assert.match(main, /if \(bloqueada && updateVersion === bloqueada\)/);
  assert.match(main, /autoUpdater\.on\('update-available'[\s\S]{0,400}bloqueada/);
  assert.match(main, /ipcMain\.handle\('natal:rollbackUnblock'/);
});

test('Sistema mostra as versoes e o botao de voltar', () => {
  const html = ler('vendas.html');
  assert.match(html, /data-cfg-sec="system"/);
  assert.match(html, /id="cfg-rollback-list"/);
  assert.match(html, /id="cfg-rollback-save"/);
  assert.match(html, /id="cfg-rollback-shortcut"/);
  assert.match(html, /data-rollback-install=/);
  assert.match(html, /Voltar para v\$\{escHtml\(i\.version\)\}/);
  assert.match(html, /natal:rollbackList/);
  assert.match(html, /natal:rollbackSeed/);
  assert.match(html, /natal:rollbackInstall/);
});

test('atalho de emergencia aponta para o instalador salvo', () => {
  const main = ler('electron-main.cjs');
  const inicio = main.indexOf("ipcMain.handle('natal:rollbackShortcut'");
  assert.ok(inicio >= 0, 'handler natal:rollbackShortcut ausente');
  const trecho = main.slice(inicio, inicio + 900);
  assert.match(trecho, /app\.getPath\('desktop'\)/);
  assert.match(trecho, /Restaurar Maxx Foto/);
  assert.match(trecho, /prev\.path/);
});
