// ─────────────────────────────────────────────────────────────
// Sync PDV → portal (versão React / index.html).
// Porta a lógica do vendas.html para o app React, operando direto
// sobre os dados do sidecar (natalApi) — o portal é o espelho:
//   - snapshot diário (vendas.push): resumo agregado do dia.
//   - pedido-a-pedido (pedido.push): idempotente por pedido.id.
//   - auditoria (auditoria.push): uso de senha master.
// Só ativa quando window.kioskPair existe (loja canônica + machineId).
// ─────────────────────────────────────────────────────────────
import config from '../config';
import natalApi from './natalApi.js';
import portalApi from './portalApi.js';

export function isoDataLocal(d) {
  const t = d instanceof Date ? d : new Date(d);
  if (!(t instanceof Date) || isNaN(t)) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`;
}

export function senhaDeId(id) {
  return String(id || '').replace(/^NATAL-?/i, '');
}

// Identidade da máquina emparelhada (forma que o portal valida).
function par() {
  const kp = typeof window !== 'undefined' ? window.kioskPair : null;
  return kp && kp.ok && kp.loja && kp.pareamento ? kp : null;
}

// Mapeia um pedido do sidecar para o schema do portal (pedido.push).
export function montarPedidoPortal(p) {
  const kp = par();
  const pagamentos = (p.pagamentos || []).map((pg) => ({
    meio: pg.meio || '',
    forma: pg.forma || '',
    valor: +(pg.valor || 0),
    parcelas: pg.parcelas || 0,
  }));
  const itens = [
    ...(p.itens || []).map((it) => {
      const f = config.getFormat(it.key);
      return {
        tipo: 'tamanho',
        produtoId: it.key || '',
        label: f ? f.label : (it.key || ''),
        qtd: it.qty || 1,
        unidades: config.getUnidades(it.key) * (it.qty || 1),
        precoUnit: +(it.unitPrice || 0),
        subtotal: +(it.subtotal || 0),
      };
    }),
    ...(p.produtos || []).map((pr) => {
      const prod = config.getProduto(pr.key);
      return {
        tipo: 'extra',
        produtoId: pr.key || '',
        label: prod ? prod.label : (pr.key || ''),
        qtd: pr.qty || 1,
        unidades: 0,
        precoUnit: +(pr.unitPrice || 0),
        subtotal: +(pr.subtotal || 0),
      };
    }),
  ];
  // Desconto (combo/catálogo/master/falha/comercial) como linha de ajuste
  // negativa para a soma dos itens fechar com o total (base do DRE).
  const descontoValor = p.desconto ? +(Number(p.desconto.valor) || 0).toFixed(2) : 0;
  if (descontoValor > 0.004 && !(p.itens || []).some((it) => it.subtotal < 0)) {
    itens.push({
      tipo: 'ajuste',
      produtoId: '',
      label: (p.desconto && p.desconto.nome) || 'Desconto',
      qtd: 1,
      unidades: 0,
      precoUnit: -descontoValor,
      subtotal: -descontoValor,
    });
  }
  const criadoEm = new Date(p.criadoEm || Date.now());
  const pagoAt = p.pagoEm ? new Date(p.pagoEm) : criadoEm;
  const sessoes = (Array.isArray(p.sessoes) && p.sessoes.length)
    ? p.sessoes.map((s) => ({ id: String((s && s.id) || s), senha: senhaDeId((s && s.id) || s) }))
    : (p.sessaoId ? [{ id: p.sessaoId, senha: senhaDeId(p.sessaoId) }] : []);
  return {
    id: p.id,
    numero: p.numero || p.id,
    pdvNome: (kp && kp.pareamento && kp.pareamento.pdvNome) || '',
    data: isoDataLocal(criadoEm),
    criadoEm: (criadoEm instanceof Date && !isNaN(criadoEm) ? criadoEm : new Date()).toISOString(),
    pagoEm: (pagoAt instanceof Date && !isNaN(pagoAt) ? pagoAt : new Date()).toISOString(),
    total: +(p.total || 0),
    status: ['PAGO', 'IMPRESSO'].includes(p.status) ? 'pago'
      : (p.status === 'CANCELADO' ? 'cancelado' : String(p.status || 'pago').toLowerCase()),
    operador: p.operador || '—',
    itens,
    pagamentos,
    sessoes,
    desconto: +descontoValor.toFixed(2),
    caixaId: p.caixaId || '',
    origemPedidoId: p.origemPedidoId || null,
    guiaImpressa: !!p.guiaImpressa,
  };
}

// Sobe UM pedido (ex.: logo após o pagamento no checkout).
export async function pushPedidoPortal(pedidoRaw) {
  const kp = par();
  if (!kp) return null;
  try {
    const res = await portalApi.pedidoPush(montarPedidoPortal(pedidoRaw));
    if (res && res.ok) {
      console.log('[sync] pedido enviado ao portal:', pedidoRaw.id);
      return true;
    }
    console.warn('[sync] portal não aceitou pedido:', res && res.error);
    return false;
  } catch (e) {
    console.warn('[sync] erro ao enviar pedido:', e);
    return false;
  }
}

// Pedidos do dia (ou todo o histórico no 1º envio após install) → portal.
let _pushHistoricoPedidos = false;
let _pushPedidosTimer = null;

export async function enviarPedidosDia() {
  const kp = par();
  if (!kp) return { ok: 0, falhas: 0 };
  const res = await natalApi.listarPedidos();
  if (!res || !res.success) return { ok: 0, falhas: 0 };
  const todas = (res.pedidos || []).filter((p) =>
    ['PAGO', 'IMPRESSO', 'CANCELADO'].includes(p.status));
  let alvos = todas;
  if (_pushHistoricoPedidos) {
    alvos = alvos.filter((p) => isoDataLocal(p.criadoEm) === isoDataLocal(new Date()));
  }
  if (!alvos.length) return { ok: 0, falhas: 0 };
  let ok = 0, falhas = 0;
  for (const p of alvos) {
    try {
      const pushRes = await portalApi.pedidoPush(montarPedidoPortal(p));
      if (pushRes && pushRes.ok) ok++;
      else { falhas++; if (pushRes && pushRes.error) console.warn('[sync] pedido rejeitado:', pushRes.error); }
    } catch { falhas++; }
  }
  // Só considera o histórico enviado se TUDO subiu (senão reenvia no próximo tick).
  if (!falhas) _pushHistoricoPedidos = true;
  if (ok) console.log(`[sync] ${ok} pedido(s) enviado(s) ao portal${falhas ? ` (${falhas} falha(s))` : ''}`);
  return { ok, falhas };
}

export function agendarPedidosPortal(msec = 800) {
  if (_pushPedidosTimer) clearTimeout(_pushPedidosTimer);
  _pushPedidosTimer = setTimeout(() => { _pushPedidosTimer = null; enviarPedidosDia(); }, msec);
}

// Snapshot diário (vendas.push) — resumo agregado da loja/PDV no dia.
export async function enviarSnapshotVendas() {
  const kp = par();
  if (!kp) return null;
  const hoje = isoDataLocal(new Date());
  const [pedRes, sesRes, cxRes, healthRes, printerRes] = await Promise.all([
    natalApi.listarPedidos().catch(() => null),
    natalApi.listarSessoes().catch(() => null),
    natalApi.caixaEstado().catch(() => null),
    natalApi.health().catch(() => null),
    natalApi.printerStatus().catch(() => null),
  ]);
  const pedidos = (pedRes && pedRes.pedidos) || [];
  const pagos = pedidos.filter((p) =>
    ['PAGO', 'IMPRESSO'].includes(p.status) && isoDataLocal(p.pagoEm || p.criadoEm) === hoje);
  const meios = { dinheiro: 0, pix: 0, debito: 0, credito: 0 };
  for (const p of pagos) {
    for (const pg of (p.pagamentos || [])) {
      const chave = String(pg.meio || '');
      if (chave in meios) meios[chave] += +(pg.valor || 0);
    }
  }
  const sessoes = (sesRes && sesRes.sessoes) || [];
  const sessoesHoje = sessoes.filter((s) => isoDataLocal(s.criadaEm) === hoje);
  const comCombo = pagos.filter((p) => p.desconto && p.desconto.tipo === 'combo').length;
  const ultima = pagos.length
    ? pagos.reduce((a, b) => (new Date(b.pagoEm || b.criadoEm) > new Date(a.pagoEm || a.criadoEm) ? b : a))
    : null;
  const cx = cxRes && cxRes.caixa ? cxRes.caixa : null;
  const snap = {
    lojaId: kp.loja.id,
    machineId: (kp.pareamento && kp.pareamento.machineId) || '',
    pdvNome: (kp.pareamento && kp.pareamento.pdvNome) || '',
    data: hoje,
    totalVendido: pagos.reduce((s, p) => s + (+p.total || 0), 0),
    pedidos: pagos.length,
    sessoesCriadas: sessoesHoje.length,
    sessoesVendidas: sessoesHoje.filter((s) => ['VENDIDA', 'FINALIZADA'].includes(s.estado)).length,
    taxacombo: pagos.length ? +((100 * comCombo) / pagos.length).toFixed(1) : 0,
    meios,
    // null quando o contador de ribbon não está disponível (portal não força 0)
    ribbonRestante: (healthRes && Number.isFinite(+healthRes.ribbon)) ? +healthRes.ribbon : null,
    papel10x15: (printerRes && printerRes.connected !== false && Number.isFinite(+printerRes.paper10x15)) ? +printerRes.paper10x15 : null,
    papel15x20: (printerRes && printerRes.connected !== false && Number.isFinite(+printerRes.paper15x20)) ? +printerRes.paper15x20 : null,
    ultimaVenda: ultima ? new Date(ultima.pagoEm || ultima.criadoEm).toISOString() : null,
    caixa: { numero: (cx && (cx.numero || cx.id)) || '', aberto: !!(cx && !cx.fechadoEm) },
  };
  try {
    const res = await portalApi.vendasPush(snap);
    if (res && res.ok) { console.log('[sync] snapshot enviado:', kp.loja.id, hoje); return res; }
    console.warn('[sync] portal não aceitou snapshot:', res && res.error);
  } catch (e) {
    console.warn('[sync] erro ao enviar snapshot:', e);
  }
  return null;
}

let _snapshotTimer = null;

export function agendarSnapshotVendas(msec = 1500) {
  if (_snapshotTimer) clearTimeout(_snapshotTimer);
  _snapshotTimer = setTimeout(() => { _snapshotTimer = null; enviarSnapshotVendas(); }, msec);
}

// Auditoria (uso de senha master) → portal, idempotente por id.
export async function pushAuditoria(uso) {
  const kp = par();
  if (!kp || !uso || !uso.id) return false;
  try {
    const res = await portalApi.auditoriaPush({
      id: uso.id,
      pdvNome: (kp.pareamento && kp.pareamento.pdvNome) || '',
      titulo: uso.titulo,
      operador: uso.operador || '—',
      motivo: uso.motivo || '',
      data: isoDataLocal(uso.data),
      criadoEm: (uso.data instanceof Date ? uso.data : new Date(uso.data || Date.now())).toISOString(),
      pedidoContexto: uso.pedidoContexto || '',
      pedidoGeradoId: uso.pedidoGeradoId || '',
    });
    return !!(res && res.ok);
  } catch (e) {
    console.warn('[sync] erro ao enviar auditoria:', e);
    return false;
  }
}

export default {
  isoDataLocal,
  senhaDeId,
  montarPedidoPortal,
  pushPedidoPortal,
  enviarPedidosDia,
  agendarPedidosPortal,
  enviarSnapshotVendas,
  agendarSnapshotVendas,
  pushAuditoria,
};