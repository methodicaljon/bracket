import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertNoForbiddenParams,
  assertPriceMatches,
  integrationIdentifier,
  offerForCountry,
  parseGated,
  reduceBilling
} from '../src/entitlement.js';

const allowlist = {
  price_usd_test: { currency: 'usd', unitAmount: 999, country: 'US' },
  price_cad_test: { currency: 'cad', unitAmount: 999, country: 'CA' }
};
const ctx = { allowlist, graceMs: 3 * 24 * 60 * 60 * 1000, bufferMs: 60 * 60 * 1000 };

function sub(overrides) {
  const periodEnd = overrides.periodEnd || 1_800_000_000;
  return {
    id: overrides.id || 'sub_1',
    status: overrides.status,
    currency: overrides.currency || 'usd',
    customer: overrides.customer || 'cus_1',
    cancel_at_period_end: !!overrides.cancel,
    metadata: { firebaseUid: 'uid_1' },
    items: {
      data: [{
        price: { id: overrides.priceId || 'price_usd_test', unit_amount: overrides.unitAmount ?? 999, currency: overrides.currency || 'usd' },
        current_period_end: periodEnd
      }]
    }
  };
}

test('paid features can only name sync, never an offline tool', () => {
  assert.deepEqual(parseGated(''), []);
  assert.deepEqual(parseGated('sync'), ['sync']);
  assert.throws(() => parseGated('calculator'), /Offline tools/);
  assert.throws(() => parseGated('sync,tax'), /Offline tools/);
});

test('country offers are explicit USD and CAD monthly prices with no trial', () => {
  assert.equal(offerForCountry('US').label, 'USD 9.99 per month');
  assert.equal(offerForCountry('ca').label, 'CAD 9.99 per month');
  assert.equal(offerForCountry('GB'), null);
  assert.equal(offerForCountry('US').amountMinor, 999);
});

test('integration identifier ends in 8 letters', () => {
  let n = 0;
  const id = integrationIdentifier(() => n++ % 26);
  assert.match(id, /^bracket_checkout_[a-z]{8}$/);
});

test('checkout params reject payment method types, tax, and trials', () => {
  assert.throws(() => assertNoForbiddenParams({ payment_method_types: ['card'] }), /payment_method_types/);
  assert.throws(() => assertNoForbiddenParams({ automatic_tax: { enabled: true } }), /automatic_tax/);
  assert.throws(() => assertNoForbiddenParams({ subscription_data: { trial_period_days: 14 } }), /trial_period_days/);
  assert.doesNotThrow(() => assertNoForbiddenParams({ mode: 'subscription', line_items: [{ price: 'price_usd_test', quantity: 1 }] }));
});

test('server price must be an active 9.99 monthly price in the selected currency', () => {
  const offer = offerForCountry('US');
  assert.equal(assertPriceMatches({ active: true, currency: 'usd', unit_amount: 999, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } }, offer), null);
  assert.equal(assertPriceMatches({ active: true, currency: 'usd', unit_amount: 500, type: 'recurring', recurring: { interval: 'month' } }, offer), 'PRICE_AMOUNT');
  assert.equal(assertPriceMatches({ active: true, currency: 'cad', unit_amount: 999, type: 'recurring', recurring: { interval: 'month' } }, offer), 'PRICE_CURRENCY');
});

test('subscription lifecycle grants only verified paid states', () => {
  const now = 1_700_000_000_000;
  const unpaid = reduceBilling(null, { id: 'evt_1', created: 10, now, kind: 'checkout_unpaid', uid: 'uid_1' }, ctx);
  assert.equal(unpaid.entitlement.active, false);

  const paid = reduceBilling(unpaid.billing, {
    id: 'evt_2', created: 11, now, kind: 'snapshot', uid: 'uid_1',
    subscription: sub({ status: 'active', periodEnd: 1_800_000_000 })
  }, ctx);
  assert.equal(paid.entitlement.access, 'paid');
  assert.equal(paid.entitlement.active, true);
  assert.equal(paid.entitlement.currency, 'usd');

  const renewal = reduceBilling(paid.billing, {
    id: 'evt_3', created: 12, now: now + 1000, kind: 'snapshot',
    subscription: sub({ status: 'active', periodEnd: 1_900_000_000 })
  }, ctx);
  assert.equal(renewal.entitlement.currentPeriodEnd, 1_900_000_000_000);
  assert.equal(renewal.entitlement.active, true);

  const failed = reduceBilling(renewal.billing, {
    id: 'evt_4', created: 13, now: now + 2000, kind: 'snapshot',
    subscription: sub({ status: 'past_due', periodEnd: 1_900_000_000 })
  }, ctx);
  assert.equal(failed.entitlement.access, 'grace');
  assert.equal(failed.entitlement.active, true);
  const again = reduceBilling(failed.billing, {
    id: 'evt_5', created: 14, now: now + 3000, kind: 'snapshot',
    subscription: sub({ status: 'past_due', periodEnd: 1_900_000_000 })
  }, ctx);
  assert.equal(again.billing.graceUntil, failed.billing.graceUntil);

  const expired = reduceBilling(again.billing, {
    id: 'evt_6', created: 15, now: failed.billing.graceUntil + 1, kind: 'snapshot',
    subscription: sub({ status: 'past_due', periodEnd: 1_900_000_000 })
  }, ctx);
  assert.equal(expired.entitlement.active, false);

  const canceled = reduceBilling(paid.billing, {
    id: 'evt_7', created: 16, now, kind: 'snapshot',
    subscription: sub({ status: 'canceled' })
  }, ctx);
  assert.equal(canceled.entitlement.active, false);

  const trial = reduceBilling(null, {
    id: 'evt_8', created: 17, now, kind: 'snapshot',
    subscription: sub({ status: 'trialing' })
  }, ctx);
  assert.equal(trial.entitlement.active, false);
  assert.equal(trial.entitlement.reason, 'trial_not_offered');

  const wrongPrice = reduceBilling(null, {
    id: 'evt_9', created: 18, now, kind: 'snapshot',
    subscription: sub({ status: 'active', priceId: 'price_free', unitAmount: 0 })
  }, ctx);
  assert.equal(wrongPrice.entitlement.active, false);
  assert.equal(wrongPrice.entitlement.reason, 'price_not_allowlisted');

  const scheduled = reduceBilling(null, {
    id: 'evt_10', created: 19, now, kind: 'snapshot',
    subscription: sub({ status: 'active', cancel: true })
  }, ctx);
  assert.equal(scheduled.entitlement.active, true);
  assert.equal(scheduled.entitlement.cancelAtPeriodEnd, true);

  const stale = reduceBilling(scheduled.billing, {
    id: 'evt_11', created: 1, now, kind: 'snapshot',
    subscription: sub({ status: 'canceled' })
  }, ctx);
  assert.equal(stale.skipped, true);
  assert.equal(stale.entitlement.active, true);

  const dispute = reduceBilling(scheduled.billing, { id: 'evt_12', created: 30, now, kind: 'risk', reason: 'dispute' }, ctx);
  assert.equal(dispute.entitlement.active, false);
  const won = reduceBilling(dispute.billing, { id: 'evt_13', created: 31, now, kind: 'risk_clear' }, ctx);
  assert.equal(won.entitlement.active, true);

  const refund = reduceBilling(won.billing, { id: 'evt_14', created: 32, now, kind: 'refund' }, ctx);
  assert.equal(refund.entitlement.active, false);
  assert.equal(refund.entitlement.reason, 'refunded');
});
