import { useMemo } from 'react';
import { RefreshCw, ArrowRight, Camera } from 'lucide-react';
import TopBar from '../components/TopBar';
import { numeroSessao, tagClasse, tagLabel, marqueeText } from '../catalog';
import { formatTimestamp } from '@shared/utils/imageUtils';

const ACTIONABLE = ['PRONTA', 'EM_ATENDIMENTO'];

export default function PainelScreen({
  user, sessoes, health, conn,
  onOpenSessao, onCaixa, onPedidos, onRefresh, onSair, showToast,
}) {
  const hoje = new Date().toDateString();
  const daHoje = useMemo(() => sessoes.filter((s) => new Date(s.criadaEm).toDateString() === hoje), [sessoes, hoje]);

  const ordenadas = useMemo(() => {
    const list = [...sessoes].sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
    const prioridade = (s) => (ACTIONABLE.includes(s.estado) ? 0 : s.estado === 'VENDIDA' ? 1 : 2);
    return list.sort((a, b) => prioridade(a) - prioridade(b) || new Date(b.criadaEm) - new Date(a.criadaEm));
  }, [sessoes]);

  const prontas = ordenadas.filter((s) => ACTIONABLE.includes(s.estado));

  const primeiraPronta = prontas[0];

  const abrirPronta = () => {
    if (primeiraPronta) onOpenSessao(primeiraPronta);
    else showToast('Nenhuma sessão pronta no momento', 'error');
  };

  return (
    <div className="painel-screen screen-enter">
      <TopBar
        user={user}
        conn={conn}
        health={health}
        onCaixa={onCaixa}
        onPedidos={onPedidos}
        onSair={onSair}
        rightExtra={<span className="k-chip icon" onClick={onRefresh} title="Atualizar"><RefreshCw size={15} /></span>}
        center={
          <div className="marquee-chip">
            <span className="orn">✦</span> {marqueeText()} <span className="orn">✦</span>
          </div>
        }
      />

      <div className="painel-body">
        {/* ─── Rail de sessões ─── */}
        <aside className="painel-left">
          <div className="rail-title">
            Sessões de hoje <span className="badge">{daHoje.length}</span>
          </div>
          {daHoje.map((s) => (
            <div key={s.id} className="rail-session" onClick={() => onOpenSessao(s)}>
              <div className="num">{numeroSessao(s.id)}</div>
              <span className="time">{formatTimestamp(s.criadaEm)}</span>
              <div className="info">
                <Camera size={12} /> <strong>{s.fotosQtd}</strong> fotos
              </div>
              <div className="info" style={{ justifyContent: 'space-between' }}>
                <span>{s.operadorFotografo || '—'}</span>
                <span className={`status-tag ${tagClasse(s.estado)}`} style={{ fontSize: '8px', letterSpacing: '.8px' }}>{tagLabel(s.estado)}</span>
              </div>
            </div>
          ))}
          {daHoje.length === 0 && (
            <p className="muted small center" style={{ margin: '24px 6px' }}>
              Nenhuma sessão hoje.<br />Aguarde o fotógrafo transferir as fotos.
            </p>
          )}
          <button className="btn-navy" style={{ width: '100%', marginTop: '6px' }} onClick={onRefresh}>
            <RefreshCw size={14} /> ATUALIZAR LISTA
          </button>
        </aside>

        {/* ─── Área principal ─── */}
        <main className="painel-main">
          <section className="hero">
            <div className="hi">
              <h2>Bem-vinda ao <span className="gold">{'MAX FOTO'}</span></h2>
              <p>Sessões prontas para atendimento: <strong style={{ color: '#ffd98a' }}>{prontas.length}</strong> · Fotos aguardando venda.</p>
              <div className="orn-line">✦ ✧ ✦ ✧ ✦</div>
            </div>
            <div className="cta">
              <small>PRONTA PARA VENDER</small>
              <button className="btn-gold" onClick={abrirPronta} disabled={!primeiraPronta}>
                INICIAR NOVA VENDA <ArrowRight size={18} />
              </button>
              <small style={{ color: '#5a6a8c' }}>{primeiraPronta ? `Sessão ${numeroSessao(primeiraPronta.id)} · ${primeiraPronta.fotosQtd} fotos` : 'aguardando sessão…'}</small>
            </div>
          </section>

          <div className="section-title">
            {prontas.length > 0 ? <>Sessões <span className="gold">{'prontas para atendimento'}</span></> : <>Sessões <span className="gold">do dia</span></>}
          </div>

          <div className="sess-grid">
            {(prontas.length ? prontas : ordenadas.slice(0, 8)).map((s) => (
              <div
                key={s.id}
                className="sess-card"
                onClick={() => onOpenSessao(s)}
                onDoubleClick={() => onOpenSessao(s)}
              >
                <div className="top">
                  <div className="num">{numeroSessao(s.id)}</div>
                  <span className={`status-tag ${tagClasse(s.estado)}`}>{tagLabel(s.estado)}</span>
                </div>
                <div className="fotos"><b>{s.fotosQtd}</b> fotos · {s.fotos?.length ?? '—'}</div>
                <div className="meta">
                  Família: <b>{s.familia || '—'}</b> · Fotógrafo: <b>{s.operadorFotografo || '—'}</b>
                </div>
                <div className="foot">
                  <span style={{ fontSize: '11px', color: 'var(--muted)', fontWeight: 700 }}>
                    Aberta {formatTimestamp(s.criadaEm)} {new Date(s.criadaEm).toDateString() === hoje ? '' : '(' + new Date(s.criadaEm).toLocaleDateString('pt-BR').slice(0, 5) + ')'}
                  </span>
                  <span className="openBtn">ABRIR VENDA <ArrowRight size={12} /></span>
                </div>
              </div>
            ))}
            {ordenadas.length === 0 && (
              <div className="card" style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center' }}>
                <div className="serif" style={{ fontSize: '20px', fontWeight: 900, marginBottom: '6px' }}>Nenhuma sessão ainda</div>
                <p className="muted small">As sessões aparecerão aqui assim que o fotógrafo transferir as fotos.</p>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}