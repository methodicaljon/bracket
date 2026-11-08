/** Paid-access decisions. Callers pass plain records; this module does not talk to Stripe. */

export const OFFERS = [
  { country: 'US', currency: 'usd', amountMinor: 999, amount: '9.99', interval: 'month', label: 'USD 9.99 per month' },
  { country: 'CA', currency: 'cad', amountMinor: 999, amount: '9.99', interval: 'month', label: 'CAD 9.99 per month' }
];

const GATEABLE = new Set(['sync']);
const FORBIDDEN_PARAM = new Set(['payment_method_types', 'automatic_tax', 'trial_period_days', 'trial_end', 'trial_settings']);

export function parseGated(raw) {
  const list = String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const feature of list) {
    if (!GATEABLE.has(feature)) {
      throw new Error('Unknown paid feature "' + feature + '". Offline tools cannot be gated. Allowed: sync');
    }
  }
  return list;
}

export function offerForCountry(country) {
  const code = String(country || '').trim().toUpperCase();
  return OFFERS.find((offer) => offer.country === code) || null;
}

export function integrationIdentifier(randomInt = null) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const roll = randomInt || ((max) => Math.floor(Math.random() * max));
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += alphabet[roll(alphabet.length)];
  return 'bracket_checkout_' + suffix;
}

export function assertNoForbiddenParams(value, path = '') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_PARAM.has(key)) {
      throw new Error('Refusing Stripe parameter ' + (path ? path + '.' : '') + key);
    }
    if (child && typeof child === 'object') assertNoForbiddenParams(child, path ? path + '.' + key : key);
  }
}

export function assertPriceMatches(price, offer) {
  if (!price || price.active === false) return 'PRICE_INACTIVE';
  if (String(price.currency || '').toLowerCase() !== offer.currency) return 'PRICE_CURRENCY';
  if (price.unit_amount !== offer.amountMinor) return 'PRICE_AMOUNT';
  const recurring = price.recurring || {};
  if (recurring.interval !== 'month' || (recurring.interval_count || 1) !== 1) return 'PRICE_INTERVAL';
  if (price.type && price.type !== 'recurring') return 'PRICE_TYPE';
  return null;
}

export function priceIdOf(sub) {
  const price = sub && sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
  if (!price) return null;
  return typeof price === 'string' ? price : price.id || null;
}

export function periodEndMs(sub) {
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  const sec = (item && item.current_period_end) || (sub && sub.current_period_end) || null;
  return sec ? sec * 1000 : null;
}

export function emptyBilling(uid) {
  return {
    uid: uid || null,
    stripeCustomerId: null,
    subscriptionId: null,
    priceId: null,
    currency: null,
    status: null,
    access: 'none',
    active: false,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    expiresAt: 0,
    graceStartedAt: null,
    graceUntil: null,
    riskHold: false,
    riskReason: null,
    reason: null,
    partialRefund: false,
    lastSnapshotCreated: 0,
    lastEventId: null,
    subscriptionSnapshot: null,
    updatedAt: 0
  };
}

function stamp(billing, event, now) {
  return {
    ...billing,
    lastEventId: event.id,
    updatedAt: now
  };
}

function project(billing) {
  return {
    active: billing.active === true,
    access: billing.access || 'none',
    status: billing.status || null,
    currency: billing.currency || null,
    currentPeriodEnd: billing.currentPeriodEnd || null,
    graceUntil: billing.graceUntil || null,
    cancelAtPeriodEnd: !!billing.cancelAtPeriodEnd,
    reason: billing.reason || null,
    expiresAt: billing.expiresAt || 0
  };
}

function finish(billing, outcome, skipped) {
  return { billing, entitlement: project(billing), outcome: outcome || billing.access, skipped: !!skipped };
}

function deny(billing, reason, now) {
  return {
    ...billing,
    access: 'none',
    active: false,
    reason,
    expiresAt: now - 1000,
    graceUntil: reason === 'payment_failed' ? billing.graceUntil : null
  };
}

function allowPaid(billing, ctx) {
  return {
    ...billing,
    access: 'paid',
    active: true,
    reason: null,
    graceStartedAt: null,
    graceUntil: null,
    riskHold: false,
    riskReason: null,
    expiresAt: billing.currentPeriodEnd + ctx.bufferMs
  };
}

function allowGrace(billing, previous, ctx, now) {
  const started = previous && previous.status === 'past_due' && previous.graceStartedAt
    ? previous.graceStartedAt
    : now;
  const graceUntil = started + ctx.graceMs;
  const active = now < graceUntil;
  return {
    ...billing,
    access: active ? 'grace' : 'none',
    active,
    graceStartedAt: started,
    graceUntil,
    reason: active ? 'payment_failed' : 'grace_ended',
    expiresAt: graceUntil
  };
}

