import { useMemo, useState } from 'react';
import { Plus, Pencil, ShoppingCart, BadgePercent, Camera, RotateCw, X } from 'lucide-react';
import config from '@shared/config';
import natalApi from '@shared/api/natalApi';
import { calculateCart } from '@shared/utils/pricing';
import { formatBRL } from '@shared/utils/imageUtils';
import AdjustFraming from '@shared/components/AdjustFraming';
import TopBar from '../components/TopBar';
import { numeroSessao, DESCONTOS_CATALOGO, valorDesconto, SENHA_MASTER } from '../catalog';

const SVG_PLACEHOLDER = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI0MCIgaGVpZ2h0PSIzNCI+PHJlY3QgeD0iNiIgeT0iNCIgd2lkdGg9IjI4IiBoZWlnaHQ9IjI2IiByeD0iMyIgZmlsbD0iI2U4ZWRmNSIgc3Ryb2tlPSIjYy1jIiBzdHJva2Utd2lkdGg9IjIiLz48L3N2Zz4=';

export default function VendaScreen({
  sessao, user, health, conn, cart, onCart, desconto, onDesconto, editingPedido,
  onCheckout, onBack, onCaixa, onPedidos, onSair, showToast,
}) {
  const [tamanho, setTamanho] = useState('10x15');
  const [selectedName, setSelectedName] = useState(null);
  const [adjusting, setAdjusting] = useState(null);
  const [descModal, setDescModal] = useState(null);
  const [master, setMaster] = useState({ senha: '', motivo: '', valor: '' });
  const [masterErr, setMasterErr] = useState('');

  const fotos = sessao?.fotos || [];
  const filenameOf = (f) => f.filename || f.name;

  const selectedFoto = (sessao?.fotos || []).find((f) => (f.name || f.filename) === selectedName) || null;

  const resumo = useMemo(() => calculateCart(cart), [cart]);
  const totalPagar = +Math.max(0, resumo.total - (desconto?.valor || 0)).toFixed(2);
  const cartCount = cart.items.reduce((a, i) => a + i.qty, 0) + cart.products.reduce((a, i) => a + i.qty, 0);
  const subtotalBase = useMemo(() => {
    const fotos = cart.items.reduce((acc, i) => acc + (config.getPreco(i.key) * i.qty), 0);
    const prod = cart.products.reduce((acc, i) => acc + (config.getPreco(i.key) * i.qty), 0);
    return fotos + prod;
  }, [cart]);
  const descontoCombo = Math.max(0, subtotalBase - resumo.total);

  const abrirEditor = (foto, mode, item = null) => {
    const filename = filenameOf(foto);
    const url = natalApi.fotoUrl(sessao.id, 'previews', filename);
    const base = { ...foto, filename, url };
    if (mode === 'edit' && item) {
      setAdjusting({
        mode,
        id: item.id,
        foto: {
          ...base,
          key: item.key,
          scale: item.scale,
          diffx: item.diffx,
          diffy: item.diffy,
          angle: item.angle,
          orientation: item.orientation || 'retrato',
        },
      });
    } else {
      setAdjusting({ mode, id: null, foto: { ...base, key: tamanho } });
    }
  };

  const onFramingComplete = (edited) => {
    const f = edited[0];
    if (!f) return;
    if (adjusting?.mode === 'edit' && adjusting.id) {
      onCart((prev) => ({
        ...prev,
        items: prev.items.map((i) =>
          i.id === adjusting.id
            ? { ...i, key: f.key, scale: f.scale, diffx: f.diffx, diffy: f.diffy, angle: f.angle, orientation: f.orientation }
            : i
        ),
      }));
      showToast('Enquadramento atualizado');
    } else {
      const item = {
        id: `${f.filename}__${f.key}__${Date.now()}`,
        key: f.key,
        filename: f.filename,
        qty: 1,
        url: f.url,
        scale: f.scale,
        diffx: f.diffx,
        diffy: f.diffy,
        angle: f.angle,
        orientation: f.orientation,
      };
      onCart((prev) => ({ ...prev, items: [...prev.items, item] }));
      showToast(`${config.getFormat(f.key).label} adicionada ao carrinho`);
    }
    setAdjusting(null);
  };

  const addProduto = (key) => {
    onCart((prev) => {
      const exists = prev.products.find((p) => p.key === key);
      const rest = prev.products.filter((p) => p.key !== key);
      return { ...prev, products: [...rest, { key, qty: (exists?.qty || 0) + 1 }] };
    });
  };

  const setFotoQty = (id, qty) => {
    onCart((prev) => {
      const items = prev.items.map((i) => (i.id === id ? { ...i, qty: Math.max(1, qty) } : i)).filter((i) => i.qty > 0);
      return { ...prev, items };
    });
  };
  const removeFoto = (id) => onCart((prev) => ({ ...prev, items: prev.items.filter((i) => i.id !== id) }));
  const setProdutoQty = (key, qty) => {
    onCart((prev) => {
      const rest = prev.products.filter((p) => p.key !== key);
      return { ...prev, products: qty > 0 ? [...rest, { key, qty }] : rest };
    });
  };

  const aplicarDescontoCatalogo = (d) => {
    if (desconto) return;
    const valor = valorDesconto(d, resumo.total);
    onDesconto({ id: d.id, nome: d.nome, tipo: d.tipo, valor });
    setDescModal(null);
    showToast(`Desconto "${d.nome}" aplicado (${formatBRL(valor)})`);
  };

  const aplicarDescontoMaster = () => {
    const valor = parseFloat((master.valor || '0').replace(',', '.'));
    if (master.senha !== SENHA_MASTER) { setMasterErr('Senha master incorreta'); return; }
    if (!master.motivo.trim()) { setMasterErr('Informe o motivo (obrigatório)'); return; }
    if (!valor || valor <= 0) { setMasterErr('Valor inválido'); return; }
    if (valor > resumo.total) { setMasterErr('Desconto maior que o total do pedido'); return; }
    onDesconto({ id: 'master', nome: 'Desconto fora do catálogo', tipo: 'fixo', valor, motivo: master.motivo.trim() });
    setDescModal(null);
    setMaster({ senha: '', motivo: '', valor: '' });
    setMasterErr('');
    showToast(`Desconto fora do catálogo aplicado — motivo registrado (${user?.nome || '—'})`);
  };

  const clickFoto = (foto) => {
    const name = filenameOf(foto);
    setSelectedName(name);
    if (adjusting?.mode === 'add') {
      setAdjusting((prev) => ({ ...prev, foto: { ...prev.foto, ...foto, filename: name } }));
    }
  };

  const clickTamanho = (key) => {
    setTamanho(key);
    if (selectedFoto) abrirEditor(selectedFoto, 'add');
    else showToast('Clique em uma foto para começar');
  };

  return (
    <div className="screen screen-venda screen-enter">
      <TopBar
        user={user}
        conn={conn}
        health={health}
        onCaixa={onCaixa}
        onPedidos={onPedidos}
        onSair={onSair}
        rightExtra={<span className="k-chip ghost" onClick={onBack}>← VOLTAR</span>}
        center={
          <span className="k-chip gold" style={{ cursor: 'default' }}>
            VENDA · SESSÃO <strong>{numeroSessao(sessao.id)}</strong> · {fotos.length} FOTOS
          </span>
        }
      />

      <div className="screen-body">
        {/* ─── Left panel: sessão + fotos + carrinho ─── */}
        <aside className="left-panel">
          <div className="lp-head">
            <button className="lp-back" onClick={onBack}>← VOLTAR</button>
            <div className="lp-senha">Sessão {numeroSessao(sessao.id)}</div>
            <div className="lp-meta">
              {fotos.length} fotos · aberta {new Date(sessao.criadaEm).toLocaleTimeString('pt-BR')}
              {editingPedido ? ` · reabertura do pedido ${String(editingPedido.numero).padStart(4, '0')}` : ''}
            </div>
          </div>

          <div className="thumb-strip">
            {fotos.map((f) => {
              const name = filenameOf(f);
              const url = natalApi.fotoUrl(sessao.id, 'previews', name);
              const active = selectedName === name;
              const inCart = cart.items.some((i) => i.filename === name);
              return (
                <div key={name} className={`thumb${active ? ' selected' : ''}`} onClick={() => clickFoto(f)}>
                  <img src={url} alt="" loading="lazy" />
                  {inCart && <div className="in-cart-badge">✓</div>}
                </div>
              );
            })}
            {fotos.length === 0 && (
              <div className="cart-empty" style={{ gridColumn: '1 / -1' }}>
                Nenhuma foto ainda.<br />Aguarde a transferência do fotógrafo.
              </div>
            )}
          </div>

          <div className="cart-panel">
            <div className="cart-head">
              <h3>Carrinho</h3>
              <span className="cart-count">{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
            </div>
            <div className="cart-items">
              {resumo.fotos.map((item) => (
                <div key={item.id} className="cart-item">
                  <div className="ci-top">
                    <img src={item.url} alt="" />
                    <div className="ci-info">
                      <div className="ci-label">{config.getFormat(item.key).label}</div>
                      <div className="ci-price">{item.filename}</div>
                    </div>
                    <button className="ci-remove" title="Remover" onClick={() => removeFoto(item.id)}>×</button>
                  </div>
                  <div className="ci-qty">
                    <button onClick={() => setFotoQty(item.id, item.qty - 1)}>−</button>
                    <span>{item.qty}</span>
                    <button onClick={() => setFotoQty(item.id, item.qty + 1)}>+</button>
                    <span className="ci-unit">{formatBRL(item.subtotal)}</span>
                    <button
                      style={{ background: 'none', border: 'none', color: 'var(--slate-500)', padding: '0 2px', width: 'auto', height: 'auto' }}
                      title="Ajustar enquadramento"
                      onClick={() => abrirEditor({ name: item.filename, filename: item.filename }, 'edit', item)}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                </div>
              ))}
              {resumo.prod.map((item) => (
                <div key={item.key} className="cart-item">
                  <div className="ci-top">
                    <img src={SVG_PLACEHOLDER} alt="" />
                    <div className="ci-info">
                      <div className="ci-label">{config.getProduto(item.key).label}</div>
                      <div className="ci-price">Unidade · {formatBRL(item.unitPrice)}</div>
                    </div>
                    <button className="ci-remove" title="Remover" onClick={() => setProdutoQty(item.key, 0)}>×</button>
                  </div>
                  <div className="ci-qty">
                    <button onClick={() => setProdutoQty(item.key, item.qty - 1)}>−</button>
                    <span>{item.qty}</span>
                    <button onClick={() => setProdutoQty(item.key, item.qty + 1)}>+</button>
                    <span className="ci-unit">{formatBRL(item.subtotal)}</span>
                  </div>
                </div>
              ))}
              {cartCount === 0 && (
                <div className="cart-empty">Carrinho vazio.<br />Clique em uma foto e escolha o formato.</div>
              )}
            </div>
            <div className="cart-footer">
              <button className="btn-desconto-venda" disabled={cartCount === 0 || !!desconto} onClick={() => setDescModal('catalogo')}>
                <BadgePercent size={12} style={{ verticalAlign: '-1px' }} /> {desconto ? 'Desconto aplicado' : descontoCombo > 0 ? `Combo de papel ativo · ${formatBRL(descontoCombo)}` : 'Aplicar desconto'}
              </button>
              {desconto && (
                <div className="cart-total-row">
                  <span className="lbl">
                    {desconto.nome} <button className="k-chip ghost" style={{ padding: '1px 6px', fontSize: '9px' }} onClick={() => onDesconto(null)}><X size={9} /> remover</button>
                  </span>
                  <span style={{ color: 'var(--green-300)', fontWeight: 700 }}>− {formatBRL(desconto.valor)}</span>
                </div>
              )}
              <div className="cart-total-row">
                <span className="lbl">Total</span>
                <span className="val">{formatBRL(totalPagar)}</span>
              </div>
              <button className="btn-finalizar" disabled={cartCount === 0} onClick={onCheckout}>
                <ShoppingCart size={16} /> FINALIZAR VENDA · {formatBRL(totalPagar)}
              </button>
            </div>
          </div>
        </aside>

        {/* ─── Área de trabalho ─── */}
        <section className="work-area">
          <div className="wa-top">
            <h2>
              {adjusting
                ? 'Ajuste o enquadramento e clique em "Conferida"'
                : selectedFoto
                  ? 'Selecione um formato ao lado para ajustar o enquadramento'
                  : 'Clique em uma foto para começar'}
            </h2>
          </div>
          {editingPedido?.numero && (
            <div className="reopen-note">
              ♻ Pedido {String(editingPedido.numero).padStart(4, '0')} reaberto — ao finalizar, gera um pedido novo vinculado ao original.
            </div>
          )}

          <div className="wa-body">
            <div className="photo-column">
              {selectedFoto && !adjusting && (
                <div className="size-badge">
                  {config.getFormat(tamanho).label} · {formatBRL(config.getPreco(tamanho))}
                </div>
              )}
              <div className="frame-zone">
                {adjusting ? (
                  <div className="adjust-frame">
                    <AdjustFraming
                      photos={[adjusting.foto]}
                      single
                      formatKey={adjusting.foto.key}
                      maxPreview={{ w: 880, h: 620 }}
                      onBack={() => setAdjusting(null)}
                      onComplete={onFramingComplete}
                    />
                  </div>
                ) : selectedFoto ? (
                  <div className="venda-preview">
                    <span className="selName"><Camera size={11} style={{ verticalAlign: '-1px' }} /> {filenameOf(selectedFoto)}</span>
                    <div className="photoBox" style={{ aspectRatio: `${config.getFormat(tamanho).printRes.width} / ${config.getFormat(tamanho).printRes.height}` }}>
                      <img src={natalApi.fotoUrl(sessao.id, 'previews', filenameOf(selectedFoto))} alt="" />
                    </div>
                    <div className="frameTag">{config.getFormat(tamanho).label} · {formatBRL(config.getPreco(tamanho))}</div>
                  </div>
                ) : (
                  <div className="hint-select">
                    <div className="big">Clique em uma foto para começar</div>
                    <p style={{ color: 'var(--slate-400)', fontSize: '13px', lineHeight: 1.5, margin: '10px 0 14px' }}>
                      Escolha a foto na coluna da esquerda, selecione o tamanho e ajuste o
                      enquadramento antes de adicionar ao carrinho.
                    </p>
                    <span className="oc-select-btn" style={{ pointerEvents: 'none', background: 'var(--navy-800)', border: '1px solid var(--gold-500)', color: 'var(--gold-300)' }}>
                      <Camera size={13} style={{ verticalAlign: '-2px' }} /> FOTOS DA SESSÃO {numeroSessao(sessao.id)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* side controls */}
            <div className="side-controls">
              <div className="option-group">
                <h4>Tamanhos <span style={{ color: 'var(--slate-500)' }}>({config.formatList().length})</span></h4>
                <div className="option-cards">
                  {config.formatList().map((f) => (
                    <div key={f.key} className={`option-card${tamanho === f.key ? ' selected' : ''}`} onClick={() => clickTamanho(f.key)}>
                      <div className="oc-left">
                        <div className="oc-name">{f.label}</div>
                        <div className="oc-price">{f.overlay ? 'Molde personalizado' : 'Foto em brilho'}</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <span className="oc-price" style={{ fontFamily: "'Fraunces',serif", fontSize: '14px', color: 'var(--gold-300)', fontWeight: '700' }}>
                          {formatBRL(f.price)}
                        </span>
                        <RotateCw size={13} style={{ color: '#4b5a7c' }} />
                        <button
                          type="button"
                          className={`oc-select-btn${tamanho === f.key ? ' is-selected' : ''}`}
                          onClick={(e) => { e.stopPropagation(); clickTamanho(f.key); }}
                        >
                          {tamanho === f.key ? 'Selecionado' : 'Selecionar'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="option-group">
                <h4>Produtos extras</h4>
                <div className="option-cards">
                  {config.produtoList().map((prod) => {
                    const qty = cart.products.find((p) => p.key === prod.key)?.qty || 0;
                    return (
                      <div key={prod.key} className="option-card">
                        <div className="oc-left">
                          <div className="oc-name">{prod.label}</div>
                          <div className="oc-price">Unidade · {formatBRL(prod.price)}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                          {qty > 0 && <span className="prod-qty">{qty}x</span>}
                          <button type="button" className="oc-select-btn" onClick={() => addProduto(prod.key)}>
                            <Plus size={11} style={{ verticalAlign: '-1px' }} /> Adicionar
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="option-group">
                <button className="btn-desconto-venda" style={{ padding: '11px', margin: 0 }} disabled={cartCount === 0 || !!desconto} onClick={() => setDescModal('catalogo')}>
                  <BadgePercent size={13} style={{ verticalAlign: '-1px' }} /> {desconto ? 'Desconto aplicado' : 'Aplicar desconto'}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>

      {/* ─── Modal de desconto (catálogo + senha master) ─── */}
      {descModal === 'catalogo' && (
        <div className="ovl" onClick={() => setDescModal(null)}>
          <div className="ovl-card" onClick={(e) => e.stopPropagation()}>
            <div className="ovl-head">
              <div>
                <div className="modal-step-label">Antes de finalizar</div>
                <h3>Aplicar desconto</h3>
              </div>
              <button className="ovl-close" onClick={() => setDescModal(null)}><X size={16} /></button>
            </div>
            <p className="modal-sub">Descontos pré-cadastrados nesta loja — selecione um. Só um desconto por pedido.</p>
            <div style={{ display: 'grid', gap: '10px', marginTop: '12px' }}>
              {DESCONTOS_CATALOGO.map((d) => {
                const elegivel = resumo.total >= (d.minimo || 0);
                const valor = valorDesconto(d, resumo.total);
                return (
                  <button key={d.id} className="desc-card" disabled={!elegivel} onClick={() => aplicarDescontoCatalogo(d)}>
                    <span>
                      <span className="desc-nome">{d.nome}</span>
                      <span className="desc-detalhe">{elegivel ? `Desconto de ${formatBRL(valor)}` : `Abaixo do mínimo (${formatBRL(d.minimo)})`}</span>
                    </span>
                    <span className="desc-add">{elegivel ? 'Aplicar' : '—'}</span>
                  </button>
                );
              })}
            </div>
            <div className="modal-sub" style={{ borderTop: '1px solid var(--navy-line)', paddingTop: '12px', marginTop: '14px' }}>
              Precisa de um desconto fora do catálogo (caso excepcional)? Exige senha master.
            </div>
            <button className="btn-secondary" style={{ width: '100%', marginTop: '10px' }} onClick={() => setDescModal('senha')}>
              Usar senha master (exceção)
            </button>
          </div>
        </div>
      )}

      {descModal === 'senha' && (
        <div className="ovl" onClick={() => { setDescModal('catalogo'); setMasterErr(''); }}>
          <div className="ovl-card" onClick={(e) => e.stopPropagation()}>
            <div className="ovl-head">
              <div>
                <div className="modal-step-label">Autorização necessária</div>
                <h3>Desconto fora do catálogo</h3>
              </div>
              <button className="ovl-close" onClick={() => { setDescModal('catalogo'); setMasterErr(''); }}><X size={16} /></button>
            </div>
            <p className="modal-sub">
              Caso excepcional — informe a senha master da loja, o valor e o motivo. Fica registrado no pedido.
            </p>
            <input
              className="ovl-field"
              type="password"
              maxLength="4"
              placeholder="Senha master (4 dígitos)"
              value={master.senha}
              onChange={(e) => setMaster({ ...master, senha: e.target.value.trim() })}
            />
            <input
              className="ovl-field"
              type="number"
              min="0"
              step="0.01"
              placeholder="Valor do desconto em R$"
              value={master.valor}
              onChange={(e) => setMaster({ ...master, valor: e.target.value })}
            />
            <textarea
              className="ovl-field"
              rows="2"
              placeholder="Motivo (obrigatório)"
              value={master.motivo}
              onChange={(e) => setMaster({ ...master, motivo: e.target.value })}
              style={{ resize: 'vertical' }}
            />
            {masterErr && <p className="muted small" style={{ color: '#ffb3b5', marginTop: '10px' }}>{masterErr}</p>}
            <button className="btn-primary" style={{ width: '100%', marginTop: '14px' }} onClick={aplicarDescontoMaster}>
              Confirmar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}