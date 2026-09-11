import { useMemo, useState } from 'react';
import { RefreshCw, ArrowRight } from 'lucide-react';
import TopBar from '../components/TopBar';
import { numeroSessao, marqueeText } from '../catalog';
import { formatTimestamp } from '@shared/utils/imageUtils';
import natalApi from '@shared/api/natalApi';

const ACTIONABLE = ['PRONTA', 'EM_ATENDIMENTO'];

function tagInfo(estado) {
  const map = {
    CRIADA: { cls: 'tag-aguardando', label: 'Aguardando' },
    FOTOGRAFANDO: { cls: 'tag-aguardando', label: 'Fotografando' },
    RECEBENDO: { cls: 'tag-aguardando', label: 'Recebendo' },
    PRONTA: { cls: 'tag-vendida', label: 'Pronta' },
    EM_ATENDIMENTO: { cls: 'tag-vendida', label: 'Em atendimento' },
    VENDIDA: { cls: 'tag-vendida', label: 'Vendida' },
    FINALIZADA: { cls: 'tag-concluida', label: 'Concluída' },
    CANCELADA: { cls: 'tag-abandonada', label: 'Abandonada' },
  };
  return map[estado] || { cls: 'tag-concluida', label: estado };
}

export default function PainelScreen({
  user, sessoes, health, conn,
  onOpenSessao, onCaixa, onPedidos, onRefresh, onSair, showToast,
}) {
  const [filtro, setFiltro] = useState('todas');
  const hoje = new Date().toDateString();
  const daHoje = useMemo(() => sessoes.filter((s) => new Date(s.criadaEm).toDateString() === hoje), [sessoes, hoje]);

  const ordenadas = useMemo(() => {
    const list = [...daHoje].sort((a, b) => new Date(b.criadaEm) - new Date(a.criadaEm));
    const prioridade = (s) => (ACTIONABLE.includes(s.estado) ? 0 : s.estado === 'VENDIDA' ? 1 : 2);
    return list.sort((a, b) => prioridade(a) - prioridade(b) || new Date(b.criadaEm) - new Date(a.criadaEm));
  }, [daHoje]);

  const prontas = ordenadas.filter((s) => ACTIONABLE.includes(s.estado));
  const primeiraPronta = prontas[0];
  const lista = filtro === 'prontas' ? prontas : ordenadas;

  const abrirPronta = () => {
    if (primeiraPronta) onOpenSessao(primeiraPronta);
    else showToast('Nenhuma sessão pronta no momento', 'error');
  };

  const atendidas = ordenadas.filter((s) => s.estado === 'VENDIDA' || s.estado === 'FINALIZADA').length;

  const marqueeFotos = useMemo(() => {
    const urls = [];
    for (const s of sessoes) {
      for (const f of s.fotos || []) {
        const filename = f.filename || f.name;
        if (!filename) continue;
        urls.push(natalApi.fotoUrl(s.id, 'previews', filename));
        if (urls.length >= 14) break;
      }
      if (urls.length >= 14) break;
    }
    return urls;
  }, [sessoes]);

  return (
    <div className="screen screen-painel screen-enter">
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

      <div className="screen-body">
        {/* ─── Coluna de sessões ─── */}
        <aside className="sessions-col">
          <div className="col-head">
            <h2>Sessões — Hoje</h2>
            <p>Sessões gravadas pelo fotógrafo. Clique para atender.</p>
            <select className="date-select" value={filtro} onChange={(e) => setFiltro(e.target.value)}>
              <option value="todas">Hoje · todas as sessões</option>
              <option value="prontas">Hoje · prontas p/ venda</option>
            </select>
          </div>
          <div className="session-filters">
            <span className={`filter-pill${filtro === 'todas' ? ' active' : ''}`} onClick={() => setFiltro('todas')}>
              Todas <b>{ordenadas.length}</b>
            </span>
            <span className={`filter-pill${filtro === 'prontas' ? ' active' : ''}`} onClick={() => setFiltro('prontas')}>
              Prontas <b>{prontas.length}</b>
            </span>
          </div>
          <div className="session-list">
            {lista.length === 0 && (
              <div className="cart-empty">
                {filtro === 'prontas'
                  ? 'Nenhuma sessão pronta para venda.'
                  : 'Nenhuma sessão gravada hoje.\nAguarde o fotógrafo transferir.'}
              </div>
            )}
            {lista.map((s) => {
              const t = tagInfo(s.estado);
              const fechada = s.estado === 'FINALIZADA' || s.estado === 'CANCELADA';
              return (
                <div
                  key={s.id}
                  className={`session-card${fechada ? ' is-finalizada' : ''}`}
                  onClick={() => onOpenSessao(s)}
                >
                  <div className="sc-top">
                    <div>
                      <div className="sc-senha">#{numeroSessao(s.id)}</div>
                      <div className="sc-hora">aberta às {formatTimestamp(s.criadaEm)}</div>
                    </div>
                    <div className={`sc-tag ${t.cls}`}>{t.label}</div>
                  </div>
                  <div className="sc-bottom">
                    <div className="sc-fotos">
                      {s.fotosQtd ?? s.fotos?.length ?? 0} fotos
                      {s.operadorFotografo ? ` · ${s.operadorFotografo}` : ''}
                    </div>
                    {ACTIONABLE.includes(s.estado) && <span className="sc-fotos" style={{ color: 'var(--gold-300)', fontWeight: 700 }}>abrir →</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </aside>

        {/* ─── Área principal (vitrine) ─── */}
        <div className="idle-area">
          {marqueeFotos.length > 0 && (
            <div className="idle-marquee">
              <div className="idle-marquee-track">
                {[...marqueeFotos, ...marqueeFotos].map((url, i) => (
                  <img key={`${i}-${url}`} src={url} alt="" loading="lazy" />
                ))}
              </div>
            </div>
          )}

          <div className="eyebrow">Maxx Foto · Natal 2026</div>
          <h1>Bem-vinda ao painel de vendas</h1>
          <p>
            {prontas.length > 0
              ? `${prontas.length} sessões prontas esperando atendimento. Clique em uma sessão para começar a vender.`
              : 'As sessões prontas para venda aparecerão aqui assim que o fotógrafo transferir as fotos.'}
          </p>

          <div className="idle-stats">
            <div className="idle-stat">
              <div className="n">{daHoje.length}</div>
              <div className="l">sessões hoje</div>
            </div>
            <div className="idle-stat">
              <div className="n">{prontas.length}</div>
              <div className="l">prontas p/ venda</div>
            </div>
            <div className="idle-stat">
              <div className="n">{atendidas}</div>
              <div className="l">sessões atendidas</div>
            </div>
          </div>

          <div className="idle-cta">
            <span className="cta-cap">pronta para vender</span>
            <button className="btn-primary" disabled={!primeiraPronta} onClick={abrirPronta}>
              INICIAR NOVA VENDA <ArrowRight size={18} />
            </button>
            <span className="cta-cap">
              {primeiraPronta
                ? `Sessão ${numeroSessao(primeiraPronta.id)} · ${primeiraPronta.fotosQtd ?? primeiraPronta.fotos?.length ?? 0} fotos`
                : 'aguardando sessão…'}
            </span>
          </div>

          <div className="idle-hint">Duas sessões prontas? Atenda uma por vez.</div>
        </div>
      </div>
    </div>
  );
}