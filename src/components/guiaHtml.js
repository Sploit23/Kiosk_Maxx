// ─────────────────────────────────────────────────────────────
// Gera o HTML da guia de pagamento (impressora térmica 80mm).
// O renderer envia este HTML ao main via `natal:printGuia`, que
// imprime silencioso na impressora configurada (driver do Windows).
// ─────────────────────────────────────────────────────────────
import config from '@shared/config';
import { formatBRL } from '@shared/utils/imageUtils';
import { LOJA } from '../catalog';

export function buildGuiaHtml({ pedido, resumo, desconto }) {
  const d = new Date(pedido.criadoEm);
  const dataHora = d.toLocaleDateString('pt-BR') + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

  const linhas = resumo.fotos.map((item) => ({
    qty: item.qty,
    desc: config.getFormat(item.key).label,
    unit: item.unitPrice,
    sub: item.subtotal,
  }));
  for (const item of resumo.prod) {
    linhas.push({ qty: item.qty, desc: config.getProduto(item.key).label, unit: item.unitPrice, sub: item.subtotal });
  }
  if (desconto && desconto.valor > 0) {
    linhas.push({ qty: 1, desc: `Desconto: ${desconto.nome}`, unit: -desconto.valor, sub: -desconto.valor });
  }

  const rows = linhas
    .map(
      (l) =>
        `${l.qty}x ${l.desc}`.padEnd(30, ' ') +
        `${formatBRL(l.sub).padStart(12, ' ')}`
    )
    .join('\n');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: 80mm auto; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 80mm;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    line-height: 1.45;
    color: #000;
    padding: 8px 6px;
  }
  .c { text-align: center; }
  .b { font-weight: bold; }
  .big { font-size: 16px; }
  .line { border-top: 1px dashed #000; margin: 6px 0; }
  .total { font-size: 15px; }
  pre { white-space: pre; font-family: inherit; font-size: 12px; }
</style>
</head>
<body>
  <div class="c big b">${LOJA.nome} · ${config.eventName}</div>
  <div class="c b">GUIA DE PAGAMENTO</div>
  <div class="line"></div>
  <div><b>PDV:</b> ${LOJA.local}</div>
  <div><b>Pedido:</b> ${String(pedido.numero).padStart(4, '0')}${pedido.origemPedidoId ? ` (origem ${pedido.origemPedidoId})` : ''}</div>
  <div><b>Sessao:</b> ${pedido.sessaoId}</div>
  <div><b>Data:</b> ${dataHora}</div>
  <div class="line"></div>
  <pre>${rows}</pre>
  <div class="line"></div>
  <div class="total b">TOTAL: ${formatBRL(pedido.total)}</div>
  <div>Pagamento: PENDENTE</div>
  <div class="line"></div>
  <div class="c">Pague no caixa e volte com esta guia.</div>
</body>
</html>`;
  return html;
}