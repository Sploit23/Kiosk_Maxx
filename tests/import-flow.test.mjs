import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => readFileSync(path.join(root, ...partes), 'utf8');

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

function carregarBanner() {
  const html = ler('vendas.html');
  const fonte = 'function numeroSessao(id){ return String(id || "").replace(/^NATAL-/, ""); }\n' +
    extrairFuncao(html, 'importTimeLabel') + '\n' +
    extrairFuncao(html, 'importBannerInfo');
  return new Function(fonte + '\nreturn importBannerInfo;')();
}

const banner = carregarBanner();
const base = { success: true, online: true, importer: {} };

test('banner mostra importador parado quando o servico nao responde', () => {
  const info = banner({ ...base, online: false });
  assert.equal(info.kind, 'error');
  assert.match(info.title, /Importador parado/);
});

test('banner mostra progresso de copia e download', () => {
  const copia = banner({ ...base, importer: { progress: { count: 2, total: 5 } } });
  assert.equal(copia.kind, 'busy');
  assert.match(copia.detail, /2 de 5/);

  const download = banner({ ...base, importer: { download: { count: 1, total: 3, batch: 'NATAL_0007' } } });
  assert.equal(download.kind, 'busy');
  assert.match(download.title, /outro PC/);
  assert.match(download.detail, /NATAL_0007/);
});

test('banner usa o numero da sessao parcial durante o download', () => {
  const info = banner({ ...base,
    sessoes: { NATAL_0007: 'NATAL-00042' },
    importer: { download: { count: 1, total: 3, batch: 'NATAL_0007' } },
  });
  assert.equal(info.kind, 'busy');
  assert.match(info.detail, /#00042/);
  assert.doesNotMatch(info.detail, /NATAL_0007/);
});

test('banner de sucesso usa o numero da sessao quando ela ja chegou', () => {
  const info = banner({ ...base,
    sessoes: { NATAL_0009: 'NATAL-00077' },
    importer: { card: { state: 'finished', batch: 'NATAL_0009', count: 5, found: 5 } },
  });
  assert.equal(info.kind, 'ok');
  assert.match(info.title, /Sessão 00077/);
});

test('banner nao mascara falha de copia como cartao vazio', () => {
  const info = banner({ ...base, importer: { card: {
    state: 'copy_error',
    message: 'Falha ao copiar 2 foto(s). Nada foi publicado; tente de novo.',
    found: 5,
    newCount: 5,
  } } });
  assert.equal(info.kind, 'error');
  assert.match(info.title, /Falha ao importar/);
  assert.match(info.detail, /Nada foi publicado/);
});

test('banner confirma que o cartao ja foi processado', () => {
  const info = banner({ ...base, importer: { card: {
    state: 'all_imported',
    message: 'Todas as 5 fotos deste cartao ja foram importadas antes.',
    found: 5,
    newCount: 0,
  } } });
  assert.equal(info.kind, 'ok');
  assert.match(info.title, /processado/);
  assert.match(info.detail, /pode remover o cartão/);
});

test('banner de sucesso mostra encontradas e importadas', () => {
  const info = banner({ ...base, importer: { card: {
    state: 'finished',
    batch: 'NATAL_0009',
    count: 5,
    found: 6,
  } } });
  assert.equal(info.kind, 'ok');
  assert.match(info.title, /NATAL_0009/);
  assert.match(info.detail, /5 foto/);
  assert.match(info.detail, /de 6 encontradas/);
});

test('banner mantem resumo do ultimo cartao quando fica ocioso', () => {
  const info = banner({ ...base, importer: {
    card: { state: 'waiting' },
    lastImport: { batch: 'NATAL_0010', count: 4, at: 1700000000 },
  } });
  assert.equal(info.kind, 'neutral');
  assert.match(info.title, /NATAL_0010/);
  assert.match(info.detail, /4 foto/);
});

test('backend expoe found/newCount/lastImport e separa erros', () => {
  const app = ler('tools', 'pegar-fotos', 'app.py');
  assert.match(app, /found_count = len\(photo_files\)/);
  assert.match(app, /"lastImport": self\._status\.get\("lastImport"\)/);
  assert.match(app, /self\.config\["last_import"\] = last_import/);
  assert.match(app, /def set_status_error\(/);
  assert.match(app, /"copy_error"/);
  assert.match(app, /"publish_error"/);
  assert.ok(!app.includes('self.root.after(0, self.set_status_empty, source)'));
});

test('registry so e confirmado depois de publicar o lote', () => {
  const app = ler('tools', 'pegar-fotos', 'app.py');
  const publish = app.indexOf('published = self._publish_batch(tmp_dir, final_dir)');
  const commit = app.indexOf('self._registry_names.setdefault(dest_name', publish);
  assert.ok(publish > 0, 'publicacao do lote nao encontrada');
  assert.ok(commit > publish, 'registry foi confirmado antes de publicar');
});

test('tela de Sessoes tem banner e polling curto', () => {
  const html = ler('vendas.html');
  assert.match(html, /id="import-banner"/);
  assert.match(html, /function importBannerInfo\(r\)/);
  assert.match(html, /function renderImportBanner\(r\)/);
  assert.match(html, /setInterval\(atualizarStatusImport, 3000\)/);
  assert.match(html, /imp\.lastImport/);
});

function carregarLoteRecebendoInfo() {
  const fonte = extrairFuncao(ler('sidecar', 'natal-core.cjs'), 'loteRecebendoInfo');
  return new Function(fonte + '\nreturn loteRecebendoInfo;')();
}

const loteRecebendoInfo = carregarLoteRecebendoInfo();

test('download em andamento identifica o lote parcial e o total', () => {
  const info = loteRecebendoInfo('NATAL_0007', {
    ok: true,
    download: { batch: 'NATAL_0007', count: 2, total: 5 },
  });
  assert.deepEqual(info, { total: 5, count: 2, ativo: true });
});

test('lote listado pelo outro PC vira parcial mesmo sem download ativo', () => {
  const info = loteRecebendoInfo('NATAL_0008', {
    ok: true,
    peer: { batches: [{ name: 'NATAL_0008', count: 4 }] },
  });
  assert.deepEqual(info, { total: 4, count: 0, ativo: false });
});

test('lote desconhecido ou importador offline nao cria parcial', () => {
  assert.equal(loteRecebendoInfo('NATAL_0009', null), null);
  assert.equal(loteRecebendoInfo('NATAL_0009', { ok: false }), null);
  assert.equal(loteRecebendoInfo('NATAL_0009', { ok: true, peer: { batches: [] } }), null);
});
