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
  if (html.slice(Math.max(0, inicio - 6), inicio) === 'async ') inicio -= 6;
  let i = html.indexOf('(', inicio);
  let parenteses = 0;
  for (; i < html.length; i++) {
    if (html[i] === '(') parenteses++;
    else if (html[i] === ')') {
      parenteses--;
      if (parenteses === 0) {
        i++;
        break;
      }
    }
  }
  while (i < html.length && html[i] !== '{') i++;
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

function montarPapelInicio(html, printerReal) {
  const fonte = extrairFuncao(html, 'leituraPapelValida')
    + '\n' + extrairFuncao(html, 'papelInicioSugerido')
    + '\nreturn papelInicioSugerido;';
  return new Function('printerReal', fonte)(printerReal);
}

function montarEstoque(html) {
  const fonte = extrairFuncao(html, 'numOuNull')
    + '\n' + extrairFuncao(html, 'estoqueEfetivo')
    + '\nreturn estoqueEfetivo;';
  return new Function(fonte)();
}

test('papel do caixa nao inicia zerado quando a leitura e desconhecida', () => {
  const html = ler('vendas.html');
  const sugerir = montarPapelInicio(html, {
    connected: true, paper10x15: null, paper15x20: null,
  });
  assert.equal(sugerir('10x15'), '');
  assert.equal(sugerir('15x20'), '');

  const zerada = montarPapelInicio(html, {
    connected: true, paper10x15: 0, paper15x20: 0,
  });
  assert.equal(zerada('10x15'), '');
  assert.equal(zerada('15x20'), '');

  const valida = montarPapelInicio(html, {
    connected: true, paper10x15: 12, paper15x20: 8,
  });
  assert.equal(valida('10x15'), '12');
  assert.equal(valida('15x20'), '8');

  const desconectada = montarPapelInicio(html, {
    connected: false, paper10x15: 12, paper15x20: 8,
  });
  assert.equal(desconectada('10x15'), '');
});

test('abertura de caixa nao pede leitura manual de papel', () => {
  const html = ler('vendas.html');
  assert.equal(html.includes('id="ac-papel-10x15"'), false);
  assert.equal(html.includes('id="ac-papel-15x20"'), false);
  assert.match(html, /caixaPapelInicio\(/);
});

test('leitura inicial do papel e completada sozinha e nao sobrescreve a primeira', () => {
  const fonte = ler('sidecar/natal-core.cjs');
  const mesclar = new Function(
    extrairFuncao(fonte, 'mesclarPapelInicio') + '\nreturn mesclarPapelInicio;',
  )();

  assert.deepEqual(mesclar(null, { '10x15': 100, '15x20': 50 }), {
    papel: { '10x15': 100, '15x20': 50 }, mudou: true,
  });
  assert.deepEqual(mesclar({ '10x15': 100, '15x20': 50 }, { '10x15': 80, '15x20': 40 }), {
    papel: { '10x15': 100, '15x20': 50 }, mudou: false,
  });
  assert.deepEqual(mesclar({ '10x15': 100, '15x20': null }, { '10x15': 80, '15x20': 40 }), {
    papel: { '10x15': 100, '15x20': 40 }, mudou: true,
  });
  assert.deepEqual(mesclar({ '10x15': 0, '15x20': 0 }, { '10x15': 0, '15x20': 0 }), {
    papel: { '10x15': null, '15x20': null }, mudou: false,
  });
});

test('sidecar descarta leituras negativas e preserva zero real', () => {
  const fonte = ler('sidecar/natal-core.cjs');
  const funcoes = new Function(
    extrairFuncao(fonte, 'lerLeituraPapel')
      + '\n' + extrairFuncao(fonte, 'infoImpressoraTemLeitura')
      + '\nreturn { lerLeituraPapel, infoImpressoraTemLeitura };',
  )();
  const lerPapel = funcoes.lerLeituraPapel;

  assert.equal(lerPapel(-1), null);
  assert.equal(lerPapel(null), null);
  assert.equal(lerPapel(undefined), null);
  assert.equal(lerPapel(''), null);
  assert.equal(lerPapel(0), 0);
  assert.equal(lerPapel('12'), 12);
  assert.equal(lerPapel(8.4), 8);

  assert.equal(funcoes.infoImpressoraTemLeitura({ paperRemain: -1, paperRemainHalfSize: -1 }), false);
  assert.equal(funcoes.infoImpressoraTemLeitura({ paperRemain: 0, paperRemainHalfSize: 0 }), true);
  assert.equal(funcoes.infoImpressoraTemLeitura({ paperRemain: 8, paperRemainHalfSize: -1 }), true);
  assert.equal(funcoes.infoImpressoraTemLeitura({
    paperRemain: 0, paperRemainHalfSize: 0, lastError: 'Impressora nao encontrada',
  }), false);
  assert.equal(funcoes.infoImpressoraTemLeitura({
    paperRemain: 0, paperRemainHalfSize: 0, lastError: 'Impressora não encontrada',
  }), false);
});

test('portal nao transforma papel ausente em estoque zero', () => {
  const html = ler('backend/admin.html');
  const estoque = montarEstoque(html);

  const semLeitura = estoque({ papel10x15: null, papel15x20: null, ribbonRestante: null });
  assert.equal(semLeitura.valor, null);
  assert.equal(semLeitura.fonte, 'indisponivel');

  const comRibbon = estoque({ papel10x15: null, papel15x20: null, ribbonRestante: 5 });
  assert.equal(comRibbon.valor, 5);
  assert.equal(comRibbon.fonte, 'ribbon');

  const papelZero = estoque({ papel10x15: 0, papel15x20: 0, ribbonRestante: 50 });
  assert.equal(papelZero.valor, 0);
  assert.equal(papelZero.fonte, 'papel');

  const limitado = estoque({ papel10x15: 12, papel15x20: 8, ribbonRestante: 50 });
  assert.equal(limitado.valor, 8);
  assert.equal(limitado.fonte, 'papel');
});
