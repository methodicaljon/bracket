import { Timestamp } from 'firebase-admin/firestore';
import { HttpError } from './errors.js';
import {
  assertNoForbiddenParams,
  assertPriceMatches,
  integrationIdentifier,
  offerForCountry,
  reduceBilling,
  summaryText,
  isEntitled
} from './entitlement.js';

function customerIdOf(object) {
  if (!object) return null;
  if (typeof object.customer === 'string') return object.customer;
  if (object.customer && typeof object.customer === 'object') return object.customer.id || null;
  return null;
}

function subscriptionIdFromInvoice(invoice) {
  const parent = invoice && invoice.parent && invoice.parent.subscription_details;
  if (parent && parent.subscription) return parent.subscription;
  if (typeof invoice.subscription === 'string') return invoice.subscription;
  return null;
}

async function resolveCustomerId(object, stripe) {
  const direct = customerIdOf(object);
  if (direct) return direct;
  const chargeId = typeof object.charge === 'string' ? object.charge : (object.charge && object.charge.id);
  if (chargeId && stripe.charges && stripe.charges.retrieve) {
    const charge = await stripe.charges.retrieve(chargeId);
    return customerIdOf(charge);
  }
  return null;
}

function slimPrice(sub) {
  return sub;
}

export function createBilling(deps) {
  const { db, stripe, config, allowlist, now, randomInt } = deps;
  const clock = now || (() => Date.now());
  const ctx = () => ({ allowlist, graceMs: config.graceMs, bufferMs: config.bufferMs });

  async function loadSubscription(id) {
    if (!id) return null;
    if (typeof id === 'object') return id;
    return stripe.subscriptions.retrieve(id);
  }

  async function writeResult(uid, customerId, event, result) {
    const billing = { ...result.billing, uid, updatedAt: clock() };
    if (customerId && !billing.stripeCustomerId) billing.stripeCustomerId = customerId;
    const expiresAt = Timestamp.fromMillis(billing.expiresAt || clock() - 1000);
    const entitlement = {
      active: result.entitlement.active === true,
      access: result.entitlement.access,
      status: result.entitlement.status,
      currency: result.entitlement.currency,
      currentPeriodEnd: result.entitlement.currentPeriodEnd,
      graceUntil: result.entitlement.graceUntil,
      cancelAtPeriodEnd: result.entitlement.cancelAtPeriodEnd === true,
      reason: result.entitlement.reason,
      expiresAt,
      updatedAt: clock()
    };
    const eventRef = db.collection('stripeEvents').doc(event.id);
    const billingRef = db.collection('billing').doc(uid);
    const entRef = db.collection('entitlements').doc(uid);
    await db.runTransaction(async (tx) => {
      const seen = await tx.get(eventRef);
      if (seen.exists && seen.data().status === 'processed') return;
      tx.set(billingRef, billing);
      tx.set(entRef, entitlement);
      if (customerId) tx.set(db.collection('stripeCustomers').doc(customerId), { uid, updatedAt: clock() });
      tx.set(eventRef, {
        status: 'processed',
        type: event.type,
        created: event.created,
        outcome: result.outcome,
        skipped: !!result.skipped,
        processedAt: clock()
      });
    });
    return result;
  }

  async function uidForCustomer(customerId, metadataUid) {
    if (!customerId && !metadataUid) return { uid: null, conflict: false };
    let bound = null;
    if (customerId) {
      const snap = await db.collection('stripeCustomers').doc(customerId).get();
      bound = snap.exists ? snap.data().uid : null;
    }
    if (bound && metadataUid && bound !== metadataUid) return { uid: bound, conflict: true };
    return { uid: bound || metadataUid || null, conflict: false };
  }

  async function prepare(event) {
    const object = event.data.object;
    const nowMs = clock();
    const base = { id: event.id, type: event.type, created: event.created, now: nowMs };
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded' || event.type === 'checkout.session.async_payment_failed') {
      const metadataUid = (object.metadata && object.metadata.firebaseUid) || object.client_reference_id || null;
      const customerId = customerIdOf(object);
      const bound = await uidForCustomer(customerId, metadataUid);
      if (object.payment_status !== 'paid' || event.type === 'checkout.session.async_payment_failed') {
        return { ...base, ...bound, customerId, kind: 'checkout_unpaid' };
      }
      const subscription = await loadSubscription(object.subscription);
      return { ...base, ...bound, customerId, kind: 'snapshot', subscription: slimPrice(subscription) };
    }
    if (event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const customerId = customerIdOf(object);
      const metadataUid = object.metadata && object.metadata.firebaseUid;
      const bound = await uidForCustomer(customerId, metadataUid);
      return { ...base, ...bound, customerId, kind: 'snapshot', subscription: object };
    }
    if (event.type === 'invoice.paid' || event.type === 'invoice.payment_failed') {
      const customerId = customerIdOf(object);
      const bound = await uidForCustomer(customerId, null);
      const subscription = await loadSubscription(subscriptionIdFromInvoice(object));
      const kind = event.type === 'invoice.paid' && (object.amount_paid || 0) < 999 ? 'checkout_unpaid' : 'snapshot';
      if (event.type === 'invoice.paid' && (object.amount_paid || 0) < 999) {
        const prior = bound.uid ? await db.collection('billing').doc(bound.uid).get() : null;
        const access = prior && prior.exists ? prior.data().access : 'none';
        if (access !== 'paid' && access !== 'grace') {
          return { ...base, ...bound, customerId, kind: 'checkout_unpaid' };
        }
      }
      return { ...base, ...bound, customerId, kind: 'snapshot', subscription };
    }
    if (event.type === 'charge.refunded') {
      const customerId = customerIdOf(object);
      const bound = await uidForCustomer(customerId, null);
      const full = object.amount > 0 && object.amount_refunded >= object.amount;
      return { ...base, ...bound, customerId, kind: full ? 'refund' : 'partial_refund' };
    }
    if (event.type === 'charge.dispute.created' || event.type === 'radar.early_fraud_warning.created') {
      const customerId = await resolveCustomerId(object, stripe);
      const bound = await uidForCustomer(customerId, null);
      const reason = event.type === 'charge.dispute.created' ? 'dispute' : 'fraud_warning';
      return { ...base, ...bound, customerId, kind: 'risk', reason };
    }
    if (event.type === 'charge.dispute.closed') {
      const customerId = await resolveCustomerId(object, stripe);
      const bound = await uidForCustomer(customerId, null);
      const won = object.status === 'won';
      return { ...base, ...bound, customerId, kind: won ? 'risk_clear' : 'risk', reason: won ? null : 'dispute_lost' };
    }
    return { ...base, uid: null, kind: 'ignored' };
  }

  async function applyEvent(event) {
    const eventRef = db.collection('stripeEvents').doc(event.id);
    const seen = await eventRef.get();
    if (seen.exists && seen.data().status === 'processed') return { duplicate: true };
    const prepared = await prepare(event);
    if (prepared.kind === 'ignored') {
      await eventRef.set({ status: 'processed', type: event.type, created: event.created, outcome: 'ignored', processedAt: clock() });
      return { duplicate: false, outcome: 'ignored' };
    }
    if (prepared.conflict) {
      await eventRef.set({ status: 'processed', type: event.type, created: event.created, outcome: 'binding_conflict', processedAt: clock() });
      return { duplicate: false, outcome: 'binding_conflict' };
    }
    if (!prepared.uid) throw new HttpError(500, 'UNBOUND_EVENT');
    const billingRef = db.collection('billing').doc(prepared.uid);
    const priorSnap = await billingRef.get();
    const previous = priorSnap.exists ? priorSnap.data() : null;
    if (prepared.conflict) prepared.kind = prepared.kind === 'snapshot' ? 'snapshot' : prepared.kind;
    const eventForReduce = { ...prepared, conflict: prepared.conflict };
    const result = reduceBilling(previous, eventForReduce, ctx());
    await writeResult(prepared.uid, prepared.customerId, event, result);
    return { duplicate: false, outcome: result.outcome };
  }

  async function ensureCustomer(uid, email) {
    const ref = db.collection('billing').doc(uid);
    const snap = await ref.get();
    if (snap.exists && snap.data().stripeCustomerId) return snap.data().stripeCustomerId;
    assertNoForbiddenParams({ email, metadata: { firebaseUid: uid } });
    const customer = await stripe.customers.create({
      email,
      metadata: { firebaseUid: uid }
    }, { idempotencyKey: 'bracket_customer_' + uid });
    await db.runTransaction(async (tx) => {
      const cur = await tx.get(ref);
      const existing = cur.exists ? cur.data().stripeCustomerId : null;
      if (existing) return;
      tx.set(ref, {
        ...(cur.exists ? cur.data() : {}),
        uid,
        stripeCustomerId: customer.id,
        access: cur.exists ? cur.data().access : 'none',
        active: cur.exists ? cur.data().active === true : false,
        updatedAt: clock()
      }, { merge: true });
      tx.set(db.collection('stripeCustomers').doc(customer.id), { uid, updatedAt: clock() });
    });
    const saved = await ref.get();
    return saved.data().stripeCustomerId;
  }

  return {
    applyEvent,
    async createCheckout({ uid, email, country }) {
      if (!stripe || !config.stripeApiReady) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED');
      const offer = offerForCountry(country);
      if (!offer) throw new HttpError(400, 'COUNTRY_UNAVAILABLE');
      const priceId = offer.country === 'US' ? config.priceUsd : config.priceCad;
      const price = await stripe.prices.retrieve(priceId);
      const mismatch = assertPriceMatches(price, offer);
      if (mismatch) throw new HttpError(500, 'PRICE_MISCONFIGURED');
      const customer = await ensureCustomer(uid, email);
      const params = {
        mode: 'subscription',
        customer,
        client_reference_id: uid,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: config.publicBaseUrl + '/?billing=return&session_id={CHECKOUT_SESSION_ID}',
        cancel_url: config.publicBaseUrl + '/?billing=cancel',
        metadata: { firebaseUid: uid, country: offer.country, currency: offer.currency },
        subscription_data: {
          metadata: { firebaseUid: uid, country: offer.country, currency: offer.currency }
        },
        integration_identifier: integrationIdentifier(randomInt)
      };
      assertNoForbiddenParams(params);
      const minute = Math.floor(clock() / 60000);
      const session = await stripe.checkout.sessions.create(params, {
        idempotencyKey: 'bracket_checkout_' + uid + '_' + offer.country + '_' + minute
      });
      return {
        url: session.url,
        country: offer.country,
        currency: offer.currency.toUpperCase(),
        amount: offer.amount,
        interval: offer.interval,
        label: offer.label
      };
    },

    async createPortal({ uid }) {
      if (!stripe || !config.stripeApiReady) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED');
      const snap = await db.collection('billing').doc(uid).get();
      const customer = snap.exists ? snap.data().stripeCustomerId : null;
      if (!customer) throw new HttpError(409, 'NO_CUSTOMER');
      const session = await stripe.billingPortal.sessions.create({
        customer,
        return_url: config.publicBaseUrl + '/'
      });
      return { url: session.url };
    },

    async readEntitlement(uid) {
      const snap = await db.collection('entitlements').doc(uid).get();
      if (!snap.exists) {
        return { active: false, access: 'none', status: null, currency: null, currentPeriodEnd: null, graceUntil: null, cancelAtPeriodEnd: false, reason: null, expiresAt: 0 };
      }
      const data = snap.data();
      const expiresAt = data.expiresAt && typeof data.expiresAt.toMillis === 'function' ? data.expiresAt.toMillis() : 0;
      const active = isEntitled({ active: data.active === true, expiresAt }, clock());
      return {
        active,
        access: active ? data.access : 'none',
        status: data.status || null,
        currency: data.currency || null,
        currentPeriodEnd: data.currentPeriodEnd || null,
        graceUntil: data.graceUntil || null,
        cancelAtPeriodEnd: data.cancelAtPeriodEnd === true,
        reason: active ? data.reason || null : (data.reason || 'none'),
        expiresAt
      };
    },

    async describe(uid) {
      const ent = await this.readEntitlement(uid);
      const billing = await db.collection('billing').doc(uid).get();
      const profile = await db.collection('profiles').doc(uid).get();
      return {
        username: profile.exists ? profile.data().username || null : null,
        entitlement: { ...ent, summary: summaryText(ent) },
        portal: !!(billing.exists && billing.data().stripeCustomerId),
        gatedFeatures: config.gatedFeatures,
        offlineToolsRequireSubscription: false,
        offers: config.offers.map(publicOffer)
      };
    },

    async readSession({ uid, sessionId }) {
      if (!stripe || !config.stripeApiReady) throw new HttpError(503, 'STRIPE_NOT_CONFIGURED');
      if (!sessionId) throw new HttpError(400, 'MISSING_SESSION');
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      const owner = (session.metadata && session.metadata.firebaseUid) || session.client_reference_id;
      if (owner !== uid) throw new HttpError(404, 'NOT_FOUND');
      return { payment_status: session.payment_status || null, status: session.status || null };
    }
  };
}

export function publicOffer(offer) {
  return {
    country: offer.country,
    currency: offer.currency.toUpperCase(),
    amount: offer.amount,
    interval: offer.interval,
    label: offer.label
  };
}

export function publicOffers() {
  return {
    offers: OFFERS_PUBLIC(),
    trial: false,
    automaticTax: false,
    offlineToolsRequireSubscription: false
  };
}

function OFFERS_PUBLIC() {
  return [
    { country: 'US', currency: 'USD', amount: '9.99', interval: 'month', label: 'USD 9.99 per month' },
    { country: 'CA', currency: 'CAD', amount: '9.99', interval: 'month', label: 'CAD 9.99 per month' }
  ];
}
