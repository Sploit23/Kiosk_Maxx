import { useMemo, useState } from 'react';
import { Trash2, Plus, Minus, Pencil, Check, ShoppingCart, Camera, RotateCw, BadgePercent, X } from 'lucide-react';
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

  const limparTudo = () => onCart({ items: [], products: [] });

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
    <div className="venda-grid screen-enter">
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

      {/* ─── Thumbs ─────────────────────────────────────── */}
      <aside className="venda-thumbs">
        <div className="sec-title" style={{ marginTop: 2 }}>Fotos <span className="muted2">{fotos.length}</span></div>
        {fotos.length === 0 ? (
          <p className="muted small center" style={{ marginTop: '18px', lineHeight: 1.5 }}>
            Nenhuma foto ainda.<br />Aguarde a transferência do fotógrafo.
          </p>
        ) : (
          <div className="thumbs-grid">
            {fotos.map((f, idx) => {
              const name = filenameOf(f);
              const url = natalApi.fotoUrl(sessao.id, 'previews', name);
              const active = selectedName === name;
              return (
                <div key={name} className={`k-thumb${active ? ' active' : ''}`} onClick={() => clickFoto(f)}>
                  <img src={url} alt="" loading="lazy" />
                  <span className="n">{String(idx + 1).padStart(2, '0')}</span>
                  {active && selectedFoto && <span className="chk"><Check size={10} color="#ffc145" /></span>}
                </div>
              );
            })}
          </div>
        )}
      </aside>

      {/* ─── Área de trabalho ───────────────────────────── */}
      <section className="venda-work">
        {adjusting ? (
          <div style={{ flex: 1, minHeight: 0, borderRadius: '16px', overflow: 'hidden', border: '1px solid var(--line)' }}>
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
            <div className="photoBox">
              <img src={natalApi.fotoUrl(sessao.id, 'previews', filenameOf(selectedFoto))} alt="" />
            </div>
            <div className="frameTag">{config.getFormat(tamanho).label} · {formatBRL(config.getPreco(tamanho))}</div>
          </div>
        ) : (
          <div className="venda-preview">
            <div className="hint">
              <div className="big">Clique em uma foto para começar</div>
              <p>
                Escolha a foto na coluna da esquerda, selecione o tamanho e ajuste o
                enquadramento antes de adicionar ao carrinho.
              </p>
              <button className="btn-gold-ghost" style={{ pointerEvents: 'none' }}>
                <Camera size={16} /> FOTOS DA SESSÃO {numeroSessao(sessao.id)}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ─── Coluna lateral ─────────────────────────────── */}
      <aside className="venda-side">
        {/* Tamanhos */}
        <div className="sec-title">Formatos <span className="muted2">{config.formatList().length}</span></div>
        {config.formatList().map((f) => (
          <div key={f.key} className={`tam-row${tamanho === f.key ? ' active' : ''}`} onClick={() => clickTamanho(f.key)}>
            <div className="thumb">
              {f.overlay ? <img src={f.overlay.image} alt="" /> : <RotateCw size={14} style={{ margin: '12px auto 0', color: '#5a6a8c' }} />}
            </div>
            <div className="info">
              <b>{f.label}</b>
              <span>{f.overlay ? 'Molde personalizado' : 'Foto em brilho'}</span>
            </div>
            <span className="price">{formatBRL(f.price)}</span>
          </div>
        ))}

        {/* Produtos */}
        <div className="sec-title" style={{ marginTop: '18px' }}>Produtos</div>
        {config.produtoList().map((prod) => {
          const qty = cart.products.find((p) => p.key === prod.key)?.qty || 0;
          return (
            <div key={prod.key} className="prod-row">
              <div className="icon"><img src={SVG_PLACEHOLDER} alt="" /></div>
              <div className="info">
                <b>{prod.label}</b>
                <span>Unidade</span>
              </div>
              <span className="price">{formatBRL(prod.price)}</span>
              {qty > 0 && <span className="prod-qty">{qty}</span>}
              <button className="prod-plus" onClick={() => addProduto(prod.key)}><Plus size={14} /></button>
            </div>
          );
        })}

        {/* Carrinho */}
        {editingPedido && (
          <div className="reopen-note">
            ♻ Pedido {String(editingPedido.numero).padStart(4, '0')} reaberto — ao finalizar, gera um pedido novo vinculado ao original.
          </div>
        )}
        <div className="cart-box">
          <div className="sec-title">
            Carrinho <span className="muted2">{cartCount} {cartCount === 1 ? 'item' : 'itens'}</span>
            {cartCount > 0 && (
              <span className="k-chip ghost" style={{ padding: '3px 8px', fontSize: '9px' }} onClick={limparTudo}>LIMPAR</span>
            )}
          </div>

          <div className="cart-items">
            {resumo.fotos.map((item) => (
              <div key={item.id} className="k-item">
                <div className="thumb"><img src={item.url} alt="" /></div>
                <div className="info">
                  <div className="t">{config.getFormat(item.key).label}</div>
                  <div className="s">{item.filename} · {formatBRL(item.unitPrice)}</div>
                  <div className="bottom">
                    <span className="unit">{formatBRL(item.subtotal)}</span>
                    <span className="k-qty">
                      <button onClick={() => setFotoQty(item.id, item.qty - 1)}><Minus size={10} /></button>
                      <span className="val">{item.qty}</span>
                      <button onClick={() => setFotoQty(item.id, item.qty + 1)}><Plus size={10} /></button>
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <button onClick={() => abrirEditor(selectedFoto || { name: item.filename, filename: item.filename }, 'edit', item)} title="Ajustar enquadramento"><Pencil size={12} /></button>
                  <button className="del" onClick={() => removeFoto(item.id)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {resumo.prod.map((item) => (
              <div key={item.key} className="k-item">
                <div className="thumb"><img src={SVG_PLACEHOLDER} alt="" /></div>
                <div className="info">
                  <div className="t">{config.getProduto(item.key).label}</div>
                  <div className="s">Unidade · {formatBRL(item.unitPrice)}</div>
                  <div className="bottom">
                    <span className="unit">{formatBRL(item.subtotal)}</span>
                    <span className="k-qty">
                      <button onClick={() => setProdutoQty(item.key, item.qty - 1)}><Minus size={10} /></button>
                      <span className="val">{item.qty}</span>
                      <button onClick={() => setProdutoQty(item.key, item.qty + 1)}><Plus size={10} /></button>
                    </span>
                  </div>
                </div>
                <div className="actions">
                  <button className="del" onClick={() => setProdutoQty(item.key, 0)}><Trash2 size={12} /></button>
                </div>
              </div>
            ))}
            {cartCount === 0 && (
              <p className="muted small center" style={{ marginTop: '16px', lineHeight: 1.6 }}>
                Carrinho vazio.<br />Clique em uma foto e escolha o formato.
              </p>
            )}
          </div>

          <div className="cart-sum">
            <div className="sum-row"><span>Subtotal</span><strong>{formatBRL(subtotalBase)}</strong></div>
            <div className="sum-row gold"><span>Desconto combo ♢</span><strong>{formatBRL(descontoCombo)}</strong></div>
            {desconto && (
              <div className="sum-row gold">
                <span>
                  {desconto.nome}
                  <button className="k-chip ghost" style={{ marginLeft: '6px', padding: '1px 6px', fontSize: '9px' }} onClick={() => onDesconto(null)}><X size={9} /> remover</button>
                </span>
                <strong>{formatBRL(desconto.valor)}</strong>
              </div>
            )}
            <button
              className="btn btn-sm"
              style={{ width: '100%', marginTop: '8px', justifyContent: 'center' }}
              disabled={cartCount === 0 || !!desconto}
              onClick={() => setDescModal('catalogo')}
            >
              <BadgePercent size={13} /> {desconto ? 'Desconto aplicado' : 'Aplicar desconto'}
            </button>
            <div className="grand-row">
              <span>Total</span>
              <strong>{formatBRL(totalPagar)}</strong>
            </div>
            <button className="finish-btn" disabled={cartCount === 0} onClick={onCheckout}>
              <ShoppingCart size={18} /> FINALIZAR VENDA · {formatBRL(totalPagar)}
            </button>
          </div>
        </div>
      </aside>

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