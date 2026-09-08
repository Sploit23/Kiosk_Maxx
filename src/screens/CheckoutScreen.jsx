import { useMemo, useRef, useState } from 'react';
import { Printer, CreditCard, PlayCircle, CheckCircle2, AlertTriangle, Loader, Banknote, QrCode, Landmark, X, Plus, Trash2 } from 'lucide-react';
import config from '@shared/config';
import natalApi from '@shared/api/natalApi';
import { calculateCart } from '@shared/utils/pricing';
import { composePrintImage } from '@shared/utils/printUtils';
import { formatBRL } from '@shared/utils/imageUtils';
import { buildGuiaHtml } from '../components/guiaHtml';
import { numeroSessao, formasDisponiveis } from '../catalog';

const MEIO_ICONS = {
  dinheiro: Banknote,
  pix: QrCode,
  debito: Landmark,
  credito: CreditCard,
};

function rowValor(row) {
  return Number(row.valor || 0);
}

export default function CheckoutScreen({
  sessao, cart, caixa, health, user, desconto, editingPedido,
  printState, onPrintStart, onDone, onCancel, showToast,
}) {
  const resumo = useMemo(() => calculateCart(cart), [cart]);
  const totalPagar = +Math.max(0, resumo.total - (desconto?.valor || 0)).toFixed(2);
  const [rows, setRows] = useState(() => [{ meio: '', parcelas: null, valor: totalPagar }]);
  const [pedido, setPedido] = useState(null);
  const [prep, setPrep] = useState(null);
  const [guiaOk, setGuiaOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const iniciadoRef = useRef(false);

  const alocado = rows.reduce((s, r) => s + rowValor(r), 0);
  const restante = +(totalPagar - alocado).toFixed(2);
  const formas = formasDisponiveis(totalPagar);
  const podePagar = !pedido && !busy && rows.length > 0 && restante === 0 &&
    rows.every((r) => r.meio !== '' && rowValor(r) > 0);

  const atualizarRow = (i, patch) => {
    setRows((prev) => {
      const next = prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      // Com exatamente duas formas, a diferença cai automaticamente na oposta.
      if (next.length === 2 && 'valor' in patch) {
        const other = i === 0 ? 1 : 0;
        let rest = +(totalPagar - rowValor(next[i])).toFixed(2);
        if (rest < 0) rest = 0;
        next[other] = { ...next[other], valor: rest };
      }
      return next;
    });
  };
  const removerRow = (i) => setRows((prev) => prev.filter((_, idx) => idx !== i));
  const adicionarRow = () => {
    if (rows.length >= formas.length) { showToast('Limite de formas atingido', 'error'); return; }
    setRows((prev) => [...prev, { meio: '', parcelas: null, valor: +restante.toFixed(2) }]);
  };

  const imprimirGuia = async () => {
    const html = buildGuiaHtml({
      pedido: {
        numero: editingPedido?.numero || 0,
        sessaoId: sessao.id,
        criadoEm: Date.now(),
        total: totalPagar,
        origemPedidoId: editingPedido?.id || null,
      },
      resumo,
      desconto,
    });
    try {
      const res = await window.natal.ipcInvoke('natal:printGuia', {
        html,
        printerName: config.thermalPrinterName,
      });
      if (res.success) { setGuiaOk(true); showToast('Guia enviada para impressora'); }
      else { showToast(res.error || 'Falha ao imprimir guia', 'error'); }
    } catch (e) {
      showToast(`Impressora indisponível: ${e.message}`, 'error');
    }
  };

  const registrarPagamento = async () => {
    setBusy(true);
    const criado = await natalApi.criarPedido({
      sessaoId: sessao.id,
      itens: resumo.fotos.map((f) => ({
        key: f.key,
        qty: f.qty,
        filename: f.filename,
        scale: f.scale,
        diffx: f.diffx,
        diffy: f.diffy,
        angle: f.angle,
        orientation: f.orientation,
        unitPrice: f.unitPrice,
        subtotal: f.subtotal,
      })),
      produtos: resumo.prod.map((p) => ({ key: p.key, qty: p.qty, unitPrice: p.unitPrice, subtotal: p.subtotal })),
      total: totalPagar,
      origemPedidoId: editingPedido?.id || null,
      operador: user?.nome || null,
      desconto: desconto
        ? { nome: desconto.nome, valor: desconto.valor, tipo: desconto.tipo, motivo: desconto.motivo || null }
        : null,
    });
    if (!criado.success) {
      setBusy(false);
      showToast(criado.error || 'Erro ao criar pedido', 'error');
      return;
    }
    const pago = await natalApi.registrarPagamento(criado.pedido.id, {
      pagamentos: rows
        .filter((r) => r.meio !== '' && rowValor(r) > 0)
        .map((r) => ({ meio: r.meio, valor: rowValor(r), parcelas: r.parcelas || undefined })),
    });
    setBusy(false);
    if (!pago.success) { showToast(pago.error || 'Erro ao registrar pagamento', 'error'); return; }
    setPedido(pago.pedido);
    showToast(`Pedido ${String(pago.pedido.numero).padStart(4, '0')} registrado como PAGO`);
  };

  const pagamentosTxt = (pedido?.pagamentos || []).map((pg) => `${pg.meio}${pg.parcelas ? ' ' + pg.parcelas + 'x' : ''}: ${formatBRL(pg.valor)}`).join(' · ');

  const fotosUnicas = useMemo(() => {
    const map = new Map();
    for (const item of cart.items) {
      const base = item.filename.replace(/\.[^.]+$/, '');
      const uploadName = `${base}__${item.key}.jpg`;
      const id = `${item.filename}__${item.key}`;
      const existing = map.get(id);
      if (existing) existing.qty += item.qty;
      else map.set(id, { filename: uploadName, key: item.key, qty: item.qty, url: item.url, scale: item.scale, diffx: item.diffx, diffy: item.diffy, angle: item.angle, orientation: item.orientation });
    }
    return [...map.values()];
  }, [cart.items]);

  const iniciarProducao = async () => {
    if (iniciadoRef.current) return;
    iniciadoRef.current = true;
    onPrintStart({ status: 'printing', current: 0, total: fotosUnicas.length, done: false });

    for (let i = 0; i < fotosUnicas.length; i++) {
      const f = fotosUnicas[i];
      setPrep({ current: i + 1, total: fotosUnicas.length, msg: `Compondo ${f.key}` });
      try {
        const blob = await composePrintImage(f);
        setPrep({ current: i + 1, total: fotosUnicas.length, msg: `Enviando ${f.filename}` });
        const up = await natalApi.uploadImpressao(pedido.id, f.filename, blob);
        if (!up.success) throw new Error(up.error || 'Falha ao enviar imagem');
      } catch (e) {
        iniciadoRef.current = false;
        setPrep(null);
        onPrintStart({ status: 'error', error: `Falha ao preparar foto: ${e.message}` });
        showToast(`Falha ao preparar foto: ${e.message}`, 'error');
        return;
      }
    }
    setPrep(null);
    const res = await natalApi.imprimirPedido(
      pedido.id,
      fotosUnicas.map((f) => ({ key: f.key, filename: f.filename, qty: f.qty })),
    );
    if (!res.success) {
      iniciadoRef.current = false;
      onPrintStart({ status: 'error', error: res.error || 'Falha ao iniciar impressão' });
      showToast(res.error || 'Falha ao iniciar impressão', 'error');
    }
  };

  const pronto = printState?.done;
  const falha = printState?.status === 'error' || (pronto && !printState.success);

  return (
    <div className="screen screen-enter">
      <div className="topbar">
        <div>
          <h1>
            {editingPedido ? `Reabertura · Pedido ${String(editingPedido.numero).padStart(4, '0')}` : `Checkout · Sessão ${numeroSessao(sessao.id)}`}
          </h1>
          <div className="sub">PDV {health?.pdv ?? ''} · Caixa aberto por {caixa?.operador ?? '—'}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {guiaOk && !pedido && <span className="status-pill status-PRONTA">Guia impressa</span>}
          {!pedido && !busy && (
            <button className="btn-navy" onClick={onCancel}><X size={15} /> Cancelar</button>
          )}
        </div>
      </div>

      <div className="content" style={{ maxWidth: '920px', margin: '0 auto', width: '100%' }}>
        <div className="card">
          <h3>Itens do pedido</h3>
          {resumo.fotos.length === 0 && resumo.prod.length === 0 && <p className="muted">Carrinho vazio.</p>}
          {resumo.fotos.map((item) => (
            <div key={item.id} className="cart-line">
              <span style={{ fontWeight: 800, color: 'var(--gold)' }}>{item.qty}×</span>
              <span style={{ fontWeight: 700 }}>{config.getFormat(item.key).label}</span>
              <span className="muted small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.filename}</span>
              <span style={{ fontWeight: 800 }}>{formatBRL(item.subtotal)}</span>
            </div>
          ))}
          {resumo.prod.map((item) => (
            <div key={item.key} className="cart-line">
              <span style={{ fontWeight: 800, color: 'var(--gold)' }}>{item.qty}×</span>
              <span style={{ fontWeight: 700 }}>{config.getProduto(item.key).label}</span>
              <span className="muted" style={{ flex: 1 }} />
              <span style={{ fontWeight: 800 }}>{formatBRL(item.subtotal)}</span>
            </div>
          ))}
          {desconto && (
            <div className="cart-line">
              <span style={{ fontWeight: 700, color: '#7fd99b' }}>Desconto</span>
              <span className="muted" style={{ flex: 1 }}>{desconto.nome}</span>
              <span style={{ fontWeight: 800, color: '#7fd99b' }}>− {formatBRL(desconto.valor)}</span>
            </div>
          )}
          <div className="total-bar mt-16">
            <span>Total a pagar</span>
            <span>{formatBRL(totalPagar)}</span>
          </div>
        </div>

        {!pedido && (
          <div className="card mt-16">
            <h3>Pagamento (externo) {editingPedido && <span className="muted small" style={{ fontWeight: 500 }}>— gera um novo pedido vinculado ao original</span>}</h3>

            <div className="pay-rows">
              {rows.map((r, i) => {
                const Icon = MEIO_ICONS[r.meio] || CreditCard;
                return (
                  <div key={i} className="pay-row">
                    <div className="pay-row-ico"><Icon size={20} /></div>
                    <select
                      className="pay-row-meio"
                      value={r.parcelas ? `credito:${r.parcelas}` : r.meio}
                      onChange={(e) => {
                        const [meio, parcelas] = e.target.value.split(':');
                        atualizarRow(i, { meio, parcelas: parcelas ? Number(parcelas) : null });
                      }}
                    >
                      <option value="" disabled>Forma…</option>
                      {formas.map((f) => (
                        <option key={`${f.key}-${f.parcelas || 1}`} value={f.parcelas ? `${f.key}:${f.parcelas}` : f.key}>
                          {f.label}
                        </option>
                      ))}
                    </select>
                    <input
                      className="pay-row-valor"
                      type="number"
                      min="0"
                      step="0.01"
                      placeholder="0,00"
                      value={r.valor || ''}
                      onChange={(e) => atualizarRow(i, { valor: parseFloat(e.target.value) || 0 })}
                    />
                    {rows.length > 1 && (
                      <button className="pay-row-del" onClick={() => removerRow(i)} title="Remover forma">
                        <Trash2 size={14} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <button className="btn btn-sm mt-8" onClick={adicionarRow} disabled={rows.length >= formas.length}>
              <Plus size={14} /> Adicionar forma de pagamento (multipagamento)
            </button>

            <div className={`restante-banner mt-12 ${restante === 0 ? 'ok' : ''}`}>
              <span>{restante === 0 ? 'Valor totalmente alocado' : 'Restante a alocar'}</span>
              <span>{formatBRL(Math.abs(restante))}</span>
            </div>
            {totalPagar < 200 && (
              <p className="muted small mt-8">
                Parcelamento no crédito disponível a partir de R$ 200,00 (regra desta loja).
              </p>
            )}

            <div style={{ display: 'flex', gap: '10px', marginTop: '14px' }}>
              <button className="btn" style={{ flex: 1 }} onClick={imprimirGuia} disabled={busy}>
                <Printer size={18} /> Imprimir guia
              </button>
              <button className="btn btn-primary btn-lg" style={{ flex: 2 }} disabled={!podePagar || busy} onClick={registrarPagamento}>
                <CreditCard size={20} /> {busy ? 'Registrando…' : 'Registrar pagamento'}
              </button>
            </div>
            <p className="muted small mt-16">
              O pagamento é feito fora do sistema (máquina de cartão). Selecione as formas e aloque o total após o cliente pagar.
            </p>
          </div>
        )}

        {pedido && (
          <div className="card mt-16">
            <h3>Produção · Pedido {String(pedido.numero).padStart(4, '0')}</h3>
            {pedido.origemPedidoId && (
              <p className="muted small">Originado do pedido {pedido.origemPedidoId} · Pagamento: {pagamentosTxt || '—'}</p>
            )}
            {!pedido.origemPedidoId && (<div className="muted small">Pagamento: {pagamentosTxt || '—'}</div>)}
            <div className="muted small">
              {fotosUnicas.length} foto(s) para imprimir na ASK-400 · Ribbon atual: {health?.ribbon ?? '?'}
            </div>

            {prep && (
              <div className="card mt-16 center" style={{ borderColor: 'rgba(255,193,69,.4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px', fontWeight: 800 }}>
                  <Loader size={22} className="spin" /> {prep.msg} ({prep.current}/{prep.total})
                </div>
              </div>
            )}

            {printState?.status === 'printing' && !printState.done && (
              <div className="card mt-16 center" style={{ borderColor: 'rgba(255,193,69,.4)' }}>
                <div style={{ fontWeight: 800, fontSize: '1.1rem' }}>Imprimindo…</div>
                <div className="mt-8" style={{ height: '10px', borderRadius: '999px', background: 'var(--panel2)', overflow: 'hidden', border: '1px solid var(--line)' }}>
                  <div style={{ width: `${printState.total ? Math.round((printState.current / printState.total) * 100) : 0}%`, height: '100%', background: 'linear-gradient(90deg,#ffd07a,var(--gold))', transition: 'width .3s ease' }} />
                </div>
                <div className="muted small mt-8">
                  Foto {printState.current ?? 0} de {printState.total ?? 0} — aguarde a máquina terminar cada impressão.
                </div>
              </div>
            )}

            {pronto && printState.success && (
              <div className="card mt-16 center" style={{ borderColor: 'rgba(255,193,69,.55)' }}>
                <CheckCircle2 size={40} color="var(--gold)" />
                <div className="serif" style={{ fontWeight: 900, fontSize: '1.3rem', marginTop: '6px' }}>Impressão concluída!</div>
                <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: '14px' }} onClick={onDone}>Concluir pedido</button>
              </div>
            )}

            {falha && (
              <div className="card mt-16 center" style={{ borderColor: 'rgba(255,107,107,.5)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: '#ffb3b5', fontWeight: 800 }}>
                  <AlertTriangle size={22} /> Falha na impressão
                </div>
                <p className="muted small mt-8">{printState?.error || 'Verifique a impressora ASK-400.'}</p>
                <button
                  className="btn btn-primary btn-lg"
                  style={{ width: '100%', marginTop: '12px' }}
                  onClick={async () => {
                    iniciadoRef.current = false;
                    onPrintStart({ status: 'printing', current: 0, total: fotosUnicas.length, done: false });
                    const res = await natalApi.imprimirPedido(
                      pedido.id,
                      fotosUnicas.map((f) => ({ key: f.key, filename: f.filename, qty: f.qty })),
                    );
                    if (!res.success) { iniciadoRef.current = true; showToast(res.error || 'Falha ao reiniciar', 'error'); }
                  }}
                >
                  <PlayCircle size={20} /> Tentar novamente
                </button>
              </div>
            )}

            {!prep && !pronto && !falha && printState?.status !== 'printing' && (
              <button className="btn btn-primary btn-lg" style={{ width: '100%', marginTop: '14px' }} onClick={iniciarProducao}>
                <PlayCircle size={22} /> Iniciar produção
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}