// ─────────────────────────────────────────────────────────────
// handlers/checkout.js
// ONE place that answers "what is this customer buying right now?"
//
// Both catalogues share the payment / wallet steps, so every
// screen that needs the item (name, price, stock, email
// requirement) asks here instead of re-deriving it:
//
//   eSIM    → user.planId    → data/plans.json      (sync)
//   digital → user.dpId      → ProdSeller + overrides (live)
// ─────────────────────────────────────────────────────────────
import { getUser } from '../lib/store.js';
import { getPlan } from '../lib/plans.js';
import { SETTINGS } from '../config.js';
import { digitalProductView, QTY_MAX } from './digitalStore.js';

/** Biggest eSIM quantity one order may hold (env MAX_QTY_ESIM). */
export const QTY_MAX_ESIM = () => Math.max(1, SETTINGS.maxQtyEsim);

/**
 * @param {string} jid
 * @returns {Promise<null | {catalog:'esim'|'digital', id, name, price,
 *           data?, validity?, requiresEmailActivation?, activationEmail?,
 *           quantity?}>}
 */
export async function checkoutItem(jid) {
  const user = getUser(jid);

  if (user.dpId) {
    const product = await digitalProductView(user.dpId);
    if (!product) return null;
    // Digital items can be bought in bulk (1–QTY_MAX): the shopper
    // picked the count on the quantity screen, so the CART total is
    // unit price × quantity for every downstream screen — payment,
    // wallet one-tap, sale code, receipts — through this one resolver.
    const quantity = Math.max(1, Math.min(QTY_MAX, Number(user.dpQty) || 1));
    return {
      catalog: 'digital',
      id: product.id,
      name: quantity > 1 ? `${product.name} ×${quantity}` : product.name,
      price: product.pricePkr * quantity,
      unitPrice: product.pricePkr,
      quantity,
      data: null,
      validity: null,
      requiresEmailActivation: product.requiresEmailActivation,
      activationEmail: user.activationEmail || null,
      raw: product,
    };
  }

  const plan = getPlan(user.planId);
  if (!plan) return null;
  // Step 1 lets one order hold up to MAX_QTY_ESIM plans — every unit
  // is bought and delivered as its own eSIM (handlers/orders.js).
  const quantity = Math.max(1, Math.min(QTY_MAX_ESIM(), Number(user.planQty) || 1));
  return {
    catalog: 'esim',
    id: plan.id,
    name: plan.name,
    price: plan.price * quantity,
    unitPrice: plan.price,
    quantity,
    data: plan.data,
    validity: plan.validity,
    requiresEmailActivation: false,
    activationEmail: null,
    raw: plan,
  };
}
