// ─────────────────────────────────────────────────────────────
// Config compartilhada do Sistema Natal (PDV + Fotógrafo).
// Fonte única de formatos, produtos, overlays, preços e prazos.
// Lido por ambos os apps (apps/pdv e apps/fotografo).
// ─────────────────────────────────────────────────────────────

const DEFAULTS = {
  // Endereço do sidecar servidor (roda no PC da venda).
  // No PDV é sempre local; no fotógrafo é o IP do PC da venda.
  serverUrl: 'http://localhost:9877',
  // Nome da impressora térmica de guia (driver do Windows).
  thermalPrinterName: '',
  // Nome do PDV (ex.: VENDA-01) — identifica o kiosk no portal.
  pdvNome: '',
  // Backend de cadastro (portal de gestão) publicado na web.
  portalApiUrl: 'https://maxxfoto.com.br/natalcontroler/api.php',
  // ID da loja/kiosk no portal (define o time de vendedores/fotógrafos).
  lojaId: 'teste',
  // Código de emparelhamento gerado no portal (kiosk.pair) — garantia de
  // que esta máquina é a "dona" do lojaId (evita dados misturados em clone).
  pairingCode: '',
  // Texto da logo do shopping que sai na frente da foto (editor + impressão).
  logoTexto: 'SHOPPING PALLADIUM',
};

let bridge = null;
try {
  bridge = window?.natal ?? null;
} catch {
  bridge = null;
}

function resolveConfig() {
  if (!bridge || typeof bridge.getConfig !== 'function') return DEFAULTS;
  try {
    const cfg = bridge.getConfig() || {};
    return {
      serverUrl: cfg.serverUrl || DEFAULTS.serverUrl,
      thermalPrinterName: cfg.thermalPrinterName || DEFAULTS.thermalPrinterName,
      pdvNome: cfg.pdvNome || DEFAULTS.pdvNome,
      portalApiUrl: cfg.portalApiUrl || DEFAULTS.portalApiUrl,
      lojaId: cfg.lojaId || DEFAULTS.lojaId,
      pairingCode: cfg.pairingCode || DEFAULTS.pairingCode,
      photosFolder: cfg.photosFolder || '',
      logoTexto: cfg.logoTexto || DEFAULTS.logoTexto,
    };
  } catch {
    return DEFAULTS;
  }
}

const env = resolveConfig();

