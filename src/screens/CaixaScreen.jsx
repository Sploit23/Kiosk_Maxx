import { useState } from 'react';
import { Wallet, LogOut, CheckCircle2 } from 'lucide-react';
import natalApi from '@shared/api/natalApi';
import config from '@shared/config';
import { formatBRL, formatDateTime } from '@shared/utils/imageUtils';
import { LOJA } from '../catalog';

export default function CaixaScreen({ caixa, onCaixaChange, onDone, showToast }) {
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
      <div className="login-screen screen-enter">
        <div className="login-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '20px' }}>
            <div style={{ background: 'rgba(255,193,69,.14)', borderRadius: '14px', padding: '11px' }}>
              <Wallet size={30} color="#ffc145" />
            </div>
            <div>
              <h1 style={{ margin: 0, fontSize: '1.4rem' }}>Abrir caixa</h1>
              <p className="muted small" style={{ margin: '2px 0 0' }}>{LOJA.nome} · {config.eventName}</p>
            </div>
          </div>
          <div className="field">
            <label>Operador</label>
            <input autoFocus value={operador} onChange={(e) => setOperador(e.target.value)} placeholder="Nome do operador" />
          </div>
          <div className="field">
            <label>Valor inicial em dinheiro (R$)</label>
            <input inputMode="decimal" value={valorInicial} onChange={(e) => setValorInicial(e.target.value)} placeholder="0,00" />
          </div>
          <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={abrir} disabled={busy}>
            {busy ? 'Abrindo…' : 'Abrir caixa'}
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
      <div className="topbar">
        <div>
          <h1>Caixa</h1>
          <div className="sub">{LOJA.nome} · {config.eventName}</div>
        </div>
        <span className="status-pill" style={{ background: 'rgba(255,193,69,.16)', color: '#ffd98a' }}>
          {fechado ? 'Fechado' : 'Aberto'} · {caixa.operador}
        </span>
      </div>
      <div className="content" style={{ maxWidth: '720px', margin: '0 auto', width: '100%' }}>
        <div className="card" style={{ marginBottom: '16px' }}>
          <div className="muted small">Aberto em</div>
          <div className="serif" style={{ fontWeight: 900, fontSize: '1.1rem' }}>{formatDateTime(caixa.abertoEm)}</div>
          <div className="muted small mt-16">Inicial em dinheiro</div>
          <div className="serif" style={{ fontWeight: 900, fontSize: '1.5rem', color: 'var(--gold)' }}>{formatBRL(caixa.valorInicial ?? 0)}</div>
        </div>

        <div className="card" style={{ marginBottom: '16px' }}>
          <h3>Vendas deste turno</h3>
          <div className="pay-grid">
            {config.meiosPagamento.map((m) => (
              <div key={m.key} className="card" style={{ padding: '14px', textAlign: 'center' }}>
                <div className="muted small">{m.label}</div>
                <div style={{ fontWeight: 900, fontSize: '1.15rem', color: 'var(--white)' }}>{formatBRL(meiosDoCaixa[m.key] ?? 0)}</div>
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
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', color: 'var(--gold)', fontWeight: 800, fontSize: '1.3rem' }}>
              <CheckCircle2 size={26} /> Caixa fechado
            </div>
            <p className="muted small mt-8">Diferença: {formatBRL(caixa.diferenca ?? 0)}</p>
            <button className="btn btn-primary btn-lg" style={{ width: '100%' }} onClick={onDone}>OK</button>
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
            <div className="total-bar" style={{ background: diff === 0 ? 'rgba(255,193,69,.14)' : diff < 0 ? 'var(--red-bg)' : 'rgba(255,193,69,.14)', borderColor: diff === 0 ? 'rgba(255,193,69,.45)' : 'rgba(255,107,107,.5)', color: diff < 0 ? '#ffb3b5' : '#ffd98a' }}>
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