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

function carregarNormalizador() {
  const fonte = extrairFuncao(ler('vendas.html'), 'normalizarComboPortal');
  return new Function(fonte + '\nreturn normalizarComboPortal;')();
}

const normalizar = carregarNormalizador();
const totalDigital = (lista) => lista
  .filter((it) => it.produtoId === 'foto-digital')
  .reduce((s, it) => s + Math.max(1, Number(it.qtd) || 1), 0);

test('combo legado com 1 digital e corrigido para 2 no catalogo do PDV', () => {
  const combo = normalizar({
    id: 'encarte-2-foto-15x20-2-digitais',
    nome: 'ENCARTE + 2 Foto 15x20 + 2 Digitais',
    valorCombo: 85,
    itens: [
      { produtoId: '15x20', tipoProduto: 'tamanho', qtd: 1 },
      { produtoId: '15x20', tipoProduto: 'tamanho', qtd: 1 },
      { produtoId: 'item-encarte', tipoProduto: 'extra', qtd: 1 },
      { produtoId: 'foto-digital', tipoProduto: 'extra', qtd: 1 },
    ],
  });

  assert.equal(combo.modo, undefined);
  assert.equal(combo.itens.filter((it) => it.produtoId === '15x20').length, 2);
  assert.equal(totalDigital(combo.itens), 2);
});

test('combo de slots com 1 digital e corrigido para 2 sem perder os slots', () => {
  const combo = normalizar({
    id: 'combo-encarte-2x15x20-digital',
    nome: 'Encarte + 2 fotos 15x20 + 2 fotos digitais',
    valorCombo: 85,
    modo: 'slots',
    regras: {
      slots: [
        { role: 'foto1', tipo: 'tamanho', modelos: ['15x20'], obrigatorio: true },
        { role: 'foto2', tipo: 'tamanho', modelos: ['15x20'], obrigatorio: true },
      ],
      obrigatorios: [
        { tipo: 'extra', produtoId: 'item-encarte', qtd: 1 },
        { tipo: 'extra', produtoId: 'foto-digital', qtd: 1 },
      ],
    },
  });

  assert.equal(combo.modo, 'slots');
  assert.equal(combo.regras.slots.length, 2);
  assert.equal(totalDigital(combo.regras.obrigatorios), 2);
});

test('combo com apenas 1 digital continua com 1 digital', () => {
  const combo = normalizar({
    id: 'foto-15x20-digital',
    nome: 'FOTO 15X20 + Digital',
    valorCombo: 45,
    itens: [
      { produtoId: '15x20', tipoProduto: 'tamanho', qtd: 1 },
      { produtoId: 'foto-digital', tipoProduto: 'extra', qtd: 1 },
    ],
  });

  assert.equal(totalDigital(combo.itens), 1);
});

const CATALOGO_TESTE = {
  '10x15': 20,
  '15x20': 30,
  'foto-digital': 20,
  'porta-retrato-10x15': 30,
};
const lookupTeste = (id) => ({ id, preco: CATALOGO_TESTE[id] || 10 });

const COMBO_DIGITAL = {
  id: 'combo-teste-digital',
  nome: 'Foto 10x15 + Porta-foto + Digital',
  valorCombo: 45,
  itens: [
    { produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 },
    { produtoId: 'porta-retrato-10x15', tipoProduto: 'extra', qtd: 1 },
    { produtoId: 'foto-digital', tipoProduto: 'extra', qtd: 1 },
  ],
};

const COMBO_2X2 = {
  id: 'combo-teste-2x2',
  nome: '2 Fotos + 2 Digitais',
  valorCombo: 65,
  itens: [
    { produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 },
    { produtoId: '15x20', tipoProduto: 'tamanho', qtd: 1 },
    { produtoId: 'foto-digital', tipoProduto: 'extra', qtd: 2 },
  ],
};

const COMBO_SEM_DIGITAL = {
  id: 'combo-teste-sem-digital',
  nome: 'Foto 10x15 + Porta-foto',
  valorCombo: 30,
  itens: [
    { produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 },
    { produtoId: 'porta-retrato-10x15', tipoProduto: 'extra', qtd: 1 },
  ],
};

function carregarRecalculo() {
  const nomes = [
    'comboTemFotoDigital',
    'comboDigitaisCasadas',
    '_autoComboEntradas',
    '_autoComboEscolherEntradas',
    '_autoComboAplicacoesDigitais',
    '_autoComboDisponiveisDeEntradas',
    '_autoComboRecipes',
    '_autoComboBest',
    'recalcularCombosAutomaticos',
  ];
  const fonte = nomes.map((nome) => extrairFuncao(ler('vendas.html'), nome)).join('\n');
  return new Function(
    'cart', 'currentSession', 'COMBOS', 'catalogLookup',
    fonte + '\nrecalcularCombosAutomaticos(); return cart;'
  );
}

let seqItem = 0;
function item(produtoId, tipo, fotoSeed, qtd = 1) {
  return {
    cartId: 'item-' + (++seqItem),
    sessionId: 'S1', sessionSenha: '1', fotoSeed,
    tipo, produtoId, qtd, precoUnit: 0, preco: 0,
  };
}

const recalcular = carregarRecalculo();
function calcular(cart, combos = [COMBO_DIGITAL]) {
  return recalcular(cart, null, combos, lookupTeste);
}
function descontos(cart) {
  return cart.filter((it) => it.tipo === 'combo-desconto');
}

test('combo com digital aplica quando a digital e da mesma foto', () => {
  const cart = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', 'S1/a.jpg'),
  ]);

  const desc = descontos(cart);
  assert.equal(desc.length, 1);
  assert.equal(desc[0].preco, -25);
  assert.equal(desc[0].fotoSeed, 'S1/a.jpg');
});

test('combo com digital nao aplica quando a digital e de outra foto', () => {
  const cart = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', 'S1/b.jpg'),
  ]);

  assert.equal(descontos(cart).length, 0);
});

test('combo com digital sem foto vinculada nao aplica', () => {
  const cart = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', null),
  ]);

  assert.equal(descontos(cart).length, 0);
});

test('carrinho misto desconta apenas os conjuntos com digital casada', () => {
  const cart = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', 'S1/a.jpg'),
    item('10x15', 'tamanho', 'S1/b.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/b.jpg'),
    item('foto-digital', 'extra', 'S1/b.jpg'),
  ]);

  const desc = descontos(cart);
  assert.equal(desc.length, 1);
  assert.equal(desc[0].qtd, 2);
  assert.equal(desc[0].preco, -50);
});

test('combo 2 fotos + 2 digitais exige uma digital por foto', () => {
  const valido = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('15x20', 'tamanho', 'S1/b.jpg'),
    item('foto-digital', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', 'S1/b.jpg'),
  ], [COMBO_2X2]);
  assert.equal(descontos(valido).length, 1);

  const repetido = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('15x20', 'tamanho', 'S1/b.jpg'),
    item('foto-digital', 'extra', 'S1/a.jpg'),
    item('foto-digital', 'extra', 'S1/a.jpg'),
  ], [COMBO_2X2]);
  assert.equal(descontos(repetido).length, 0);
});

test('combo sem digital continua aceitando itens de fotos diferentes', () => {
  const cart = calcular([
    item('10x15', 'tamanho', 'S1/a.jpg'),
    item('porta-retrato-10x15', 'extra', 'S1/b.jpg'),
  ], [COMBO_SEM_DIGITAL]);

  assert.equal(descontos(cart).length, 1);
});
