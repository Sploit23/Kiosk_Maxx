// ─────────────────────────────────────────────────────────────
// Editor de enquadramento — portado do kiosk-app (AdjustFraming.jsx)
// adaptado ao catálogo Natal (formatos 10x15/15x20/Bolinha) e ao
// tema escuro do PDV (var(--bg)/var(--panel)/var(--purple)…).
// Arrastar, zoom (pinça/rodinha), girar 90°, trocar formato, orientação.
// ─────────────────────────────────────────────────────────────
import { useState, useRef, useCallback, useEffect } from 'react';
import { ArrowLeft, Undo2, Check, RotateCw, AlertTriangle } from 'lucide-react';
import config from '../config';
import { computeAutoFit, readExifOrientation } from '../utils/imageUtils';
import { generateOverlayThumbnail } from '../utils/thumbnailUtils';

const PREVIEW_MAX_W = 820;
const PREVIEW_MAX_H = 760;

const Corner = ({ top, right, bottom, left, rotate }) => (
  <div
    style={{
      position: 'absolute', width: '22px', height: '22px',
      top, right, bottom, left, transform: `rotate(${rotate}deg)`,
      borderTop: '3px solid var(--purple-bright)', borderLeft: '3px solid var(--purple-bright)',
      borderRadius: '4px 0 0 0', pointerEvents: 'none', zIndex: 20,
    }}
  />
);

const btnGhost = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
  background: 'var(--panel2)', border: '1px solid var(--line)', color: 'var(--white)',
  borderRadius: '8px', padding: '12px', fontSize: '.9rem', fontWeight: 700, cursor: 'pointer',
};

const btnPrimary = {
  flex: 1, background: 'var(--purple)', color: '#fff', border: 'none',
  borderRadius: '8px', padding: '12px', fontSize: '.95rem', fontWeight: 800, cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
  boxShadow: '0 6px 16px rgba(0,0,0,.3)',
};

