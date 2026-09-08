// ─────────────────────────────────────────────────────────────
// Constantes específicas do kiosk MAX FOTO (visual "first half" do
// protótipo). Preços/formatos/modelos reais vêm de shared/config.
// ─────────────────────────────────────────────────────────────

export const LOJA = {
  nome: 'MAX FOTO',
  marca: 'M A X  X',
  tagline: 'FOTOGRAFIA · NATAL DOS SONHOS',
  evento: 'NATAL 2026',
  local: 'ROYAL PLAZA',
};

// Operadores com acesso ao painel de vendas (login do app).
export const USERS = [
  { user: 'admin', pass: '1234', nome: 'ADMINISTRADOR' },
  { user: 'vendedor', pass: '1234', nome: 'VENDEDOR' },
];

// Senha master usada em casos excepcionais (descontos fora do catálogo,
// cancelamentos). Mantenha igual à do administrador e troque quando necessário.
export const SENHA_MASTER = '1234';

// Catálogo de descontos pré-cadastrados (regra do documento) — a vendedora
// só seleciona, nunca digita valor livre.
export const DESCONTOS_CATALOGO = [
  { id: 'd1', nome: '5% de desconto (pedidos acima de R$100)', tipo: 'percentual', valor: 5, minimo: 100 },
  { id: 'd2', nome: 'R$10 de desconto — promoção de Natal', tipo: 'fixo', valor: 10, minimo: 0 },
];

export function valorDesconto(d, subtotal) {
  if (d.tipo === 'percentual') return +((subtotal * d.valor) / 100).toFixed(2);
  return Math.min(d.valor, subtotal);
}

// Parcelamento configurável por loja: liberado a partir de um valor mínimo.
export const LOJA_PARCELAMENTO = { habilitado: true, valorMinimo: 200, maxParcelas: 3 };

// Formas de pagamento disponíveis para um total (multipagamento).
export function formasDisponiveis(total) {
  const base = [
    { key: 'dinheiro', label: 'Dinheiro' },
    { key: 'pix', label: 'PIX' },
    { key: 'debito', label: 'Débito' },
    { key: 'credito', label: 'Crédito à vista' },
  ];
  if (LOJA_PARCELAMENTO.habilitado && total >= LOJA_PARCELAMENTO.valorMinimo) {
    for (let p = 2; p <= LOJA_PARCELAMENTO.maxParcelas; p++) base.push({ key: 'credito', label: `Crédito ${p}x`, parcelas: p });
  }
  return base;
}

export function autenticar(user, pass) {
  const u = USERS.find((x) => x.user === user) || USERS.find((x) => x.nome === user);
  if (!u || u.pass !== pass) return null;
  return { user: u.user, nome: u.nome };
}

// Legenda exibida no topo (marquee) do painel.
export function marqueeText() {
  return `✦ ROYAL PLAZA • ${LOJA.evento} • ${LOJA.tagline} ✦`;
}

// Mapa estado da sessão → tag visual (reutiliza .status-tag .status-pill).
export function tagClasse(estado) {
  const map = {
    CRIADA: 'pagando',
    FOTOGRAFANDO: 'pagando',
    RECEBENDO: 'pagando',
    PRONTA: 'porta',
    EM_ATENDIMENTO: 'atendo',
    VENDIDA: 'vendida',
    FINALIZADA: 'finalizada',
    CANCELADA: 'cancelada',
  };
  return map[estado] || 'finalizada';
}

export function tagLabel(estado) {
  const map = {
    CRIADA: 'Aguardando',
    FOTOGRAFANDO: 'Fotografando',
    RECEBENDO: 'Recebendo',
    PRONTA: 'Pronta',
    EM_ATENDIMENTO: 'Em atendimento',
    VENDIDA: 'Vendida',
    FINALIZADA: 'Concluída',
    CANCELADA: 'Abandonada',
  };
  return map[estado] || estado;
}

export function numeroSessao(id) {
  return String(id || '').replace(/^NATAL-/, '');
}