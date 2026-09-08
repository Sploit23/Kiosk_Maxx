import { useEffect, useState } from 'react';
import { ArrowLeft, RefreshCw, Receipt } from 'lucide-react';
import natalApi from '@shared/api/natalApi';
import { formatBRL, formatDateTime } from '@shared/utils/imageUtils';
import TopBar from '../components/TopBar';
import { numeroSessao } from '../catalog';

const STATUS_LABEL = {
  AGUARDANDO: 'Aguardando pagamento',
  PAGO: 'Pago',
  IMPRESSO: 'Impresso',
};
const STATUS_CLASS = {
  AGUARDANDO: 'status-RECEBENDO',
  PAGO: 'status-EM_ATENDIMENTO',
  IMPRESSO: 'status-VENDIDA',
};

export default function PedidosScreen({ user, conn, health, onReabrirPedido, onBack, showToast }) {
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
  const hojeCount = pedidos.filter((p) => new Date(p.criadoEm).toDateString() === hoje).length;
  const totalHoje = pedidos
    .filter((p) => new Date(p.criadoEm).toDateString() === hoje && p.status !== 'AGUARDANDO')
    .reduce((a, p) => a + (p.total || 0), 0);

  return (
    <div className="screen screen-enter">
      <TopBar
        user={user}
        conn={conn}
        health={health}
        rightExtra={<span className="k-chip ghost" onClick={onBack}><ArrowLeft size={14} /> VOLTAR</span>}
        center={<span className="k-chip gold" style={{ cursor: 'default' }}>PEDIDOS DO DIA</span>}
      />
      <div className="content" style={{ maxWidth: '860px', margin: '0 auto', width: '100%' }}>
        <div className="total-bar" style={{ marginBottom: '18px' }}>
          <span>{hojeCount} pedidos hoje</span>
          <span>Recebido (pagos): {formatBRL(totalHoje)}</span>
        </div>

        <div className="card">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '1.05rem', fontWeight: 800 }}>
                <Receipt size={20} color="var(--gold)" /> Histórico de pedidos
              </div>
              <div className="muted small" style={{ marginTop: '4px' }}>Duplo clique em um pedido pago para reabrir (gera um pedido novo vinculado ao original).</div>
            </div>
            <button className="btn btn-sm" onClick={carregar} disabled={busy}>
              <RefreshCw size={14} className={busy ? 'spin' : ''} /> Atualizar
            </button>
          </div>

          {pedidos.length === 0 && <p className="muted small center" style={{ padding: '26px 0' }}>Nenhum pedido registrado.</p>}

          {pedidos.map((p) => {
            const itensTxt = [
              ...(p.itens || []).map((i) => `${i.qty}x ${i.key}`),
              ...(p.produtos || []).map((i) => `${i.qty}x ${i.key}`),
            ].join(' · ');
            const pago = p.status === 'PAGO' || p.status === 'IMPRESSO';
            return (
              <div
                key={p.id}
                className={`ped-row${pago ? ' reopen' : ''}`}
                title={pago ? 'Duplo clique para reabrir o pedido' : 'Aguardando pagamento'}
                onDoubleClick={() => {
                  if (pago) onReabrirPedido(p);
                  else showToast('Pedido ainda não pago — aguarde o pagamento', 'error');
                }}
              >
                <div className="num">{String(p.numero).padStart(4, '0')}</div>
                <div className="mid">
                  <div className="t">
                    Sessão {numeroSessao(p.sessaoId)} · {' '}
                    <span className="muted">{itensTxt || '—'}</span>
                    {p.origemPedidoId && <span className="k-chip ghost" style={{ marginLeft: '6px', padding: '1px 6px', fontSize: '9px' }}>origem {p.origemPedidoId}</span>}
                  </div>
                  <div className="s">
                    {formatDateTime(p.criadoEm)} · {p.meio || 'sem meio'}
                    {p.pagamentos?.length > 1 ? ` · ${p.pagamentos.length} formas` : ''}
                    {p.desconto ? ` · desconto ${formatBRL(p.desconto.valor)}` : ''}
                  </div>
                </div>
                <span className={`status-pill ${STATUS_CLASS[p.status] || 'status-FINALIZADA'}`}>
                  {STATUS_LABEL[p.status] || p.status}
                </span>
                <div className="val">{formatBRL(p.total)}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}