#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const DEFAULT_KEEP = ['NATAL-00001', 'NATAL-00002', 'NATAL-00003'];
const BASE_BATCH_RE = /^NATAL-S\d{4}$/;
const HASH_CONCURRENCY = Number(process.env.NATAL_CLEANUP_HASH_CONCURRENCY) || 2;

function usage() {
  console.log(`Uso: node scripts/cleanup-storage.mjs --photos-folder <pasta> [opcoes]

Por padrao faz somente dry-run: calcula hashes, mostra o plano e grava um JSON.
Nada e movido/apagado sem --apply.

Opcoes:
  --photos-folder <pasta>  Pasta de fotos (ex.: ...\\Natal_Recebidas)
  --apply                  Executa backup + quarentena + hardlink
  --force                  Ignora a checagem do app rodando (use com cuidado)
  --keep <ids>             Sessoes protegidas (virgula). Default: ${DEFAULT_KEEP.join(',')}
  --remove <ids>           Sessoes para remover mesmo sem duplicata exata (sem pedido)
  --no-hardlink            Nao planeja/executa hardlink dos originals
  --backup <pasta>         Destino do backup (default: irma da pasta de fotos)
  --quarantine <pasta>     Destino da quarentena (default: irma da pasta de fotos)
  --report <arquivo>       JSON do relatorio
  --help                   Esta ajuda
`);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function bytesText(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.rmSync(file, { force: true });
    fs.renameSync(tmp, file);
  }
}

function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function listFiles(dir) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (!entry.isFile() || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    out.push({ name: entry.name, full, size: stat.size });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length || 1) }, worker);
  await Promise.all(workers);
  return results;
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class Hasher {
  constructor() {
    this.cache = new Map();
    this.errors = [];
  }

  async hash(file) {
    if (this.cache.has(file)) return this.cache.get(file);
    let value;
    try {
      value = await hashFile(file);
    } catch (error) {
      value = `erro:${error.message}`;
      this.errors.push({ file, error: error.message });
    }
    this.cache.set(file, value);
    return value;
  }
}

async function describeDirectory(dir, hasher, options = {}) {
  const files = listFiles(dir).filter((file) => {
    if (!options.imagesOnly) return true;
    return IMAGE_EXTS.has(path.extname(file.name).toLowerCase());
  });
  const hashes = await mapLimit(files, HASH_CONCURRENCY, (file) => hasher.hash(file.full));
  files.forEach((file, index) => { file.hash = hashes[index]; });
  const signature = JSON.stringify(files.map((file) => `${file.hash}:${file.size}`).sort());
  return {
    dir,
    files,
    signature,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function collectSessionRefs(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectSessionRefs(item, out);
    return out;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/^(sessaoId|sessao)$/i.test(key) && typeof child === 'string') out.add(child);
    if (key === 'id' && /^NATAL-\d{5}$/.test(String(child))) out.add(String(child));
    collectSessionRefs(child, out);
  }
  return out;
}