// ─── Formatos de foto (impressos na ASK-400) ──────────────
// Cada formato tem: frame do editor (px), resolução de impressão (px, 300 DPI),
// papel físico (10x15 ou 15x20), preço base/bulk e overlay (opcional).
// `unidades` = unidades de ribbon consumidas por foto (para o portal).
const FOTO_FORMATS = {
  '10x15': {
    label: 'Foto 10x15',
    editorFrame: { width: 540, height: 360 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: '10x15',
    unidades: 1,
    allowLogo: true,
    overlay: {
      image: './overlays/10x15.png',
      grid: { rows: 1, cols: 1 },
    },
  },
  '15x20': {
    label: 'Foto 15x20',
    editorFrame: { width: 507, height: 390 },
    printRes: { width: 2422, height: 1864 },
    paper: '15x20',
    pricing: '15x20',
    unidades: 2,
    allowLogo: true,
    overlay: {
      image: './overlays/15x20.png',
      grid: { rows: 1, cols: 1 },
    },
  },
  bolinha: {
    label: 'Bolinha',
    // 2 bolinhas por folha 10x15, igual à polaroide: o PNG do molde é UMA
    // CÉLULA (o cartão redondo com a arte) repetida 2x na folha.
    // O editorFrame é o tamanho da célula e o PNG tem exatamente essa
    // medida (932x1228) — assim o px do editor É o px da impressão (S2 = 1),
    // então o que aparece na tela sai igual no papel.
    editorFrame: { width: 932, height: 1228 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: 'bolinha',
    unidades: 1,
    // Sem `allowLogo`: não entra logo do shopping (mesma regra da polaroide).
    overlay: {
      image: './overlays/bolinha-celula.png',
      grid: { rows: 1, cols: 2 },
    },
  },
  polaroide: {
    label: 'Polaroide 2 poses',
    // 2 polaroids por folha 10x15 (folha paisagem dividida em 2 colunas).
    // O editorFrame é o tamanho da CÉLULA, que é exatamente o tamanho do PNG do
    // molde — assim o px do editor É o px da impressão (fator S = 1) e o que
    // aparece na tela sai igual no papel, sem nenhuma compensação.
    editorFrame: { width: 932, height: 1228 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: 'polaroide',
    unidades: 1,
    polaroid: true,
    // Sem `allowLogo`: a polaroide NÃO leva a logo do shopping. O card já tem
    // área própria reservada pela arte do molde e a escrito entraria em cima da
    // foto. A bolinha segue a mesma regra (também é um recorte com moldura).
    overlay: {
      image: './overlays/polaroide.png',
      grid: { rows: 1, cols: 2 },
    },
  },
};

// ─── Produtos físicos (não impressos — estoque/contagem) ──
// Chaves canônicas do portal (PRECOS_DEFAULT do api.php) — o overlay que o
// admin altera em "Catálogo de produtos" cai aqui via aplicarPrecos().
const PRODUTOS = {
  'porta-retrato-10x15': { label: 'Porta-retrato 10x15', pricing: 'porta-retrato-10x15' },
  'porta-retrato-15x20': { label: 'Porta-retrato 15x20', pricing: 'porta-retrato-15x20' },
  ima: { label: 'Ímã de geladeira', pricing: 'ima' },
  'item-encarte': { label: 'Item Encarte', pricing: 'item-encarte' },
  'porta-cartao-postal': { label: 'Porta-cartão postal', pricing: 'porta-cartao-postal' },
};

// ─── Preços (R$) — valores oficiais do evento ────────────────────
// O portal (api.php, ação 'precos') é a fonte de verdade; o PDV busca os
// preços da loja no boot e a cada emparelhamento. Estes são o fallback local
// (catálogo do PDV) — as 15 chaves canônicas do portal.
const PRICING = {
  // formatos (tamanhos de foto)
  '10x15': { base: 15.0, bulk: null, bulkThreshold: null },
  '15x20': { base: 25.0, bulk: null, bulkThreshold: null },
  bolinha: { base: 12.0, bulk: null, bulkThreshold: null },
  polaroide: { base: 20.0, bulk: null, bulkThreshold: null },
  // extras (produtos físicos)
  'porta-retrato-10x15': { base: 35.0, bulk: null, bulkThreshold: null },
  'porta-retrato-15x20': { base: 50.0, bulk: null, bulkThreshold: null },
  ima: { base: 10.0, bulk: null, bulkThreshold: null },
  'item-encarte': { base: 15.0, bulk: null, bulkThreshold: null },
  'porta-cartao-postal': { base: 12.0, bulk: null, bulkThreshold: null },
  // combos
  combo1: { base: 45.0, bulk: null, bulkThreshold: null },
  combo2: { base: 65.0, bulk: null, bulkThreshold: null },
  combo3: { base: 80.0, bulk: null, bulkThreshold: null },
  combo4: { base: 52.0, bulk: null, bulkThreshold: null },
  combo5: { base: 38.0, bulk: null, bulkThreshold: null },
  combo6: { base: 38.0, bulk: null, bulkThreshold: null },
};

// Catálogo de combos (preço fechado < soma dos itens) — mesmas chaves e
// valores do portal/vendas.html. O React ainda não renderiza combos no PDV,
// mas o catálogo vive aqui para o preço vir do portal (aplicarPrecos).
const COMBOS = [
  { id: 'combo1', nome: 'Foto + Porta-retrato 10x15', valorCombo: 45,
    itens: [{ produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 }, { produtoId: 'porta-retrato-10x15', tipoProduto: 'extra', qtd: 1 }] },
  { id: 'combo2', nome: 'Foto + Porta-retrato 15x20', valorCombo: 65,
    itens: [{ produtoId: '15x20', tipoProduto: 'tamanho', qtd: 1 }, { produtoId: 'porta-retrato-15x20', tipoProduto: 'extra', qtd: 1 }] },
  { id: 'combo3', nome: 'Encarte (2 fotos 15x20)', valorCombo: 80,
    itens: [{ produtoId: '15x20', tipoProduto: 'tamanho', qtd: 2 }, { produtoId: 'item-encarte', tipoProduto: 'extra', qtd: 1 }] },
  { id: 'combo4', nome: 'Foto 10x15 + Porta-retrato + Bolinha', valorCombo: 52,
    itens: [{ produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 }, { produtoId: 'porta-retrato-10x15', tipoProduto: 'extra', qtd: 1 }, { produtoId: 'bolinha', tipoProduto: 'tamanho', qtd: 1 }] },
  { id: 'combo5', nome: 'Cartão de Natal — Layout 1', valorCombo: 38,
    itens: [{ produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 }, { produtoId: 'porta-cartao-postal', tipoProduto: 'extra', qtd: 1 }] },
  { id: 'combo6', nome: 'Cartão de Natal — Layout 2', valorCombo: 38,
    itens: [{ produtoId: '10x15', tipoProduto: 'tamanho', qtd: 1 }, { produtoId: 'porta-cartao-postal', tipoProduto: 'extra', qtd: 1 }] },
];

// ─── Overlays ──────────────────────────────────────────────
const OVERLAYS = {
  '10x15': FOTO_FORMATS['10x15'].overlay,
  '15x20': FOTO_FORMATS['15x20'].overlay,
  bolinha: FOTO_FORMATS.bolinha.overlay,
  polaroide: FOTO_FORMATS.polaroide.overlay,
};

// ─── Box de enquadramento na tela (PDV) ───────────────────
// Altura em px de tela por formato; a largura sai do ratio do `editorFrame`.
// Formatos com molde usam o ratio da CÉLULA (que é o do PNG do molde), então o
// que aparece na tela tem exatamente o formato do recorte que sai no papel.
// Fonte ÚNICA: o `printUtils` usa o mesmo box para converter o zoom/offset da
// tela em px de impressão — se os dois divergirem, o enquadramento da tela
// para de bater com a impressão.
const EDITOR_BOX_H = {
  '10x15': 460,
  '15x20': 460,
  bolinha: 480,
  polaroide: 480,
};

// ─── Janela da foto dentro do molde ─────────────────────────
// O retângulo TRANSPARENTE do PNG do molde — a área onde a foto realmente
// aparece. Medido do canal alpha de cada PNG (bolinha: y 194..850; polaroide:
// y 89..1012). O enquadramento automático usa ISTO como alvo em vez da célula
// inteira: a foto já nasce preenchendo a janela, então o operador não precisa
// dar zoom para "achatar" o fundo e o que ele vê já é o que sai no papel.
// Coordenadas em px da CÉLULA (= do PNG do molde, 300 DPI).
const OVERLAY_WINDOW = {
  bolinha: { x: 63, y: 194, w: 829, h: 657 },
  polaroide: { x: 85, y: 89, w: 762, h: 924 },
};

// ─── Calibração de Moldes ──────────────────────────────────
// Compensa a margem que a ASK-400 corta. Os offsets são em px da CÉLULA a
// 300 DPI: `cellX` é POR CÉLULA (ordem linha-por-linha: [foto1, foto2, ...]),
// `rowY` é POR LINHA (cada linha de fotos empilhadas) e `scale` é única por
// formato (reduzir a escala abre uma margem branca entre a foto e o corte).
// Esta é a baseline embutida; o ajuste fino desta máquina fica em
// localStorage como DELTA (chave abaixo), então atualizar o app nunca perde a
// calibração — só a baseline pode mudar, e o delta continua valendo.
const OVERLAY_CALIBRATION = {
  polaroide: { cellX: [8, -8], rowY: [2], scale: 98 },
  bolinha: { cellX: [8, -8], rowY: [2], scale: 98 },
};
const OVERLAY_TWEAK_KEY = 'natal-overlay-tweak-v1';

const config = {
  serverUrl: env.serverUrl,
  thermalPrinterName: env.thermalPrinterName,
  pdvNome: env.pdvNome,
  portalApiUrl: env.portalApiUrl,
  lojaId: env.lojaId,
  pairingCode: env.pairingCode,
  photosFolder: env.photosFolder || '',
  logoTexto: env.logoTexto || 'SHOPPING PALLADIUM',
  eventName: 'NATAL 2026',
  appName: 'Sistema Natal',
  appNameFotografo: 'Natal — Fotógrafo',
  appNamePdv: 'Natal — Vendas',

  fotoFormats: FOTO_FORMATS,
  produtos: PRODUTOS,
  pricing: PRICING,
  combos: COMBOS,
  overlays: OVERLAYS,

  // Lista ordenada de chaves de formatos (exibição nos seletores)
  formatKeys() {
    return Object.keys(FOTO_FORMATS);
  },

  formatList() {
    return this.formatKeys().map((key) => {
      const f = FOTO_FORMATS[key];
      const p = PRICING[f.pricing] || {};
      return {
        key,
        label: f.label,
        paper: f.paper,
        overlay: f.overlay,
        price: p.base ?? 0,
        bulk: p.bulk ?? p.base ?? 0,
        bulkThreshold: p.bulkThreshold,
        ratio: f.printRes.width / f.printRes.height,
        unidades: f.unidades || 1,
      };
    });
  },

  getFormat(key) {
    return FOTO_FORMATS[key] || FOTO_FORMATS['10x15'];
  },

  getEditorFrame(key) {
    return this.getFormat(key).editorFrame;
  },

  getPrintRes(key) {
    return this.getFormat(key).printRes;
  },

  getPaper(key) {
    return this.getFormat(key).paper;
  },

  // A logo do shopping só sai nos formatos de FOTO PURA (10x15/15x20). Nos
  // formatos com recorte/moldura (polaroide, bolinha) ela não entra. Lê o
  // formato DIRETO (sem o fallback do getFormat) e devolve false por padrão:
  // assim uma chave desconhecida nunca ganha logo por acidente.
  allowsLogo(key) {
    return !!(FOTO_FORMATS[key] && FOTO_FORMATS[key].allowLogo);
  },

  // Retângulo que a foto deve preencher dentro do molde (janela transparente).
  // Sem molde, ou sem janela medida, cai na célula inteira — que é o
  // comportamento antigo e continua correto para 10x15/15x20.
  // As coordenadas são em px da CÉLULA (= px do PNG do molde, 300 DPI), que é
  // a MESMA unidade que a composição de impressão usa. Quem trabalha em px de
  // tela (o editor do PDV) converte pelo box — ver `windowInBox`.
  getOverlayWindow(key) {
    const ef = this.getEditorFrame(key);
    const w = OVERLAY_WINDOW[key];
    if (!w) return { x: 0, y: 0, w: ef.width, h: ef.height };
    return { x: w.x, y: w.y, w: w.w, h: w.h };
  },

  // A mesma janela, convertida para px do box de tela (o editor do PDV).
  windowInBox(key) {
    const win = this.getOverlayWindow(key);
    const ef = this.getEditorFrame(key);
    const box = this.getEditorBox(key);
    const kx = box.W / ef.width;
    const ky = box.H / ef.height;
    return { x: win.x * kx, y: win.y * ky, w: win.w * kx, h: win.h * ky };
  },

  getOverlay(key) {
    const f = FOTO_FORMATS[key];
    return f?.overlay || null;
  },

  // Box de enquadramento na tela, em px de CSS. Ver EDITOR_BOX_H acima.
  getEditorBox(key) {
    const f = FOTO_FORMATS[key] || FOTO_FORMATS['10x15'];
    const H = EDITOR_BOX_H[key] || 460;
    const W = Math.round((H * f.editorFrame.width) / f.editorFrame.height);
    return { W, H };
  },

  // ─── Calibração de molde ─────────────────────────────────
  // Ajuste fino por máquina, guardado como DELTA sobre a baseline de
  // OVERLAY_CALIBRATION. Sobrevive a atualização do app e a mudanças de
  // baseline, porque é só a diferença.
  overlayTweak: {},

  _loadOverlayTweak() {
    try {
      const raw = localStorage.getItem(OVERLAY_TWEAK_KEY);
      if (raw) this.overlayTweak = JSON.parse(raw) || {};
    } catch { /* localStorage indisponível */ }
  },

  getOverlayCalibration(key) {
    return OVERLAY_CALIBRATION[key] || { cellX: [0], rowY: [0], scale: 100 };
  },

  getOverlayTweak(key) {
    return this.overlayTweak[key] || {}; // { cellXDelta, rowYDelta, scaleDelta }
  },

  saveOverlayTweak(key, tweak) {
    this.overlayTweak[key] = tweak;
    try {
      localStorage.setItem(OVERLAY_TWEAK_KEY, JSON.stringify(this.overlayTweak));
    } catch { /* localStorage indisponível */ }
  },

  // Calibração EFETIVA de uma célula = baseline + delta local. É o que a
  // impressão, as miniaturas e os previews usam — por isso os três batem.
  getCellCalibration(key, r, c) {
    const cal = this.getOverlayCalibration(key);
    const grid = FOTO_FORMATS[key]?.overlay?.grid || { rows: 1, cols: 1 };
    const tweak = this.getOverlayTweak(key);
    const idx = r * grid.cols + c;
    const cellX = Array.isArray(cal.cellX) ? cal.cellX : [];
    const rowY = Array.isArray(cal.rowY) ? cal.rowY : [];
    const dx = Array.isArray(tweak.cellXDelta) ? tweak.cellXDelta : [];
    const dy = Array.isArray(tweak.rowYDelta) ? tweak.rowYDelta : [];
    const offX = (Number(cellX[idx]) || 0) + (Number(dx[idx]) || 0);
    const offY = (Number(rowY[r]) || 0) + (Number(dy[r]) || 0);
    const scale = (Number(cal.scale) || 100) + (Number(tweak.scaleDelta) || 0);
    return { offX, offY, scale: scale > 0 ? scale : 100 };
  },

  produtoList() {
    return Object.entries(PRODUTOS).map(([key, p]) => ({
      key,
      label: p.label,
      price: (PRICING[p.pricing] || {}).base ?? 0,
    }));
  },

  getProduto(key) {
    return PRODUTOS[key] || null;
  },

  getPreco(key) {
    return (PRICING[key] || {}).base ?? 0;
  },

  // Unidades de ribbon que uma foto desse formato consome (portal/unidadesTotal).
  getUnidades(key) {
    const f = FOTO_FORMATS[key];
    return f ? (f.unidades || 1) : 0;
  },

  comboList() {
    return COMBOS.map((c) => ({
      id: c.id,
      nome: c.nome,
      valorCombo: c.valorCombo ?? PRICING[c.id]?.base ?? 0,
      itens: c.itens,
    }));
  },

  getCombo(key) {
    return COMBOS.find((c) => c.id === key) || null;
  },

  // ─── Preços vindos do portal (ação 'precos') ──────────────
  // O portal é a fonte de verdade: sobrescreve os `base` de formatos/extras/
  // combos com o overlay da loja (valores inválidos são ignorados → default).
  // Retorna `true` se algo mudou (para a UI re-renderizar).
  aplicarPrecos(precos) {
    if (!precos || typeof precos !== 'object') return false;
    let mudou = false;
    for (const key of Object.keys(PRICING)) {
      const v = precos[key];
      if (v != null && Number.isFinite(+v) && +v >= 0) {
        PRICING[key].base = +(+v).toFixed(2);
        mudou = true;
      }
    }
    for (const c of COMBOS) {
      const v = precos[c.id];
      if (v != null && Number.isFinite(+v) && +v >= 0) {
        c.valorCombo = +(+v).toFixed(2);
        mudou = true;
      }
    }
    return mudou;
  },

  // ─── Qualidade de imagem / previews ─────────────────────
  image: {
    jpegQuality: 0.92,
    canvasBackground: '#FFFFFF',
    previewMaxDimension: 1600,
    printDpi: 300,
  },

  // ─── Zoom do editor ─────────────────────────────────────
  zoom: { min: 1, max: 100, step: 2 },

  // ─── Estados de sessão (fluxo de produção) ──────────────
  sessionStates: [
    'CRIADA',
    'FOTOGRAFANDO',
    'RECEBENDO',
    'PRONTA',
    'EM_ATENDIMENTO',
    'VENDIDA',
    'FINALIZADA',
    'CANCELADA',
  ],

  // ─── Meios de pagamento (registrado manualmente no PDV) ─
  meiosPagamento: [
    { key: 'dinheiro', label: 'Dinheiro' },
    { key: 'pix', label: 'PIX' },
    { key: 'debito', label: 'Débito' },
    { key: 'credito', label: 'Crédito' },
  ],

  // ─── Prazos (ms / s) ────────────────────────────────────
  timers: {
    sseReconnect: 2000,
    printPoll: 5000,
    printDelayFirst: 18000,
    printDelayNext: 12000,
  },
};

config._loadOverlayTweak();

export default config;
