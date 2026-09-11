import { useState } from 'react';
import { Wallet, LogOut, CheckCircle2, ArrowLeft } from 'lucide-react';
import natalApi from '@shared/api/natalApi';
import config from '@shared/config';
import { formatBRL, formatDateTime } from '@shared/utils/imageUtils';
import TopBar from '../components/TopBar';
import { LOJA } from '../catalog';

export default function CaixaScreen({ caixa, onCaixaChange, onDone, showToast, user, conn, health }) {
  const [operador, setOperador] = useState('');
  const [valorInicial, setValorInicial] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [meios, setMeios] = useState({});
  const [observacoes, setObservacoes] = useState('');

  const abrir = async () => {
    if (!operador.trim()) { showToast('Informe o nome do operador', 'error'); return; }
    setBusy(true);
    const res = await natalApi.caixaAbrir({
      operador: operador.trim(),
      valorInicial: Number(parseFloat(String(valorInicial).replace(',', '.')) || 0),
    });
    setBusy(false);
    if (!res.success) { showToast(res.error || 'Erro ao abrir caixa', 'error'); return; }
    onCaixaChange(res.caixa);
    showToast('Caixa aberto');
  };

  const fechar = async () => {
    setBusy(true);
    const res = await natalApi.caixaFechar({ meios, observacoes });
    setBusy(false);
    if (!res.success) { showToast(res.error || 'Erro ao fechar caixa', 'error'); return; }
    onCaixaChange(res.caixa);
    setConfirmClose(false);
    showToast(`Caixa fechado. Diferença: ${formatBRL(res.caixa.diferenca)}`);
    onDone();
  };

  if (!caixa) {
    return (
      <div className="login-overlay screen-enter">
        <div className="login-box">
          <div className="login-mark">M</div>
          <h1>Abrir caixa</h1>
          <p className="login-sub">{LOJA.nome} · {config.eventName}</p>
          <div className="field">
            <label>Operador</label>
            <input autoFocus value={operador} onChange={(e) => setOperador(e.target.value)} placeholder="Nome do operador" />
          </div>
          <div className="field">
            <label>Valor inicial em dinheiro (R$)</label>
            <input inputMode="decimal" value={valorInicial} onChange={(e) => setValorInicial(e.target.value)} placeholder="0,00" />
          </div>
          <button className="btn-primary btn-primary-grad" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }} onClick={abrir} disabled={busy}>
            <Wallet size={19} /> {busy ? 'Abrindo…' : 'Abrir caixa'}
          </button>
        </div>
      </div>
    );
  }

  const totalVendido = caixa.totalVendido ?? 0;
  const meiosDoCaixa = caixa.totalPorMeio || {};
  const fechado = !!caixa.fechadoEm;
  const declarado = Object.values(meios).reduce((a, b) => a + Number(b || 0), 0);
  const diff = Number((declarado - totalVendido).toFixed(2));

  return (
    <div className="screen screen-enter">
      <TopBar
        user={user}
        conn={conn}
        health={health}
        center={<span className="k-chip gold" style={{ cursor: 'default' }}>CAIXA</span>}
        rightExtra={<span className="k-chip ghost" onClick={onDone}><ArrowLeft size={14} /> VOLTAR</span>}
      />
      <div className="pages-wrap" style={{ maxWidth: '780px', margin: '0 auto', width: '100%' }}>
        <div className="card" style={{ marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
            <div>
              <div className="muted small">Aberto em</div>
              <div className="serif" style={{ fontWeight: 900, fontSize: '1.1rem' }}>{formatDateTime(caixa.abertoEm)}</div>
            </div>
            <span className={`k-chip ${fechado ? '' : 'gold'}`} style={{ cursor: 'default', textTransform: 'uppercase' }}>
              {fechado ? 'Fechado' : 'Aberto'} · {caixa.operador}
            </span>
          </div>
          <div className="muted small mt-16">Inicial em dinheiro</div>
          <div className="serif" style={{ fontWeight: 900, fontSize: '1.5rem', color: 'var(--gold-300)' }}>{formatBRL(caixa.valorInicial ?? 0)}</div>
        </div>

        <div className="card" style={{ marginBottom: '16px' }}>
          <h3>Vendas deste turno</h3>
          <div className="pay-grid">
            {config.meiosPagamento.map((m) => (
              <div key={m.key} className="card" style={{ padding: '14px', textAlign: 'center', margin: 0 }}>
                <div className="muted small">{m.label}</div>
                <div style={{ fontWeight: 900, fontSize: '1.15rem', color: 'var(--cream-100)' }}>{formatBRL(meiosDoCaixa[m.key] ?? 0)}</div>
              </div>
            ))}
          </div>
          <div className="total-bar mt-16">
            <span>Total vendido</span>
            <span>{formatBRL(totalVendido)}</span>
          </div>
        </div>

        {fechado ? (
          <div className="card center">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--gold-300)', fontWeight: 800, fontSize: '1.3rem' }}>
              <CheckCircle2 size={26} /> Caixa fechado
            </div>
            <p className="muted small mt-8">Diferença: {formatBRL(caixa.diferenca ?? 0)}</p>
            <button className="btn-primary btn-primary-grad" style={{ marginTop: '12px' }} onClick={onDone}>OK</button>
          </div>
        ) : confirmClose ? (
          <div className="card">
            <h3>Conferir valores recebidos</h3>
            <div className="pay-grid">
              {config.meiosPagamento.map((m) => (
                <div className="field" key={m.key} style={{ marginBottom: '8px' }}>
                  <label>{m.label}</label>
                  <input inputMode="decimal" value={meios[m.key] ?? ''} onChange={(e) => setMeios((p) => ({ ...p, [m.key]: e.target.value }))} placeholder="0,00" />
                </div>
              ))}
            </div>
            <div className="field">
              <label>Observações</label>
              <input value={observacoes} onChange={(e) => setObservacoes(e.target.value)} />
            </div>
            <div className="total-bar" style={{ background: diff === 0 ? 'rgba(212,162,76,.14)' : diff < 0 ? 'var(--red-bg)' : 'rgba(212,162,76,.14)', borderColor: diff === 0 ? 'rgba(212,162,76,.45)' : 'rgba(255,107,107,.5)', color: diff < 0 ? '#ffb3b5' : '#f2dcb2' }}>
              <span>Conferido</span>
              <span>{formatBRL(declarado)}</span>
            </div>
            <p className="center small" style={{ fontWeight: 700 }}>
              Diferença: {formatBRL(diff)} {diff !== 0 ? '— confira!' : ''}
            </p>
            <div style={{ display: 'flex', gap: '10px', marginTop: '12px' }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => setConfirmClose(false)}>Voltar</button>
              <button className="btn btn-green btn-lg" style={{ flex: 2 }} onClick={fechar} disabled={busy}>
                <LogOut size={20} /> Fechar caixa
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-danger btn-lg" style={{ width: '100%' }} onClick={() => setConfirmClose(true)}>
            Fechar caixa
          </button>
        )}
      </div>
    </div>
  );
}