function countFiles(dir) {
  let total = 0;
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    if (entry.isDirectory()) total += countFiles(path.join(dir, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

function readSessions(sessionsDir, hasher, protectedIds) {
  return mapLimit(listDirs(sessionsDir), 1, async (id) => {
    const dir = path.join(sessionsDir, id);
    const metaFile = path.join(dir, 'meta.json');
    const meta = readJson(metaFile, null);
    const described = await describeDirectory(path.join(dir, 'originais'), hasher, { imagesOnly: true });
    return {
      id,
      dir,
      meta,
      hasMeta: !!meta,
      importadaDe: meta && meta.importadaDe ? String(meta.importadaDe) : '',
      estado: meta && meta.estado ? String(meta.estado) : '',
      prontaEm: Number(meta && meta.prontaEm) || 0,
      criadaEm: Number(meta && meta.criadaEm) || 0,
      parcial: !!(meta && (meta.importacaoParcial || meta.parcial)),
      files: described.files,
      signature: described.signature,
      bytes: described.bytes,
      fileCount: described.files.length,
      totalFiles: countFiles(dir),
      protected: protectedIds.has(id),
    };
  });
}

function chooseSessionGroup(group) {
  const protectedOnes = group.filter((item) => item.protected);
  if (protectedOnes.length) {
    const keepIds = new Set(protectedOnes.map((item) => item.id));
    return { keep: protectedOnes, remove: group.filter((item) => !keepIds.has(item.id)) };
  }
  const complete = group.filter((item) => item.fileCount > 0 && item.estado === 'PRONTA');
  const pool = complete.length ? complete : group.filter((item) => item.fileCount > 0);
  const candidates = pool.length ? pool : group;
  const sorted = [...candidates].sort((a, b) => (
    (b.prontaEm - a.prontaEm) || (b.criadaEm - a.criadaEm) || b.id.localeCompare(a.id)
  ));
  const chosen = sorted[0];
  return { keep: [chosen], remove: group.filter((item) => item !== chosen) };
}

function chooseBatchGroup(group, referencedNames) {
  const sorted = [...group].sort((a, b) => {
    const refA = referencedNames.has(a.name) ? 0 : 1;
    const refB = referencedNames.has(b.name) ? 0 : 1;
    if (refA !== refB) return refA - refB;
    const baseA = BASE_BATCH_RE.test(a.name) ? 0 : 1;
    const baseB = BASE_BATCH_RE.test(b.name) ? 0 : 1;
    if (baseA !== baseB) return baseA - baseB;
    const doneA = a.hasDone ? 0 : 1;
    const doneB = b.hasDone ? 0 : 1;
    if (doneA !== doneB) return doneA - doneB;
    if (a.name.length !== b.name.length) return a.name.length - b.name.length;
    return a.name.localeCompare(b.name);
  });
  return { keep: sorted[0], remove: sorted.slice(1) };
}

function sameVolume(a, b) {
  return path.parse(path.resolve(a)).root.toLowerCase() === path.parse(path.resolve(b)).root.toLowerCase();
}

function moveDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(src, dest);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.cpSync(src, dest, { recursive: true, preserveTimestamps: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

async function appIsRunning() {
  try {
    const response = await fetch('http://127.0.0.1:9877/api/health', {
      signal: AbortSignal.timeout(900),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function backupDatabase(dbDir, backupDir) {
  fs.mkdirSync(path.join(backupDir, 'database'), { recursive: true });
  for (const name of fs.readdirSync(dbDir)) {
    if (!name.toLowerCase().endsWith('.json')) continue;
    const src = path.join(dbDir, name);
    try {
      if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(backupDir, 'database', name));
    } catch {}
  }
}

function buildRegistry(registry, survivingSessions, batchCanonical, batchesByName, importFolder, hasher) {
  const next = {};
  for (const session of survivingSessions) {
    const original = session.importadaDe;
    if (!original) continue;
    const targetName = batchCanonical.get(original) || original;
    const target = batchesByName.get(targetName);
    if (!target) continue;
    const key = path.resolve(target.dir);
    if (next[key]) continue;
    const oldKey = path.resolve(path.join(importFolder, original));
    const old = registry[oldKey];
    const base = old && typeof old === 'object' && old.id === session.id ? { ...old } : {};
    next[key] = {
      ...base,
      id: session.id,
      snap: old && typeof old.snap === 'string' ? old.snap : JSON.stringify(filesSnapshot(target.files)),
      importadaEm: Number(old && old.importadaEm) || session.prontaEm || Date.now(),
      reconciliada: true,
    };
  }
  void hasher;
  return next;
}

function filesSnapshot(files) {
  const snap = {};
  for (const file of files) snap[file.name] = file.size;
  return snap;
}

function buildHardlinkPlan(survivingSessions, batches, removedBatchNames, enabled) {
  if (!enabled) return { links: [], bytes: 0, skipped: [] };
  const sourceByHash = new Map();
  const keptBatches = batches.filter((batch) => !removedBatchNames.has(batch.name));
  const ordered = [...keptBatches].sort((a, b) => {
    const baseA = BASE_BATCH_RE.test(a.name) ? 0 : 1;
    const baseB = BASE_BATCH_RE.test(b.name) ? 0 : 1;
    if (baseA !== baseB) return baseA - baseB;
    return a.name.localeCompare(b.name);
  });
  for (const batch of ordered) {
    for (const file of batch.files) {
      if (!IMAGE_EXTS.has(path.extname(file.name).toLowerCase())) continue;
      if (String(file.hash).startsWith('erro:')) continue;
      if (!sourceByHash.has(file.hash)) sourceByHash.set(file.hash, file);
    }
  }
  const links = [];
  const skipped = [];
  let bytes = 0;
  for (const session of survivingSessions) {
    for (const file of session.files) {
      const source = sourceByHash.get(file.hash);
      if (!source) {
        skipped.push({ session: session.id, file: file.name, reason: 'sem copia no _cartao' });
        continue;
      }
      if (path.resolve(source.full) === path.resolve(file.full)) continue;
      if (source.size !== file.size) {
        skipped.push({ session: session.id, file: file.name, reason: 'tamanho diferente' });
        continue;
      }
      if (!sameVolume(source.full, file.full)) {
        skipped.push({ session: session.id, file: file.name, reason: 'volumes diferentes' });
        continue;
      }
      try {
        if (fs.statSync(source.full).ino === fs.statSync(file.full).ino) continue;
      } catch {}
      links.push({ source: source.full, dest: file.full, bytes: file.size, session: session.id });
      bytes += file.size;
    }
  }
  return { links, bytes, skipped };
}

function applyHardlinkPlan(plan, report) {
  for (const link of plan.links) {
    const tmp = `${link.dest}.linktmp`;
    const old = `${link.dest}.prelink`;
    try {
      fs.rmSync(tmp, { force: true });
      fs.linkSync(link.source, tmp);
      fs.rmSync(old, { force: true });
      fs.renameSync(link.dest, old);
      try {
        fs.renameSync(tmp, link.dest);
        fs.rmSync(old, { force: true });
      } catch (error) {
        try { fs.renameSync(old, link.dest); } catch {}
        throw error;
      }
      const sourceStat = fs.statSync(link.source);
      const destStat = fs.statSync(link.dest);
      if (sourceStat.ino !== destStat.ino || destStat.nlink < 2) {
        throw new Error('hardlink nao confirmado');
      }
      report.hardlinks.aplicados += 1;
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch {}
      report.hardlinks.falhas.push({ ...link, error: error.message });
    }
  }
}

async function main() {
  const parsed = parseArgs({
    options: {
      'photos-folder': { type: 'string' },
      apply: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      keep: { type: 'string' },
      remove: { type: 'string' },
      'no-hardlink': { type: 'boolean', default: false },
      backup: { type: 'string' },
      quarantine: { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const args = parsed.values;
  if (args.help) { usage(); return; }

  const photosFolder = path.resolve(args['photos-folder'] || process.env.NATAL_PHOTOS_FOLDER || '');
  if (!args['photos-folder'] && !process.env.NATAL_PHOTOS_FOLDER) {
    usage();
    throw new Error('informe --photos-folder');
  }
  if (!fs.existsSync(photosFolder)) throw new Error(`pasta de fotos inexistente: ${photosFolder}`);

  const appDir = path.join(photosFolder, 'natal-app');
  const dbDir = path.join(appDir, 'database');
  const sessionsDir = path.join(appDir, 'sessoes');
  const config = readJson(path.join(dbDir, 'config.json'), {});
  const importFolder = path.resolve(String(config.importFolder || '').trim() || path.join(photosFolder, '_cartao'));
  const registryFile = path.join(dbDir, 'pasta-importadas.json');
  const ordersFile = path.join(dbDir, 'pedidos.json');
  const registry = readJson(registryFile, {});
  const orders = readJson(ordersFile, null);
  const orderRefs = orders ? collectSessionRefs(orders) : new Set();

  const keepIds = new Set(String(args.keep || DEFAULT_KEEP.join(',')).split(',').map((id) => id.trim()).filter(Boolean));
  for (const id of orderRefs) keepIds.add(id);
  const forcedRemoveIds = new Set(
    String(args.remove || '').split(',').map((id) => id.trim()).filter(Boolean)
  );

  const runStamp = stamp();
  const baseName = path.basename(photosFolder);
  const sibling = path.dirname(photosFolder);
  const backupRoot = path.resolve(args.backup || path.join(sibling, `${baseName}_backup_${runStamp}`));
  const quarantineRoot = path.resolve(args.quarantine || path.join(sibling, `${baseName}_quarantine_${runStamp}`));
  const reportFile = path.resolve(args.report || path.join(sibling, `${baseName}_cleanup_report_${runStamp}.json`));
  if (isInside(backupRoot, photosFolder) || isInside(quarantineRoot, photosFolder)) {
    throw new Error('backup/quarentena nao pode ficar dentro da pasta de fotos (watcher do sidecar)');
  }

  const hasher = new Hasher();
  const sessions = await readSessions(sessionsDir, hasher, keepIds);
  const batches = await mapLimit(listDirs(importFolder), 1, async (name) => {
    const dir = path.join(importFolder, name);
    const described = await describeDirectory(dir, hasher);
    return {
      name,
      dir,
      files: described.files,
      signature: described.signature,
      bytes: described.bytes,
      hasDone: fs.existsSync(path.join(dir, '.natal_done')),
    };
  });

  const report = {
    geradoEm: new Date().toISOString(),
    modo: args.apply ? 'apply' : 'dry-run',
    photosFolder,
    importFolder,
    protegidas: [...keepIds].sort(),
    sessoes: {
      total: sessions.length,
      manter: [],
      remover: [],
      vazias: [],
      avisos: [],
      bytesRemovidos: 0,
    },
    lotes: {
      total: batches.length,
      manter: [],
      remover: [],
      avisos: [],
      bytesRemovidos: 0,
    },
    hardlinks: {
      planejados: 0,
      bytes: 0,
      aplicados: 0,
      falhas: [],
      ignorados: [],
    },
    registro: {
      antes: Object.keys(registry).length,
      depois: 0,
    },
    hashesComErro: [],
  };

  const sessionGroups = new Map();
  const survivingSessions = [];
  for (const session of sessions) {
    if (forcedRemoveIds.has(session.id)) {
      if (keepIds.has(session.id)) {
        report.sessoes.avisos.push({
          id: session.id,
          motivo: 'pedido/--keep venceu --remove; mantida',
        });
      } else {
        report.sessoes.remover.push({
          id: session.id,
          importadaDe: session.importadaDe,
          arquivos: session.fileCount,
          bytes: session.bytes,
          motivo: 'remocao explicita aprovada (--remove)',
        });
        report.sessoes.bytesRemovidos += session.bytes;
        continue;
      }
    }
    if (session.fileCount === 0) {
      if (keepIds.has(session.id) || session.totalFiles > 1) {
        survivingSessions.push(session);
        report.sessoes.manter.push({
          id: session.id,
          importadaDe: session.importadaDe,
          arquivos: session.fileCount,
          bytes: session.bytes,
          protegida: session.protected,
        });
        if (session.totalFiles > 1) {
          report.sessoes.avisos.push({
            id: session.id,
            motivo: 'sem originals, mas tem outros arquivos; mantida por seguranca',
          });
        }
        continue;
      }
      report.sessoes.vazias.push({ id: session.id, bytes: session.bytes, arquivos: session.totalFiles });
      continue;
    }
    const list = sessionGroups.get(session.signature) || [];
    list.push(session);
    sessionGroups.set(session.signature, list);
  }

  const removedSessions = new Set();
  for (const group of sessionGroups.values()) {
    const { keep, remove } = chooseSessionGroup(group);
    for (const item of keep) {
      survivingSessions.push(item);
      report.sessoes.manter.push({
        id: item.id,
        importadaDe: item.importadaDe,
        arquivos: item.fileCount,
        bytes: item.bytes,
        protegida: item.protected,
      });
    }
    for (const item of remove) {
      removedSessions.add(item.id);
      report.sessoes.remover.push({
        id: item.id,
        importadaDe: item.importadaDe,
        arquivos: item.fileCount,
        bytes: item.bytes,
        motivo: 'conteudo identico a uma sessao mantida',
        mantidaEquivalente: keep.map((entry) => entry.id),
      });
      report.sessoes.bytesRemovidos += item.bytes;
    }
  }

  for (const empty of report.sessoes.vazias) {
    if (keepIds.has(empty.id)) {
      report.sessoes.avisos.push({ id: empty.id, motivo: 'vazia mas protegida por pedido/--keep' });
      continue;
    }
    removedSessions.add(empty.id);
    report.sessoes.remover.push({
      id: empty.id,
      importadaDe: '',
      arquivos: 0,
      bytes: 0,
      motivo: 'sessao vazia sem pedido',
    });
  }
  report.sessoes.manter.sort((a, b) => a.id.localeCompare(b.id));
  report.sessoes.remover.sort((a, b) => a.id.localeCompare(b.id));
  report.sessoes.bytesRemovidos = report.sessoes.remover.reduce((sum, item) => sum + item.bytes, 0);

  const survivingBatchNames = new Set(
    survivingSessions.map((session) => session.importadaDe).filter(Boolean)
  );
  const batchGroups = new Map();
  for (const batch of batches) {
    if (batch.files.length === 0) {
      if (survivingBatchNames.has(batch.name)) {
        report.lotes.avisos.push({ lote: batch.name, motivo: 'vazio mas referenciado por sessao mantida' });
        continue;
      }
      report.lotes.remover.push({ lote: batch.name, bytes: 0, motivo: 'lote vazio' });
      continue;
    }
    const list = batchGroups.get(batch.signature) || [];
    list.push(batch);
    batchGroups.set(batch.signature, list);
  }

  const removedBatchNames = new Set(report.lotes.remover.map((item) => item.lote));
  const batchCanonical = new Map();
  const keptBatches = [];
  for (const group of batchGroups.values()) {
    const { keep, remove } = chooseBatchGroup(group, survivingBatchNames);
    keptBatches.push(keep);
    report.lotes.manter.push({
      lote: keep.name,
      bytes: keep.bytes,
      arquivos: keep.files.length,
      referenciado: survivingBatchNames.has(keep.name),
    });
    for (const item of remove) {
      removedBatchNames.add(item.name);
      batchCanonical.set(item.name, keep.name);
      report.lotes.remover.push({
        lote: item.name,
        bytes: item.bytes,
        motivo: `conteudo identico ao lote ${keep.name}`,
        mantidoEquivalente: keep.name,
      });
    }
  }
  report.lotes.manter.sort((a, b) => a.lote.localeCompare(b.lote));
  report.lotes.remover.sort((a, b) => a.lote.localeCompare(b.lote));
  report.lotes.bytesRemovidos = report.lotes.remover.reduce((sum, item) => sum + item.bytes, 0);

  for (const session of survivingSessions) {
    if (!session.importadaDe) continue;
    const targetName = batchCanonical.get(session.importadaDe) || session.importadaDe;
    if (removedBatchNames.has(targetName)) {
      report.sessoes.avisos.push({
        id: session.id,
        motivo: `lote ${session.importadaDe} foi removido e nao achei canonico`,
      });
    }
  }

  const batchesByName = new Map(batches.map((batch) => [batch.name, batch]));
  const nextRegistry = buildRegistry(
    registry, survivingSessions, batchCanonical, batchesByName, importFolder, hasher
  );
  report.registro.depois = Object.keys(nextRegistry).length;

  const hardlinkPlan = buildHardlinkPlan(
    survivingSessions, batches, removedBatchNames, !args['no-hardlink']
  );
  report.hardlinks.planejados = hardlinkPlan.links.length;
  report.hardlinks.bytes = hardlinkPlan.bytes;
  report.hardlinks.ignorados = hardlinkPlan.skipped;
  report.hashesComErro = hasher.errors;

  const resumo = {
    sessoesMantidas: report.sessoes.manter.length,
    sessoesRemovidas: report.sessoes.remover.length,
    sessoesVazias: report.sessoes.vazias.length,
    lotesMantidos: report.lotes.manter.length,
    lotesRemovidos: report.lotes.remover.length,
    bytesSessoesRemovidas: report.sessoes.bytesRemovidos,
    bytesLotesRemovidos: report.lotes.bytesRemovidos,
    hardlinks: report.hardlinks.planejados,
    bytesHardlink: report.hardlinks.bytes,
    economialEstimada: report.sessoes.bytesRemovidos + report.lotes.bytesRemovidos + report.hardlinks.bytes,
  };

  console.log('Resumo do plano');
  console.log(`  Sessoes: manter ${resumo.sessoesMantidas}, remover ${resumo.sessoesRemovidas}, vazias ${resumo.sessoesVazias}`);
  console.log(`  Lotes:   manter ${resumo.lotesMantidos}, remover ${resumo.lotesRemovidos}`);
  console.log(`  Remover sessoes: ${bytesText(resumo.bytesSessoesRemovidas)}`);
  console.log(`  Remover lotes:   ${bytesText(resumo.bytesLotesRemovidos)}`);
  console.log(`  Hardlinks:       ${resumo.hardlinks} arquivo(s), ${bytesText(resumo.bytesHardlink)}`);
  console.log(`  Economia estimada: ${bytesText(resumo.economialEstimada)}`);
  if (report.hashesComErro.length) {
    console.log(`  ATENCAO: ${report.hashesComErro.length} arquivo(s) com erro de hash`);
  }

  if (!args.apply) {
    writeJsonAtomic(reportFile, { ...report, resumo });
    console.log(`Relatorio dry-run: ${reportFile}`);
    return;
  }

  if (hasher.errors.length) {
    throw new Error(`${hasher.errors.length} arquivo(s) nao puderam ser lidos; dry-run e resolva antes de aplicar`);
  }
  if (!args.force && await appIsRunning()) {
    throw new Error('app parece estar rodando na porta 9877; feche antes de aplicar (ou use --force)');
  }

  fs.mkdirSync(backupRoot, { recursive: true });
  fs.mkdirSync(quarantineRoot, { recursive: true });
  backupDatabase(dbDir, backupRoot);
  for (const session of sessions) {
    const metaFile = path.join(session.dir, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    const dest = path.join(backupRoot, 'metas', `${session.id}.json`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(metaFile, dest);
  }
  writeJsonAtomic(path.join(backupRoot, 'plano.json'), { ...report, resumo });

  for (const id of report.sessoes.remover.map((item) => item.id)) {
    const src = path.join(sessionsDir, id);
    if (fs.existsSync(src)) moveDir(src, path.join(quarantineRoot, 'sessoes', id));
  }
  for (const name of report.lotes.remover.map((item) => item.lote)) {
    const src = path.join(importFolder, name);
    if (fs.existsSync(src)) moveDir(src, path.join(quarantineRoot, '_cartao', name));
  }

  writeJsonAtomic(registryFile, nextRegistry);
  if (!args['no-hardlink']) applyHardlinkPlan(hardlinkPlan, report);

  writeJsonAtomic(reportFile, {
    ...report,
    resumo,
    backup: backupRoot,
    quarentena: quarantineRoot,
  });
  writeJsonAtomic(path.join(backupRoot, 'relatorio.json'), {
    ...report,
    resumo,
    backup: backupRoot,
    quarentena: quarantineRoot,
  });
  console.log(`Aplicado. Backup: ${backupRoot}`);
  console.log(`Quarentena: ${quarantineRoot}`);
  console.log(`Relatorio: ${reportFile}`);
  if (report.hardlinks.falhas.length) {
    console.log(`Hardlinks com falha: ${report.hardlinks.falhas.length} (veja o relatorio)`);
  }
}

main().catch((error) => {
  console.error(`[cleanup-storage] ${error.message}`);
  process.exitCode = 1;
});
