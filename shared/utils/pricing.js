// ─────────────────────────────────────────────────────────────
// Cálculo de preços do carrinho (fotos + produtos físicos).
// Combo (bulk) aplicado por papel físico, igual ao kiosk-app.
// ─────────────────────────────────────────────────────────────
import config from '../config';

// Para um item do carrinho (foto), resolve a chave de preço e o papel físico.
export function itemPricing(photo) {
  const f = config.getFormat(photo.key);
  const pricing = config.pricing[f.pricing] || {};
  const paper = f.paper;
  return { pricingKey: f.pricing, paper, base: pricing.base ?? 0, bulk: pricing.bulk ?? pricing.base ?? 0, threshold: pricing.bulkThreshold };
}

// Resolve preço unitário de uma foto do carrinho já com combo aplicado.
// `groupCounts` = qtd total por papel na sessão (para decidir combo).
export function unitPriceForPhoto(photo, groupCounts) {
  const { paper, base, bulk, threshold } = itemPricing(photo);
  const count = groupCounts[paper] || 0;
  const comboActive = threshold != null && count >= threshold;
  return comboActive ? bulk : base;
}

export function unitPriceForProduto(key) {
  return config.getPreco(key);
}

// Calcula o resumo do carrinho.
// items: [{ key, qty }] — fotos referenciam config.fotoFormats
// products: [{ key, qty }] — produtos físicos
export function calculateCart({ items, products }) {
  const paperCounts = {};
  const photoCounts = {};
  for (const item of items) {
    const { paper } = itemPricing({ key: item.key });
    paperCounts[paper] = (paperCounts[paper] || 0) + (item.qty || 1);
  }
  for (const item of items) {
    const f = config.getFormat(item.key);
    photoCounts[f.pricing] = (photoCounts[f.pricing] || 0) + (item.qty || 1);
  }

  const fotos = items.map((item) => {
    const price = unitPriceForPhoto({ key: item.key }, paperCounts);
    return { ...item, unitPrice: price, subtotal: price * (item.qty || 1) };
  });
  const prod = (products || []).map((item) => {
    const price = unitPriceForProduto(item.key);
    return { ...item, unitPrice: price, subtotal: price * (item.qty || 1) };
  });
  const total = [...fotos, ...prod].reduce((acc, i) => acc + i.subtotal, 0);
  return { fotos, prod, total, paperCounts, photoCounts };
}
