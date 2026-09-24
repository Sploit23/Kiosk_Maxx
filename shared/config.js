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
    overlay: {
      image: './overlays/15x20.png',
      grid: { rows: 1, cols: 1 },
    },
  },
  bolinha: {
    label: 'Bolinha',
    editorFrame: { width: 1100, height: 1100 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: 'bolinha',
    unidades: 1,
    overlay: {
      image: './overlays/bolinha.png',
      grid: { rows: 1, cols: 1 },
    },
  },
  polaroide: {
    label: 'Polaroide 2 poses',
    editorFrame: { width: 540, height: 360 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: 'polaroide',
    unidades: 1,
    polaroid: true,
    overlay: null,
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
};

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

  getOverlay(key) {
    const f = FOTO_FORMATS[key];
    return f?.overlay || null;
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

export default config;
