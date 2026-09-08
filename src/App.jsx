import { useEffect, useRef, useState, useCallback } from 'react';
import natalApi from '@shared/api/natalApi';
import { connectSSE } from '@shared/api/sse';
import LoginScreen from './screens/LoginScreen';
import CaixaScreen from './screens/CaixaScreen';
import PainelScreen from './screens/PainelScreen';
import VendaScreen from './screens/VendaScreen';
import CheckoutScreen from './screens/CheckoutScreen';
import PedidosScreen from './screens/PedidosScreen';

export default function App() {
  const [user, setUser] = useState(null);
  const [health, setHealth] = useState(null);
  const [caixa, setCaixa] = useState(null);
  const [sessoes, setSessoes] = useState([]);
  const [conn, setConn] = useState('connecting');
  const [view, setView] = useState('painel');
  const [activeSessao, setActiveSessao] = useState(null);
  const [cart, setCart] = useState({ items: [], products: [] });
  const [desconto, setDesconto] = useState(null);
  const [editingPedido, setEditingPedido] = useState(null);
  const [printState, setPrintState] = useState(null);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const showToast = useCallback((msg, type = 'ok') => {
    setToast({ msg, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const refreshSessoes = useCallback(async () => {
    try {
      const res = await natalApi.listarSessoes();
      if (res.success) setSessoes(res.sessoes || []);
    } catch { /* silencioso */ }
  }, []);

  const refreshCaixa = useCallback(async () => {
    try {
      const res = await natalApi.caixaEstado();
      if (res.success) setCaixa(res.caixa);
    } catch { /* silencioso */ }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const res = await natalApi.health();
      if (res.ok) setHealth(res);
    } catch { setHealth(null); }
  }, []);

  useEffect(() => {
    setTimeout(() => {
      refreshHealth();
      refreshCaixa();
      refreshSessoes();
    }, 0);
    const poll = setInterval(refreshHealth, 15000);
    return () => clearInterval(poll);
  }, [refreshHealth, refreshCaixa, refreshSessoes]);

  useEffect(() => {
    connectSSE((evt, data) => {
      if (evt === 'sessao:status' || evt === 'sessao:criada' || evt === 'sessao:concluida') refreshSessoes();
      if (evt === 'caixa:aberto' || evt === 'caixa:fechado') refreshCaixa();
      if (evt === 'pedido:criado' || evt === 'pedido:pago') refreshSessoes();
      if (evt === 'printer:progress') setPrintState((p) => ({ ...(p || {}), current: data.current, total: data.total, status: 'printing' }));
      if (evt === 'print-complete') setPrintState((p) => ({ ...(p || {}), done: true, success: data.success, error: data.error }));
    }, setConn);
  }, [refreshSessoes, refreshCaixa]);

  const effectiveView = user !== null && caixa === null ? 'caixa' : view;

  const finalizarVenda = () => {
    if (!caixa) { showToast('Abra o caixa antes de vender', 'error'); setView('caixa'); return; }
    setView('checkout');
  };

  const abrirVenda = (s) => {
    setActiveSessao((prev) => (prev?.id === s.id ? prev : s));
    setDesconto(null);
    setEditingPedido(null);
    setView('venda');
  };

  const reabrirPedido = (p) => {
    const sess = sessoes.find((s) => s.id === p.sessaoId);
    if (!sess) { showToast('Sessão do pedido não encontrada para reabrir', 'error'); return; }
    const items = (p.itens || []).map((i, idx) => ({
      id: `reopen-${p.id}-${idx}-${i.key}`,
      key: i.key,
      filename: i.filename || `${i.key}-${idx}`,
      qty: i.qty || 1,
      url: i.filename ? natalApi.fotoUrl(sess.id, 'previews', i.filename) : '',
      scale: i.scale,
      diffx: i.diffx,
      diffy: i.diffy,
      angle: i.angle,
      orientation: i.orientation || 'retrato',
    }));
    setCart({ items, products: (p.produtos || []).map((i) => ({ key: i.key, qty: i.qty || 1 })) });
    setDesconto(null);
    setEditingPedido(p);
    setActiveSessao(sess);
    setView('venda');
    showToast(`Pedido ${String(p.numero).padStart(4, '0')} reaberto — gere um novo pedido ao finalizar`);
  };

  const sair = () => {
    if (!window.confirm('Sair do sistema MAX FOTO?')) return;
    setUser(null);
    setCart({ items: [], products: [] });
    setDesconto(null);
    setEditingPedido(null);
    setPrintState(null);
    setActiveSessao(null);
    setView('painel');
  };

  return (
    <div>
      {user === null ? (
        <LoginScreen onLogin={setUser} showToast={showToast} />
      ) : (
        <>
          {effectiveView === 'caixa' && (
            <CaixaScreen caixa={caixa} onCaixaChange={setCaixa} onDone={() => setView('painel')} showToast={showToast} />
          )}
          {effectiveView === 'painel' && (
            <PainelScreen
              user={user}
              sessoes={sessoes}
              health={health}
              conn={conn}
              onOpenSessao={abrirVenda}
              onCaixa={() => setView('caixa')}
              onPedidos={() => setView('pedidos')}
              onRefresh={refreshSessoes}
              onSair={sair}
              showToast={showToast}
            />
          )}
          {effectiveView === 'venda' && activeSessao && (
            <VendaScreen
              key={activeSessao.id}
              sessao={activeSessao}
              user={user}
              health={health}
              conn={conn}
              cart={cart}
              onCart={setCart}
              desconto={desconto}
              onDesconto={setDesconto}
              editingPedido={editingPedido}
              onCheckout={finalizarVenda}
              onBack={() => setView('painel')}
              onCaixa={() => setView('caixa')}
              onPedidos={() => setView('pedidos')}
              onSair={sair}
              showToast={showToast}
            />
          )}
          {effectiveView === 'checkout' && activeSessao && (
            <CheckoutScreen
              sessao={activeSessao}
              cart={cart}
              caixa={caixa}
              health={health}
              user={user}
              desconto={desconto}
              editingPedido={editingPedido}
              printState={printState}
              onPrintStart={setPrintState}
              onDone={() => {
                setCart({ items: [], products: [] });
                setDesconto(null);
                setEditingPedido(null);
                setPrintState(null);
                setActiveSessao(null);
                setView('painel');
              }}
              onCancel={() => setView('venda')}
              showToast={showToast}
            />
          )}
          {effectiveView === 'pedidos' && (
            <PedidosScreen
              user={user}
              conn={conn}
              health={health}
              onReabrirPedido={reabrirPedido}
              onBack={() => setView('painel')}
              showToast={showToast}
            />
          )}
        </>
      )}
      {toast && <div className={`toast${toast.type === 'error' ? ' error' : ''}`}>{toast.msg}</div>}
    </div>
  );
}