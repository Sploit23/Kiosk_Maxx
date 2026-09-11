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
    };
  } catch {
    return DEFAULTS;
  }
}

const env = resolveConfig();

// ─── Formatos de foto (impressos na ASK-400) ──────────────
// Cada formato tem: frame do editor (px), resolução de impressão (px, 300 DPI),
// papel físico (10x15 ou 15x20), preço base/bulk e overlay (opcional).
const FOTO_FORMATS = {
  '10x15': {
    label: 'Foto 10x15',
    editorFrame: { width: 540, height: 360 },
    printRes: { width: 1864, height: 1228 },
    paper: '10x15',
    pricing: '10x15',
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
    overlay: {
      image: './overlays/bolinha.png',
      grid: { rows: 1, cols: 1 },
    },
  },
};

// ─── Produtos físicos (não impressos — estoque/contagem) ──
const PRODUTOS = {
  'porta-foto': { label: 'Porta-foto', pricing: 'porta-foto' },
  ima: { label: 'Ímã', pricing: 'ima' },
  encarte: { label: 'Encarte', pricing: 'encarte' },
  'bolinha-natal': { label: 'Bolinha de Natal', pricing: 'bolinha-natal' },
};

// ─── Preços (R$) — valores oficiais do evento ────────────────────
// O portal (api.php, ação 'precos') é a fonte de verdade; o PDV busca os
// preços da loja no boot. Estes são o fallback local (catálogo do PDV).
const PRICING = {
  '10x15': { base: 15.0, bulk: null, bulkThreshold: null },
  '15x20': { base: 25.0, bulk: null, bulkThreshold: null },
  bolinha: { base: 12.0, bulk: null, bulkThreshold: null },
  'porta-foto': { base: 35.0, bulk: null, bulkThreshold: null },
  ima: { base: 10.0, bulk: null, bulkThreshold: null },
  encarte: { base: 15.0, bulk: null, bulkThreshold: null },
  'bolinha-natal': { base: 12.0, bulk: null, bulkThreshold: null },
};

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
  eventName: 'NATAL 2026',
  appName: 'Sistema Natal',
  appNameFotografo: 'Natal — Fotógrafo',
  appNamePdv: 'Natal — Vendas',

  fotoFormats: FOTO_FORMATS,
  produtos: PRODUTOS,
  pricing: PRICING,
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
