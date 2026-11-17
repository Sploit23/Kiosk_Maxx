import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(path.join(root, 'vendas.html'), 'utf8');

function extrairFuncao(nome) {
  const inicio = html.indexOf('function ' + nome + '(');
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

function meioInfoDeForma(forma) {
  const f = String(forma || '').trim();
  const chave = f.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (chave.startsWith('dinheiro')) return { meio: 'dinheiro', parcelas: null };
  if (chave.startsWith('debito')) return { meio: 'debito', parcelas: null };
  if (chave.startsWith('pix')) return { meio: 'pix', parcelas: null };
  const parc = /^credito\s+(\d+)\s*x$/.exec(chave);
  if (parc) return { meio: 'credito', parcelas: +parc[1] };
  if (chave.startsWith('credito') || chave.startsWith('cartao')) return { meio: 'credito', parcelas: null };
  return { meio: f, parcelas: null };
}

function montarResumo() {
  const fonte = extrairFuncao('resumoPagamentosPorMeio');
  return new Function('meioInfoDeForma', fonte + '\nreturn resumoPagamentosPorMeio;')(meioInfoDeForma);
}

test('resumo do dia agrupa pagamentos nos quatro meios do PDV', () => {
  const resumo = montarResumo()([
    { pagamentosEfetivos: [
      { forma: 'Dinheiro', valor: 50 },
      { meio: 'debito', forma: 'Débito', valor: 30 },
      { forma: 'PIX', valor: 20 },
      { forma: 'Crédito 2x', valor: 100 },
      { forma: 'Crédito à vista', valor: 40 },
      { forma: 'Cartão', valor: 10 },
    ] },
  ]);

  assert.deepEqual(resumo, { dinheiro: 50, debito: 30, pix: 20, credito: 150 });
});

test('resumo usa o meio normalizado quando a forma vem vazia ou invalida', () => {
  const resumo = montarResumo()([
    { pagamentosEfetivos: [
      { forma: '', meio: 'pix', valor: 12.5 },
      { forma: 'Débito', meio: '?', valor: 7.5 },
    ] },
  ]);

  assert.deepEqual(resumo, { dinheiro: 0, debito: 7.5, pix: 12.5, credito: 0 });
});

test('resumo ignora formas desconhecidas e pagamentos sem valor', () => {
  const resumo = montarResumo()([
    { pagamentosEfetivos: [
      { forma: 'Boleto', valor: 99 },
      { forma: 'Dinheiro', valor: 0 },
      { forma: 'Dinheiro', valor: 10 },
    ] },
  ]);

  assert.deepEqual(resumo, { dinheiro: 10, debito: 0, pix: 0, credito: 0 });
});

test('tela de vendas exibe os quatro quadrados com destaque verde', () => {
  assert.match(html, /\.ped-stat\.ped-stat-pagto\s*\{[^}]*border-color:[^;]*;/);
  assert.match(html, /ped-stat ped-stat-pagto[\s\S]*?dinheiro/);
  assert.match(html, /ped-stat ped-stat-pagto[\s\S]*?D&eacute;bito/);
  assert.match(html, /ped-stat ped-stat-pagto[\s\S]*?PIX/);
  assert.match(html, /ped-stat ped-stat-pagto[\s\S]*?Cr&eacute;dito/);
});
