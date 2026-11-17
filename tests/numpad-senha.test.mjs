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

function atualizar(tipo, valor) {
  const fonte = `
    let numpadTarget = { tagName: 'INPUT', type: ${JSON.stringify(tipo)} };
    let numpadBuf = ${JSON.stringify(valor)};
    let numpadMoney = false;
    const document = { getElementById(){ return disp; } };
    function numpadDinheiroTexto(){ return ''; }
    ${extrairFuncao('numpadEhSenha')}
    ${extrairFuncao('atualizarNumpad')}
    atualizarNumpad();
    return disp.textContent;
  `;
  const disp = { textContent: '', innerHTML: '' };
  new Function('disp', fonte)(disp);
  return disp.innerHTML || disp.textContent;
}

test('teclado numerico mascara qualquer senha digitada', () => {
  assert.equal(atualizar('password', '1234'), '****');
  assert.equal(atualizar('password', '12'), '**');
  assert.equal(atualizar('password', ''), '\u00a0');
});

test('teclado numerico continua mostrando valores normais', () => {
  assert.equal(atualizar('text', '1234'), '1234');
});

test('todos os campos de senha do PDV usam type=password', () => {
  for (const id of ['login-senha', 'sm-senha', 'sd-senha', 'st-senha', 'cfg-senha-input', 'lm-senha']) {
    const tag = html.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
    assert.ok(tag, `input ${id} nao encontrado`);
    assert.match(tag[0], /type="password"/, `${id} precisa ser type=password`);
  }
});