function applySnapshot(previous, event, sub, ctx) {
  const now = event.now;
  const priceId = priceIdOf(sub);
  const allowed = priceId ? ctx.allowlist[priceId] : null;
  const embedded = sub && sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price;
  const unitAmount = embedded && typeof embedded === 'object' ? embedded.unit_amount : null;
  const periodEnd = periodEndMs(sub);
  const currency = String((sub && sub.currency) || (allowed && allowed.currency) || '').toLowerCase();
  let billing = stamp({
    ...previous,
    stripeCustomerId: (typeof sub.customer === 'string' ? sub.customer : previous.stripeCustomerId),
    subscriptionId: sub.id || previous.subscriptionId,
    priceId,
    currency: currency || null,
    status: sub.status || null,
    cancelAtPeriodEnd: !!sub.cancel_at_period_end,
    currentPeriodEnd: periodEnd,
    subscriptionSnapshot: {
      id: sub.id,
      status: sub.status,
      currency: sub.currency,
      cancel_at_period_end: !!sub.cancel_at_period_end,
      customer: typeof sub.customer === 'string' ? sub.customer : null,
      current_period_end: periodEnd ? Math.floor(periodEnd / 1000) : null,
      metadata: sub.metadata || {},
      items: { data: [{ price: { id: priceId, unit_amount: unitAmount, currency }, current_period_end: periodEnd ? Math.floor(periodEnd / 1000) : null }] }
    },
    lastSnapshotCreated: event.created
  }, event, now);

  if (event.conflict) return finish(deny(billing, 'binding_conflict', now), 'binding_conflict');
  if (!allowed || allowed.currency !== currency) return finish(deny(billing, 'price_not_allowlisted', now), 'price_not_allowlisted');
  if (unitAmount != null && unitAmount !== allowed.unitAmount) return finish(deny(billing, 'price_amount', now), 'price_amount');
  if (previous.riskHold && event.kind !== 'risk_clear') {
    billing = { ...billing, riskHold: true, riskReason: previous.riskReason || 'risk' };
    return finish(deny(billing, billing.riskReason, now), 'risk_hold');
  }
  if (sub.status === 'trialing') return finish(deny(billing, 'trial_not_offered', now), 'trial_not_offered');
  if (sub.status === 'active') {
    if (!periodEnd) return finish(deny(billing, 'missing_period', now), 'missing_period');
    return finish(allowPaid(billing, ctx), 'paid');
  }
  if (sub.status === 'past_due') return finish(allowGrace(billing, previous, ctx, now), 'grace');
  return finish(deny(billing, sub.status || 'inactive', now), 'inactive');
}

/**
 * Reduce one normalized Stripe event into the billing record.
 * event.kind: snapshot | checkout_unpaid | risk | risk_clear | refund | partial_refund
 */
export function reduceBilling(previous, event, ctx) {
  const now = event.now;
  const prior = previous || emptyBilling(event.uid);
  if (event.kind === 'snapshot' && prior.lastSnapshotCreated && event.created < prior.lastSnapshotCreated) {
    return finish(prior, 'stale', true);
  }
  if (event.kind === 'checkout_unpaid') {
    const billing = stamp({ ...prior, uid: event.uid || prior.uid }, event, now);
    if (!prior.stripeCustomerId && event.customerId) billing.stripeCustomerId = event.customerId;
    return finish(billing, 'unpaid');
  }
  if (event.kind === 'risk') {
    const billing = deny(stamp({ ...prior, riskHold: true, riskReason: event.reason || 'risk' }, event, now), event.reason || 'risk', now);
    billing.riskHold = true;
    billing.riskReason = event.reason || 'risk';
    return finish(billing, 'risk');
  }
  if (event.kind === 'risk_clear') {
    const cleared = { ...prior, riskHold: false, riskReason: null };
    if (!prior.subscriptionSnapshot) return finish(deny(stamp(cleared, event, now), 'no_subscription', now), 'inactive');
    return applySnapshot(cleared, { ...event, kind: 'risk_clear' }, prior.subscriptionSnapshot, ctx);
  }
  if (event.kind === 'refund') {
    const billing = deny(stamp({ ...prior, riskHold: true, riskReason: 'refunded' }, event, now), 'refunded', now);
    billing.riskHold = true;
    billing.riskReason = 'refunded';
    return finish(billing, 'refunded');
  }
  if (event.kind === 'partial_refund') {
    return finish(stamp({ ...prior, partialRefund: true }, event, now), 'partial_refund');
  }
  if (event.kind === 'snapshot') {
    if (!event.subscription) return finish(stamp(prior, event, now), 'missing_subscription');
    return applySnapshot({ ...prior, uid: event.uid || prior.uid }, event, event.subscription, ctx);
  }
  return finish(prior, 'ignored', true);
}

export function summaryText(ent) {
  const currency = ent.currency ? String(ent.currency).toUpperCase() : 'the selected currency';
  const until = ent.currentPeriodEnd ? new Date(ent.currentPeriodEnd).toISOString().slice(0, 10) : 'the period end';
  const grace = ent.graceUntil ? new Date(ent.graceUntil).toISOString().slice(0, 10) : 'the grace deadline';
  if (ent.access === 'paid' && ent.cancelAtPeriodEnd) {
    return 'Paid in ' + currency + ' through ' + until + '. Cancellation is scheduled.';
  }
  if (ent.access === 'paid') return 'Paid. ' + currency + ' 9.99 per month. Renews ' + until + '.';
  if (ent.access === 'grace') {
    return 'Payment failed. Access continues until ' + grace + ' while the payment is retried. Currency: ' + currency + '.';
  }
  if (ent.reason === 'trial_not_offered') return 'No paid access. Trials are not offered.';
  if (ent.reason === 'refunded') return 'No paid access. The payment was refunded.';
  if (ent.reason === 'price_not_allowlisted' || ent.reason === 'price_amount') {
    return 'No paid access. The subscription price is not the Bracket price.';
  }
  return 'No paid access.';
}

export function isEntitled(record, now) {
  if (!record || record.active !== true) return false;
  const expires = typeof record.expiresAt === 'number'
    ? record.expiresAt
    : (record.expiresAt && typeof record.expiresAt.toMillis === 'function' ? record.expiresAt.toMillis() : 0);
  return expires > now;
}
