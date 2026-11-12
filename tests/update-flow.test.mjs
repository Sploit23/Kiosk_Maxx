import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => readFileSync(path.join(root, ...partes), 'utf8');

test('main procura e baixa atualizacao sozinho em qualquer tela', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /autoUpdater\.autoDownload = false/);
  assert.match(main, /function baixarAtualizacao\(\)/);
  assert.match(main, /autoUpdater\.downloadUpdate\(\)/);
  assert.match(main, /setInterval\(\(\) => performAutoUpdate\(true\), UPDATE_CHECK_MS\)/);
  assert.ok(!main.includes('if (isIdle && !isUpdating) performAutoUpdate()'));
  assert.ok(!main.includes('if (isIdle && !isUpdating) performAutoUpdate'));
});

test('main avisa o renderer quando o download termina', () => {
  const main = ler('electron-main.cjs');
  assert.match(main, /autoUpdater\.on\('update-downloaded'/);
  assert.match(main, /enviarUpdate\('natal:updateReady', \{ version: updateVersion \}\)/);
  assert.match(main, /ipcMain\.handle\('natal:updateStatus'/);
  assert.match(main, /mainWindow\.webContents\.on\('did-finish-load'/);
});

test('renderer mostra "Instalar agora" quando a atualizacao ja baixou', () => {
  const html = ler('vendas.html');
  assert.match(html, /id="update-chip"/);
  assert.match(html, /window\.abrirUpdatePronto = abrirUpdatePronto/);
  assert.match(html, /window\.natal\.on\('natal:updateReady'/);
  assert.match(html, /_updatePronto = true/);
  assert.match(html, /_agendarAvisoUpdatePronto\(\)/);
  assert.match(html, /Atualização pronta para instalar/);
  assert.match(html, /_podeMostrarUpdateAgora/);
  assert.match(html, /natal:updateStatus/);
});

function extrairFuncao(html, nome) {
  let inicio = html.indexOf('function ' + nome + '(');
  if (inicio < 0) throw new Error('funcao nao encontrada: ' + nome);
  let i = html.indexOf('{', inicio);
  let profundidade = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') profundidade++;
    else if (html[i] === '}') {
      profundidade--;
      if (profundidade === 0) return html.slice(inicio, i + 1);
    }
  }
  throw new Error('fim da funcao nao encontrado: ' + nome);
}

test('aviso de atualizacao pronta nao depende da tela de login', () => {
  const html = ler('vendas.html');
  const podeMostrar = extrairFuncao(html, '_podeMostrarUpdateAgora');
  assert.ok(!podeMostrar.includes('screen-'));
  assert.ok(podeMostrar.includes('_impressaoEmAndamento'));
  assert.ok(podeMostrar.includes('modalBloqueado'));
  assert.match(html, /if\(!_updatePronto \|\| _updateDispensada \|\| !_podeMostrarUpdateAgora\(\)\) return;/);
  assert.match(html, /Aguarde a impressão terminar para instalar a atualização/);
});
