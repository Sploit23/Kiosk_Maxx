import { useState } from 'react';
import { Maximize2, Minimize2, Wallet, Receipt } from 'lucide-react';
import { LOJA } from '../catalog';

export default function TopBar({ user, conn, health, center, rightExtra, onCaixa, onPedidos, onSair }) {
  const [full, setFull] = useState(false);

  const toggleFullscreen = () => {
    setFull((prev) => {
      const next = !prev;
      window.natal?.ipcInvoke(next ? 'natal:enterFullscreen' : 'natal:exitFullscreen').catch(() => {});
      return next;
    });
  };

  const dot = conn === 'alive' ? 'dot-alive' : conn === 'dead' ? 'dot-dead' : 'dot-conn';

  return (
    <header className="kiosk-top">
      <div className="k-brand">
        <div className="k-logo">M</div>
        <div className="name">
          {LOJA.nome}
          <small>{LOJA.evento} · {LOJA.local}</small>
        </div>
      </div>

      <div className="k-center">{center}</div>

      <div className="k-right">
        <span className="k-chip" style={{ cursor: 'default' }}>
          <span className={`pulse-dot ${dot}`} style={{ width: 7, height: 7, margin: 0 }} />
          {conn === 'alive' ? <>Ribbon <strong>{health?.ribbon ?? '?'}</strong></> : 'Sem conexão'}
        </span>
        {onCaixa && (
          <span className="k-chip" onClick={onCaixa} title="Caixa"><Wallet size={14} /> CAIXA</span>
        )}
        {onPedidos && (
          <span className="k-chip" onClick={onPedidos} title="Pedidos"><Receipt size={14} /> PEDIDOS</span>
        )}
        <span className="k-chip gold"><UserIcon /> {user?.nome || ''}</span>
        <span className="k-chip icon" onClick={toggleFullscreen} title="Tela cheia">
          {full ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </span>
        {onSair && (
          <button className="btn-navy small" style={{ padding: '7px 14px', borderRadius: '999px' }} onClick={onSair}>
            SAIR
          </button>
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