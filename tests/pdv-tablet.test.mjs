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

function criarRoleVisibility() {
  const elementos = new Map();
  const elemento = (id) => {
    if (!elementos.has(id)) elementos.set(id, { style: {}, textContent: '' });
    return elementos.get(id);
  };
  const document = {
    getElementById(id) { return elemento(id); },
    querySelector() { return { style: {}, textContent: '' }; },
  };
  const fonte = `
    let currentUser = null;
    function isFotografoAtual(){
      return !!(currentUser && currentUser.funcao === 'Fotógrafo');
    }
    function resetPrinterAlert(){}
    ${extrairFuncao('applyRoleVisibility')}
    return {
      definir(usuario){ currentUser = usuario; applyRoleVisibility(); },
      display(id){ return document.getElementById(id).style.display; },
    };
  `;
  return new Function('document', fonte)(document);
}

test('PDV Tablet aparece para vendedor, gerente e admin', () => {
  const ui = criarRoleVisibility();
  for (const funcao of ['Vendedora', 'Gerente', 'Administrador']) {
    ui.definir({ nome: funcao, funcao });
    assert.equal(ui.display('btn-pdv-tablet'), 'inline-flex', funcao);
  }
});

test('PDV Tablet fica oculto para fotografo e sem login', () => {
  const ui = criarRoleVisibility();
  ui.definir({ nome: 'Fotógrafo', funcao: 'Fotógrafo' });
  assert.equal(ui.display('btn-pdv-tablet'), 'none');
  ui.definir(null);
  assert.equal(ui.display('btn-pdv-tablet'), 'none');
});
