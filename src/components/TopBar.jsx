import { useEffect, useState } from 'react';
import { Maximize2, Minimize2, Wallet, Receipt } from 'lucide-react';
import { LOJA } from '../catalog';

function tickClock() {
  return new Date().toLocaleTimeString('pt-BR');
}

export default function TopBar({ user, conn, health, center, rightExtra, onCaixa, onPedidos, onSair }) {
  const [full, setFull] = useState(false);
  const [clock, setClock] = useState(tickClock);

  useEffect(() => {
    const t = setInterval(() => setClock(tickClock()), 1000);
    return () => clearInterval(t);
  }, []);

  const toggleFullscreen = () => {
    setFull((prev) => {
      const next = !prev;
      window.natal?.ipcInvoke(next ? 'natal:enterFullscreen' : 'natal:exitFullscreen').catch(() => {});
      return next;
    });
  };

  const dot = conn === 'alive' ? 'dot-alive' : conn === 'dead' ? 'dot-dead' : 'dot-conn';

  return (
    <header className="topbar">
      <div className="brand">
        <div className="mark">M</div>
        <div className="name">
          {LOJA.nome}
          <span className="loja">{LOJA.evento} · {LOJA.local}</span>
        </div>
      </div>

      <div className="topbar-center">{center}</div>

      <div className="topbar-right">
        <span className="k-chip" style={{ cursor: 'default' }}>
          <span className={`dot ${dot}`} />
          {conn === 'alive' ? <>Ribbon <strong>{health?.ribbon ?? '?'}</strong></> : 'Sem conexão'}
        </span>
        {onCaixa && (
          <span className="k-chip" onClick={onCaixa} title="Caixa"><Wallet size={14} /> CAIXA</span>
        )}
        {onPedidos && (
          <span className="k-chip" onClick={onPedidos} title="Pedidos"><Receipt size={14} /> PEDIDOS</span>
        )}
        <span className="k-chip clock">{clock}</span>
        <span className="k-chip gold"><UserIcon /> {user?.nome || ''}</span>
        <span className="k-chip icon" onClick={toggleFullscreen} title="Tela cheia">
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </span>
        {onSair && (
          <span className="k-chip sair" onClick={onSair}>SAIR</span>
        )}
        {rightExtra}
      </div>
    </header>
  );
}

function UserIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.6-6 8-6s8 2 8 6" />
    </svg>
  );
}