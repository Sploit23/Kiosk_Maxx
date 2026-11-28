import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => fs.readFileSync(path.join(root, ...partes), 'utf8');

async function subirSidecar(pasta) {
  const porta = 21000 + Math.floor(Math.random() * 1000);
  let logs = '';
  const child = spawn(process.execPath, ['sidecar/natal-core.cjs'], {
    cwd: root,
    env: {
      ...process.env,
      NATAL_PORT: String(porta),
      NATAL_HOST: '127.0.0.1',
      NATAL_PHOTOS_FOLDER: pasta,
      NATAL_DATA_DIR: path.join(pasta, 'natal-app'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) return { child, base };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('sidecar nao subiu\n' + logs);
}

async function parar(child) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch {}
  child.kill();
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1500))]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1000))]);
  }
}

test('equipe do portal traz hash offline e o PDV cai no cache local', () => {
  const php = ler('backend', 'api.php');
  assert.match(php, /function userVisible\(array \$u, bool \$withSenha = false, bool \$withHash = false\)/);
  assert.match(php, /userVisible\(\$u, false, true\)/);
  assert.match(php, /\$out\['senhaHash'\] = hash\('sha256'/);
  const html = ler('vendas.html');
  assert.match(html, /senhaHash: String\(u\.senhaHash \|\| ''\)\.trim\(\)/);
  assert.match(html, /cachePortalSave\(\{ equipe: lista, lojaId: lojaAtual \}\)/);
  assert.match(html, /setInterval\(atualizarEquipeSilenciosa, 60000\)/);
  assert.match(html, /else offline = true;/);
  assert.doesNotMatch(html, /res && res\.ok === false\)\{ document\.getElementById\('login-error'\)/);
  const sidecar = ler('sidecar', 'natal-core.cjs');
  assert.match(sidecar, /cachePortal\.equipe/);
  assert.match(sidecar, /x\.senhaHash/);
});

test('credencial da equipe em cache autentica sem internet', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-login-'));
  const db = path.join(tmp, 'natal-app', 'database');
  fs.mkdirSync(db, { recursive: true });
  const hash = crypto.createHash('sha256').update('1234').digest('hex');
  fs.writeFileSync(path.join(db, 'cache-portal.json'), JSON.stringify({
    lojaId: 'teste',
    equipe: [
      { id: 'u-1', usuario: 'Freelance', nome: 'Freelance', funcao: 'vendedor', ativo: true, senhaHash: hash },
      { id: 'u-2', usuario: 'jessika', nome: 'jessika', funcao: 'fotografo', ativo: true, senhaHash: hash },
    ],
  }));

  const { child, base } = await subirSidecar(tmp);
  try {
    const conferir = (usuario, senha) => fetch(base + '/api/cache/portal/conferir', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ usuario, senha }),
    }).then((r) => r.json());
    assert.equal((await conferir('Freelance', '1234')).ok, true);
    assert.equal((await conferir('jessika', '1234')).ok, true);
    assert.equal((await conferir('jessika', 'errada')).ok, false);
    assert.equal((await conferir('desconhecido', '1234')).ok, false);
  } finally {
    await parar(child);
  }
});