export default function AdjustFraming({ photos, onBack, onComplete, startIndex = 0, single = false, formatKey = null, maxPreview = null }) {
  const [edited, setEdited] = useState(photos);
  const editedRef = useRef(photos);
  const [index, setIndex] = useState(startIndex);
  const [confirmedCount, setConfirmedCount] = useState(0);

  const photo = edited[index];
  const total = single ? 1 : edited.length;
  const [orientation, setOrientation] = useState(photo.orientation || 'retrato');

  const overlay = config.getOverlay(photo.key);
  const frame = config.getEditorFrame(photo.key);
  let frameWidth = frame.width;
  let frameHeight = frame.height;
  if (!overlay) {
    const isNatLandscape = frameWidth > frameHeight;
    if ((orientation === 'retrato' && isNatLandscape) || (orientation === 'paisagem' && !isNatLandscape)) {
      [frameWidth, frameHeight] = [frameHeight, frameWidth];
    }
  }
  const maxW = maxPreview?.w ?? PREVIEW_MAX_W;
  const maxH = maxPreview?.h ?? PREVIEW_MAX_H;
  const displayScale = Math.min(maxW / frameWidth, maxH / frameHeight);

  const imgRef = useRef(null);
  const [scale, setScale] = useState(photo.scale ?? null);
  const [diffX, setDiffX] = useState(photo.diffx ?? null);
  const [diffY, setDiffY] = useState(photo.diffy ?? null);
  const [angle, setAngle] = useState(photo.angle ?? 0);
  const [naturalW, setNaturalW] = useState(0);
  const [naturalH, setNaturalH] = useState(0);

  const isDragging = useRef(false);
  const [isDraggingUi, setIsDraggingUi] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const dragPos = useRef({ x: 0, y: 0 });
  const pinchRef = useRef(null);

  const autoFit = useCallback((iw, ih) => {
    const fit = computeAutoFit(iw, ih, frameWidth, frameHeight);
    setScale(fit.scale);
    setDiffX(fit.diffX);
    setDiffY(fit.diffY);
    setAngle(fit.angle);
  }, [frameWidth, frameHeight]);

  const initEditor = useCallback(() => {
    const img = imgRef.current;
    if (!img) return;
    let iw = img.naturalWidth || img.width;
    let ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    (async () => {
      const swap = await readExifOrientation(img.src);
      if (swap) [iw, ih] = [ih, iw];
      setNaturalW(iw);
      setNaturalH(ih);
      if (photo.scale != null && photo.diffx != null && photo.diffy != null) {
        setScale(photo.scale);
        setDiffX(photo.diffx);
        setDiffY(photo.diffy);
        setAngle(photo.angle ?? 0);
      } else {
        autoFit(iw, ih);
      }
    })();
  }, [photo, autoFit]);

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setOrientation(edited[index]?.orientation || 'retrato');
      setNaturalW(0);
      setNaturalH(0);
      if (imgRef.current?.complete) initEditor();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  useEffect(() => {
    if (naturalW && naturalH) {
      const raf = requestAnimationFrame(() => autoFit(naturalW, naturalH));
      return () => cancelAnimationFrame(raf);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.key, orientation]);

  const handleFormatChange = (key) => {
    const next = editedRef.current.slice();
    next[index] = { ...editedRef.current[index], key };
    editedRef.current = next;
    setEdited(next);
  };

  // Formato controlado de fora (linha de LAYOUTS do PDV): sincroniza quando muda.
  useEffect(() => {
    if (!formatKey) return;
    const current = editedRef.current[index];
    if (current && current.key !== formatKey) handleFormatChange(formatKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formatKey, index]);

  const handleMouseDown = (e) => {
    isDragging.current = true;
    setIsDraggingUi(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    dragPos.current = { x: diffX, y: diffY };
    e.preventDefault();
  };
  const handleMouseMove = (e) => {
    if (!isDragging.current) return;
    const dx = (e.clientX - dragStart.current.x) / displayScale;
    const dy = (e.clientY - dragStart.current.y) / displayScale;
    setDiffX(dragPos.current.x + dx);
    setDiffY(dragPos.current.y + dy);
  };
  const handleMouseUp = () => { isDragging.current = false; setIsDraggingUi(false); };

  const handleTouchStart = (e) => {
    if (e.touches.length === 1) {
      isDragging.current = true;
      setIsDraggingUi(true);
      dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      dragPos.current = { x: diffX, y: diffY };
    } else if (e.touches.length === 2) {
      isDragging.current = false;
      setIsDraggingUi(false);
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = { dist: Math.sqrt(dx * dx + dy * dy), scale: scale ?? 50 };
    }
  };
  const handleTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging.current) {
      const dx = (e.touches[0].clientX - dragStart.current.x) / displayScale;
      const dy = (e.touches[0].clientY - dragStart.current.y) / displayScale;
      setDiffX(dragPos.current.x + dx);
      setDiffY(dragPos.current.y + dy);
    } else if (e.touches.length === 2 && pinchRef.current) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.sqrt(dx * dx + dy * dy);
      const ratio = newDist / pinchRef.current.dist;
      const newScale = Math.min(config.zoom.max, Math.max(config.zoom.min, pinchRef.current.scale * ratio));
      setScale(newScale);
    }
  };
  const handleTouchEnd = () => { isDragging.current = false; setIsDraggingUi(false); pinchRef.current = null; };

  const handleWheel = (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -config.zoom.step : config.zoom.step;
    setScale((prev) => Math.min(config.zoom.max, Math.max(config.zoom.min, (prev ?? 50) + delta)));
  };

  const handleUndo = () => {
    if (naturalW && naturalH) autoFit(naturalW, naturalH);
  };

  const handleRotate = () => {
    setAngle((prev) => (prev + 90) % 360);
  };

  const commitCurrent = () => {
    const latest = editedRef.current[index] ?? photo;
    const updated = { ...latest, scale, diffx: diffX, diffy: diffY, angle, orientation };
    const next = editedRef.current.slice();
    next[index] = updated;
    editedRef.current = next;
    setEdited(next);
    return next;
  };

  const goNext = (confirmed) => {
    const next = commitCurrent();
    if (confirmed) setConfirmedCount((c) => Math.min(total, c + 1));
    if (!single && index + 1 < total) {
      setIndex((i) => i + 1);
    } else {
      onComplete(next);
    }
  };

  const goPrev = () => {
    commitCurrent();
    setIndex((i) => Math.max(0, i - 1));
  };

  const formats = config.formatList();
  const currentFormatLabel = formats.find((f) => f.key === photo.key)?.label || photo.key;
  const progressPct = total ? Math.round((confirmedCount / total) * 100) : 0;

  const [thumbs, setThumbs] = useState({});
  useEffect(() => {
    if (!photo) return undefined;
    let cancelled = false;
    formats.forEach((f) => {
      if (!f.overlay) return;
      generateOverlayThumbnail(
        { ...photo, scale: null, diffx: null, diffy: null, angle: 0 },
        f.key,
      ).then((dataUrl) => {
        if (!cancelled && dataUrl) setThumbs((prev) => ({ ...prev, [f.key]: dataUrl }));
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.url]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', position: 'relative', overflow: 'hidden', background: 'var(--panel)' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '14px 18px 0', flexShrink: 0 }}>
        <span style={{
          background: 'var(--purple)', color: '#fff', fontWeight: 800, fontSize: '.85rem',
          padding: '6px 14px', borderRadius: '999px', whiteSpace: 'nowrap',
        }}>
          {single ? 'Visualizando foto' : `${index + 1} de ${total}`}
        </span>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--white)', margin: 0, textAlign: 'center', letterSpacing: '-.5px' }}>
          Ajustar no formato
        </h2>
        <span style={{ color: 'var(--purple-bright)', fontWeight: 800, fontSize: '.85rem', whiteSpace: 'nowrap', minWidth: '110px', textAlign: 'right' }}>
          {currentFormatLabel}
        </span>
      </div>

      {/* Preview */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '10px 16px', minHeight: 0 }}>
        <div style={{ width: `${frameWidth * displayScale}px`, height: `${frameHeight * displayScale}px`, position: 'relative', flexShrink: 0 }}>
          <div
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
            onWheel={handleWheel}
            style={{
              width: `${frameWidth}px`, height: `${frameHeight}px`,
              position: 'absolute', top: 0, left: 0,
              transform: `scale(${displayScale})`, transformOrigin: 'top left',
              overflow: 'hidden', borderRadius: '10px', border: '2px solid var(--line)',
              boxShadow: '0 20px 50px rgba(0,0,0,.5)', backgroundColor: '#0e1415', cursor: 'grab',
            }}
          >
            <img
              ref={imgRef}
              src={photo.url}
              alt=""
              draggable="false"
              onLoad={initEditor}
              style={{
                position: 'absolute',
                left: `${diffX ?? 0}px`, top: `${diffY ?? 0}px`,
                width: scale ? `${naturalW * (scale / 100)}px` : 'auto',
                height: scale ? `${naturalH * (scale / 100)}px` : 'auto',
                transform: `rotate(${angle}deg)`, transformOrigin: 'center center',
                pointerEvents: 'none',
                transition: isDraggingUi ? 'none' : 'left 0.08s ease-out, top 0.08s ease-out',
              }}
            />

            {overlay && (
              <img
                src={overlay.image}
                alt=""
                draggable="false"
                style={{
                  position: 'absolute', top: 0, left: 0,
                  width: '100%', height: '100%',
                  pointerEvents: 'none', zIndex: 10,
                }}
              />
            )}
          </div>
          <Corner top="-4px" left="-4px" rotate={0} />
          <Corner top="-4px" right="-4px" rotate={90} />
          <Corner bottom="-4px" right="-4px" rotate={180} />
          <Corner bottom="-4px" left="-4px" rotate={270} />
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '.85rem', fontWeight: 600, textAlign: 'center', margin: '12px 0 0', lineHeight: 1.4 }}>
          Arraste para ajustar. Use dois dedos para ampliar ou reduzir.
        </p>
      </div>

      {/* Desfazer + Girar + Orientação */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 16px', flexShrink: 0 }}>
        <button type="button" onClick={handleUndo} style={btnGhost}>
          <Undo2 size={16} /> Desfazer
        </button>
        <button type="button" onClick={handleRotate} style={btnGhost}>
          <RotateCw size={16} /> Girar 90°
        </button>
        {!overlay && (
          <button
            type="button"
            onClick={() => setOrientation((o) => (o === 'retrato' ? 'paisagem' : 'retrato'))}
            style={{ ...btnGhost, flex: 1 }}
          >
            {orientation === 'retrato' ? 'Usar paisagem' : 'Usar retrato'}
          </button>
        )}
      </div>

      {/* Botões principal */}
      <div style={{ display: 'flex', gap: '10px', padding: '8px 16px', flexShrink: 0 }}>
        {!single && index > 0 && (
          <button type="button" onClick={goPrev} style={{ ...btnGhost, flex: '0 0 auto', padding: '12px 18px' }}>
            <ArrowLeft size={16} /> Anterior
          </button>
        )}
        <button type="button" onClick={() => goNext(true)} style={btnPrimary}>
          <Check size={16} /> {single ? 'Conferida — Adicionar' : 'Conferida Próxima foto'}
        </button>
      </div>

      {/* Formatos — só quando o formato NÃO é controlado de fora */}
      {!formatKey && (
      <div style={{ padding: '0 14px', flexShrink: 0 }}>
        <div style={{
          background: 'var(--panel2)', border: '1px solid var(--line)',
          borderRadius: '10px', padding: '10px 12px',
        }}>
          <span style={{ display: 'block', color: 'var(--muted)', fontSize: '.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.8px', marginBottom: '8px' }}>
            Formato desta foto
          </span>
          <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', paddingBottom: '4px' }}>
            {formats.map((opt) => {
              const active = opt.key === photo.key;
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => handleFormatChange(opt.key)}
                  style={{
                    flex: '0 0 auto', width: '128px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '6px',
                    background: 'var(--panel)', color: 'var(--white)',
                    border: active ? '2px solid var(--purple)' : '2px solid var(--line)',
                    borderRadius: '10px', padding: '8px', cursor: 'pointer', fontFamily: 'inherit',
                    boxShadow: active ? '0 8px 24px rgba(0,0,0,.35)' : 'none',
                  }}
                >
                  <div style={{ width: '78px', aspectRatio: String(opt.ratio), borderRadius: '8px', overflow: 'hidden', background: '#000', boxShadow: '0 2px 8px rgba(0,0,0,.4)' }}>
                    {opt.overlay && thumbs[opt.key] ? (
                      <img src={thumbs[opt.key]} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
                    ) : (
                      <img src={photo.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                    )}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
                    <span style={{ color: 'var(--white)', fontSize: '.85rem', fontWeight: 800, textAlign: 'center', lineHeight: 1.15 }}>{opt.label}</span>
                    <span style={{ color: 'var(--green)', fontSize: '.85rem', fontWeight: 800, whiteSpace: 'nowrap' }}>
                      R$ {opt.price.toFixed(2).replace('.', ',')}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      )}

      {/* Progresso */}
      {!single && (
        <div style={{ padding: '10px 20px 8px', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <div style={{ flex: 1, height: '8px', borderRadius: '999px', background: 'var(--line)', overflow: 'hidden' }}>
              <div style={{ width: `${progressPct}%`, height: '100%', background: 'var(--green)', borderRadius: '999px', transition: 'width .25s ease' }} />
            </div>
            <span style={{ color: 'var(--muted)', fontSize: '.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {confirmedCount} de {total} conferidas
            </span>
          </div>
        </div>
      )}

      {/* Voltar */}
      <div style={{ padding: '0 16px 14px', display: 'flex', alignItems: 'center', gap: '14px', flexShrink: 0 }}>
        <button
          type="button" onClick={() => onBack(commitCurrent())}
          style={{
            padding: '10px 24px', fontSize: '1rem', borderRadius: '8px',
            border: '1px solid var(--line)', background: 'var(--panel2)', color: 'var(--white)', cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
          }}
        >
          ← Voltar
        </button>
        {overlay && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: '10px',
            background: 'rgba(135,57,213,.12)', border: '1px solid var(--purple)',
            borderRadius: '10px', padding: '8px 12px', flex: 1,
          }}>
            <AlertTriangle size={20} color="var(--purple-bright)" style={{ flexShrink: 0 }} />
            <p style={{ color: 'var(--white)', fontSize: '.85rem', fontWeight: 700, margin: 0, lineHeight: 1.3 }}>
              Estas fotos são impressas e NÃO saem cortadas. Posicione cada foto dentro do molde.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
