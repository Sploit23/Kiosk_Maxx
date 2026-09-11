import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, RefreshCw, Receipt, Archive, Clock } from 'lucide-react';
import natalApi from '@shared/api/natalApi';
import config from '@shared/config';
import { formatBRL, formatDateTime } from '@shared/utils/imageUtils';
import TopBar from '../components/TopBar';
import { numeroSessao } from '../catalog';

const STATUS_LABEL = {
  AGUARDANDO: 'AGUARDANDO',
  PAGO: 'PAGO',
  IMPRESSO: 'IMPRESSO',
};

function formaTxt(pedido) {
  const formas = [...new Set((pedido.pagamentos || []).map((p) => config.meiosPagamento.find((m) => m.key === p.meio)?.label || p.meio))];
  if (formas.length === 0) return pedido.meio || '—';
  return formas.join(' / ');
}

export default function PedidosScreen({ user, conn, health, caixa, onReabrirPedido, onBack, showToast }) {
  const [pedidos, setPedidos] = useState([]);
  const [busy, setBusy] = useState(false);

  const carregar = async () => {
    setBusy(true);
    try {
      const res = await natalApi.listarPedidos();
      if (res.success) setPedidos(res.pedidos || []);
      else showToast(res.error || 'Erro ao listar pedidos', 'error');
    } catch {
      showToast('Sem conexão com o servidor', 'error');
    }
    setBusy(false);
  };

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const res = await natalApi.listarPedidos();
        if (!cancel && res.success) setPedidos(res.pedidos || []);
        else if (!cancel) showToast(res.error || 'Erro ao listar pedidos', 'error');
      } catch {
        if (!cancel) showToast('Sem conexão com o servidor', 'error');
      }
    })();
    return () => { cancel = true; };
  }, [showToast]);

  const hoje = new Date().toDateString();
  const resumo = useMemo(() => {
    const doDia = pedidos.filter((p) => new Date(p.criadoEm).toDateString() === hoje);
    const pagos = doDia.filter((p) => p.status === 'PAGO' || p.status === 'IMPRESSO');
    const totalVendas = pagos.reduce((a, p) => a + (p.total || 0), 0);
    const ticketMedio = pagos.length ? totalVendas / pagos.length : 0;
    const dinheiro = (caixa?.totalPorMeio?.dinheiro ?? 0) || 0;
    const saldoDinheiro = (caixa?.valorInicial ?? 0) + dinheiro;

    const porProduto = {};
    pagos.forEach((p) => {
      (p.itens || []).forEach((it) => {
        const nome = config.getFormat(it.key)?.label || it.key;
        if (!porProduto[nome]) porProduto[nome] = { qtd: 0, valor: 0 };
        porProduto[nome].qtd += it.qty || 1;
        porProduto[nome].valor += it.subtotal || 0;
      });
      (p.produtos || []).forEach((it) => {
        const nome = config.getProduto(it.key)?.label || it.key;
        if (!porProduto[nome]) porProduto[nome] = { qtd: 0, valor: 0 };
        porProduto[nome].qtd += it.qty || 1;
        porProduto[nome].valor += it.subtotal || 0;
      });
    });

    const porHora = {};
    doDia.forEach((p) => {
      const h = new Date(p.criadoEm).getHours().toString().padStart(2, '0');
      porHora[`${h}h`] = (porHora[`${h}h`] || 0) + (p.total || 0);
    });

    return { pagos, totalVendas, ticketMedio, saldoDinheiro, porProduto, porHora };
  }, [pedidos, caixa, hoje]);

  const listaOrdenada = useMemo(() => [...pedidos].reverse(), [pedidos]);

  return (
    <div className="screen screen-enter">
      <TopBar
        user={user}
        conn={conn}
        health={health}
        rightExtra={<span className="k-chip ghost" onClick={onBack}><ArrowLeft size={14} /> VOLTAR</span>}
        center={<span className="k-chip gold" style={{ cursor: 'default' }}>PEDIDOS DO DIA</span>}
      />
      <div className="pedidos-wrap">
        <div className="pedidos-top">
          <button className="lp-back" onClick={onBack}>← Voltar</button>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h2>Pedidos e resumo de vendas</h2>
            <button className="ped-action-btn" onClick={carregar} disabled={busy}>
              <RefreshCw size={13} className={busy ? 'spin' : ''} style={{ verticalAlign: '-2px' }} /> Atualizar
            </button>
          </div>
        </div>

        <div className="ped-summary">
          <div className="ped-stat"><div className="n">{resumo.pagos.length}</div><div className="l">nº de vendas hoje</div></div>
          <div className="ped-stat"><div className="n">{formatBRL(resumo.totalVendas)}</div><div className="l">valor total vendido</div></div>
          <div className="ped-stat"><div className="n">{formatBRL(resumo.ticketMedio)}</div><div className="l">ticket médio do dia</div></div>
          <div className="ped-stat"><div className="n">{formatBRL(resumo.saldoDinheiro)}</div><div className="l">saldo de caixa em dinheiro</div></div>
        </div>

        <div className="ped-columns">
          <div className="ped-col">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Receipt size={14} color="var(--gold-300)" /> Vendas por produto</h3>
            <div className="ped-list-wrap">
              <table className="ped-table">
                <thead>
                  <tr><th>Produto</th><th>Qtd.</th><th>Valor</th></tr>
                </thead>
                <tbody>
                  {Object.entries(resumo.porProduto).length === 0 && (
                    <tr><td colSpan="3" style={{ color: 'var(--slate-500)' }}>Nenhuma venda ainda</td></tr>
                  )}
                  {Object.entries(resumo.porProduto).map(([nome, v]) => (
                    <tr key={nome}>
                      <td className="ped-itens">{nome}</td>
                      <td>{v.qtd}</td>
                      <td>{formatBRL(v.valor)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="ped-col">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}><Clock size={14} color="var(--gold-300)" /> Vendas por horário</h3>
            <div className="ped-list-wrap">
              <table className="ped-table">
                <thead>
                  <tr><th>Horário</th><th>Valor vendido</th></tr>
                </thead>
                <tbody>
                  {Object.entries(resumo.porHora).length === 0 && (
                    <tr><td colSpan="2" style={{ color: 'var(--slate-500)' }}>Nenhuma venda ainda</td></tr>
                  )}
                  {Object.entries(resumo.porHora).sort(([a], [b]) => a.localeCompare(b)).map(([h, v]) => (
                    <tr key={h}>
                      <td>{h}</td>
                      <td>{formatBRL(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <h3 style={{ marginTop: '22px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}><Archive size={15} color="var(--gold-300)" /> Pedidos do dia</span>{' '}
          <span style={{ fontWeight: 400, color: 'var(--slate-400)', fontSize: '11px' }}>(duplo clique em um pedido pago para reabrir)</span>
        </h3>
        <div className="ped-list-wrap">
          <table className="ped-table ped-table-pedidos">
            <thead>
              <tr>
                <th>Pedido</th><th>Horário</th><th>Sessão</th><th>Valor</th>
                <th>Forma(s)</th><th>Status</th><th>Origem</th><th></th>
              </tr>
            </thead>
            <tbody>
              {pedidos.length === 0 && (
                <tr><td colSpan="8" style={{ color: 'var(--slate-500)' }}>Nenhum pedido registrado ainda — finalize uma venda para ver aqui.</td></tr>
              )}
              {listaOrdenada.map((p) => {
                const pago = p.status === 'PAGO' || p.status === 'IMPRESSO';
                const canReabrir = pago;
                return (
                  <tr
                    key={p.id}
                    title={canReabrir ? 'Duplo clique para reabrir o pedido' : 'Aguardando pagamento'}
                    onDoubleClick={() => {
                      if (canReabrir) onReabrirPedido(p);
                      else showToast('Pedido ainda não pago', 'error');
                    }}
                  >
                    <td className="ped-num">{String(p.numero ?? p.id).padStart(4, '0')}</td>
                    <td>{formatDateTime(p.criadoEm).split(' · ')[0] || formatDateTime(p.criadoEm)}</td>
                    <td className="ped-itens">#{numeroSessao(p.sessaoId)}</td>
                    <td style={{ fontWeight: 700 }}>{formatBRL(p.total || 0)}</td>
                    <td style={{ fontSize: '11.5px' }}>{formaTxt(p)}</td>
                    <td>
                      <span className={`ped-status ${pago ? 'pago' : ''}`}>
                        {STATUS_LABEL[p.status] || p.status}
                      </span>
                    </td>
                    <td style={{ fontSize: '11px' }}>
                      {p.origemPedidoId ? <span style={{ color: 'var(--gold-300)' }}>← originado de {p.origemPedidoId}</span> : '—'}
                    </td>
                    <td>
                      {canReabrir && (
                        <button className="ped-action-btn" onClick={() => onReabrirPedido(p)}>Reabrir</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}