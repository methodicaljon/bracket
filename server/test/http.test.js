import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Stripe from 'stripe';
import { Timestamp } from 'firebase-admin/firestore';
import { configFromEnv } from '../src/config.js';
import { initFirebase, publishAccessPolicy } from '../src/firebase.js';
import { createHandler, startServer } from '../src/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const emulator = !!(process.env.FIRESTORE_EMULATOR_HOST && process.env.FIREBASE_AUTH_EMULATOR_HOST);
const stripeLib = new Stripe('rk_test_placeholder', { apiVersion: '2026-10-28.endive' });

function createFakeStripe() {
  const prices = {
    price_usd_test: { id: 'price_usd_test', active: true, currency: 'usd', unit_amount: 999, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } },
    price_cad_test: { id: 'price_cad_test', active: true, currency: 'cad', unit_amount: 999, type: 'recurring', recurring: { interval: 'month', interval_count: 1 } }
  };
  const state = { customers: new Map(), idem: new Map(), sessions: [], subs: new Map(), charges: new Map(), portal: [], updates: [], network: 0 };
  const api = {
    prices: { retrieve: async (id) => prices[id] || Promise.reject(Object.assign(new Error('missing price'), { code: 'resource_missing' })) },
    customers: {
      create: async (params, opts) => {
        state.network += 1;
        if (opts?.idempotencyKey && state.idem.has(opts.idempotencyKey)) return state.idem.get(opts.idempotencyKey);
        const customer = { id: 'cus_' + (state.customers.size + 1), email: params.email, metadata: { ...params.metadata } };
        state.customers.set(customer.id, customer);
        if (opts?.idempotencyKey) state.idem.set(opts.idempotencyKey, customer);
        return customer;
      }
    },
    checkout: {
      sessions: {
        create: async (params, opts) => {
          state.network += 1;
          const session = {
            id: 'cs_' + (state.sessions.length + 1),
            url: 'https://checkout.stripe.test/c/' + (state.sessions.length + 1),
            payment_status: 'unpaid',
            status: 'open',
            mode: params.mode,
            customer: params.customer,
            client_reference_id: params.client_reference_id,
            metadata: params.metadata,
            line_items: params.line_items,
            success_url: params.success_url,
            cancel_url: params.cancel_url,
            subscription_data: params.subscription_data,
            integration_identifier: params.integration_identifier
          };
          state.sessions.push({ params, opts, session });
          return session;
        },
        retrieve: async (id) => {
          const found = state.sessions.find((item) => item.session.id === id);
          if (!found) throw new Error('missing session');
          return found.session;
        }
      }
    },
    billingPortal: {
      sessions: {
        create: async (params) => {
          const session = { id: 'bps_' + state.portal.length, url: 'https://billing.stripe.test/p/' + state.portal.length, customer: params.customer, return_url: params.return_url };
          state.portal.push(session);
          return session;
        }
      }
    },
    subscriptions: {
      retrieve: async (id) => {
        if (!state.subs.has(id)) throw new Error('missing subscription ' + id);
        return state.subs.get(id);
      },
      update: async (id, params) => {
        state.updates.push({ id, params });
        return { id, ...params };
      }
    },
    charges: { retrieve: async (id) => state.charges.get(id) },
    webhooks: stripeLib.webhooks
  };
  return { api, prices, state };
}

function subscription({ id, status, priceId, currency, unitAmount, periodEnd, customer, uid, cancel }) {
  return {
    id,
    object: 'subscription',
    status,
    currency,
    customer,
    cancel_at_period_end: !!cancel,
    metadata: { firebaseUid: uid },
    items: {
      data: [{
        price: { id: priceId, unit_amount: unitAmount, currency },
        current_period_end: periodEnd
      }]
    }
  };
}

describe('firebase emulator and mocked Stripe', { skip: emulator ? false : 'Firebase emulator is not running', concurrency: 1, timeout: 120000 }, () => {
  const clock = { t: Date.parse('2026-06-01T00:00:00Z') };
  const logs = [];
  const outbound = [];
  let server;
  let db;
  let config;
  let fake;
  let created = 5000;
  const password = 'password1';

  before(async () => {
    config = configFromEnv({
      STRIPE_SECRET_KEY: 'rk_test_placeholder',
      STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
      STRIPE_PRICE_USD: 'price_usd_test',
      STRIPE_PRICE_CAD: 'price_cad_test',
      STRIPE_API_VERSION: '2026-10-28.endive',
      PUBLIC_BASE_URL: 'http://127.0.0.1:8787',
      FIREBASE_PROJECT_ID: 'demo-bracket',
      FIREBASE_WEB_API_KEY: 'AIzaSyDEMOKEYBRACKET123456',
      FIREBASE_AUTH_EMULATOR_HOST: process.env.FIREBASE_AUTH_EMULATOR_HOST,
      FIRESTORE_EMULATOR_HOST: process.env.FIRESTORE_EMULATOR_HOST,
      PAID_FEATURES: '',
      GRACE_DAYS: '3',
      PAID_BUFFER_HOURS: '1'
    });
    config.limits = { register: 50, login: 50, reset: 50, delete: 20, windowMs: 60 * 1000 };
    const firebase = initFirebase(config);
    db = firebase.db;
    await publishAccessPolicy(db, []);
    fake = createFakeStripe();
    const original = globalThis.fetch;
    const guarded = async (url, init) => {
      const href = String(url);
      outbound.push(href);
      if (href.includes('api.stripe.com')) throw new Error('unexpected live Stripe call ' + href);
      if (href.includes('googleapis.com') && !href.includes('127.0.0.1') && !href.includes('localhost')) {
        throw new Error('unexpected live Google call ' + href);
      }
      return original(url, init);
    };
    const handler = createHandler({
      config,
      auth: firebase.auth,
      db,
      stripe: fake.api,
      root,
      now: () => clock.t,
      logger: { error(...args) { logs.push(JSON.stringify(args)); }, log() {}, info() {} },
      fetch: guarded
    });
    server = await startServer(handler);
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  function base() {
    return 'http://127.0.0.1:' + server.address().port;
  }

  async function call(method, pathname, { token, body, raw, headers } = {}) {
    const res = await fetch(base() + pathname, {
      method,
      headers: {
        ...(body && !raw ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(headers || {})
      },
      body: raw || (body ? JSON.stringify(body) : undefined)
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: res.status, json, text };
  }

  async function register(username, email) {
    const res = await call('POST', '/api/auth/register', { body: { username, email, password } });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.email, email);
    assert.equal(res.text.includes(password), false);
    return res.json;
  }

  function sign(event, timestamp) {
    const payload = JSON.stringify(event);
    const header = stripeLib.webhooks.generateTestHeaderString({
      payload,
      secret: 'whsec_placeholder',
      timestamp
    });
    return { payload, header };
  }

  async function postEvent(event, timestamp) {
    const signed = sign(event, timestamp);
    return call('POST', '/api/stripe/webhook', {
      raw: signed.payload,
      headers: { 'content-type': 'application/json', 'stripe-signature': signed.header }
    });
  }

  function event(type, object) {
    created += 1;
    return { id: 'evt_' + created, object: 'event', type, created, data: { object } };
  }

  test('health, offers, and static files do not expose secrets', async () => {
    const health = await call('GET', '/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.automaticTax, false);
    assert.equal(health.json.trial, false);
    assert.equal(health.json.offlineToolsRequireSubscription, false);
    assert.equal(health.json.stripe.api, true);
    assert.equal(health.json.stripe.restrictedKey, true);
    assert.equal(health.json.firebase.emulator, true);
    assert.equal(health.text.includes('rk_test'), false);
    assert.equal(health.text.includes('whsec_'), false);
    const offers = await call('GET', '/api/billing/offers');
    assert.deepEqual(offers.json.offers.map((offer) => offer.label), ['USD 9.99 per month', 'CAD 9.99 per month']);
    assert.equal(offers.json.trial, false);
    assert.equal(offers.json.automaticTax, false);
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.text, /Find your bracket/);
    assert.equal((await call('GET', '/.env')).status, 404);
    assert.equal((await call('GET', '/server/src/billing.js')).status, 404);
    assert.equal((await call('POST', '/api/billing/grant', { body: { active: true } })).status, 404);
  });

  test('username registration, collisions, login, reset, logout, and email fallback', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const name = 'ada' + suffix;
    const first = await register(name, name + '.a@example.com');
    const again = await call('POST', '/api/auth/register', { body: { username: name.toUpperCase(), email: name + '.b@example.com', password } });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.message, 'USERNAME_TAKEN');
    assert.equal(again.text.includes('@'), false);
    const [left, right] = await Promise.all([
      call('POST', '/api/auth/register', { body: { username: 'sam' + suffix, email: 'sam1' + suffix + '@example.com', password } }),
      call('POST', '/api/auth/register', { body: { username: 'SAM' + suffix, email: 'sam2' + suffix + '@example.com', password } })
    ]);
    const wins = [left, right].filter((item) => item.status === 200);
    const losses = [left, right].filter((item) => item.status === 409);
    assert.equal(wins.length, 1, JSON.stringify([left.json, right.json]));
    assert.equal(losses.length, 1);
    assert.equal(losses[0].json.error.message, 'USERNAME_TAKEN');
    assert.equal(losses[0].text.includes('@'), false);
    const sameEmail = await call('POST', '/api/auth/register', { body: { username: name + 'b', email: name + '.a@example.com', password } });
    assert.equal(sameEmail.status, 409);
    assert.equal(sameEmail.json.error.message, 'EMAIL_EXISTS');
    assert.equal(sameEmail.text.includes(name), false);

    const badUser = await call('POST', '/api/auth/login', { body: { username: 'missing' + suffix, password } });
    const badPass = await call('POST', '/api/auth/login', { body: { username: name, password: 'wrong-password' } });
    assert.equal(badUser.status, 401);
    assert.equal(badPass.status, 401);
    assert.deepEqual(badUser.json, badPass.json);
    assert.equal(badUser.json.error.message, 'INVALID_LOGIN');
    assert.equal(badUser.text.includes('@'), false);

    const knownReset = await call('POST', '/api/auth/reset', { body: { username: name } });
    const unknownReset = await call('POST', '/api/auth/reset', { body: { username: 'missing' + suffix } });
    assert.equal(knownReset.status, 200);
    assert.deepEqual(knownReset.json, { ok: true });
    assert.deepEqual(knownReset.json, unknownReset.json);
    assert.equal(knownReset.text.includes('@'), false);
    assert.equal(unknownReset.text.includes('@'), false);

    const me = await call('GET', '/api/billing/me', { token: first.idToken });
    assert.equal(me.status, 200);
    assert.equal(me.json.email, name + '.a@example.com');
    assert.equal(me.json.username, name);
    assert.equal(me.json.entitlement.active, false);
    assert.equal(me.json.offlineToolsRequireSubscription, false);
    await call('POST', '/api/auth/logout', { token: first.idToken, body: {} });
    const afterLogout = await call('GET', '/api/billing/me', { token: first.idToken });
    assert.equal(afterLogout.status, 401);

    const host = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const email = 'fallback' + suffix + '@example.com';
    const signUp = await fetch('http://' + host + '/identitytoolkit.googleapis.com/v1/accounts:signUp?key=' + config.webApiKey, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    assert.equal(signUp.status, 200);
    const signedIn = await fetch('http://' + host + '/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' + config.webApiKey, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
    assert.equal(signedIn.status, 200, await signedIn.text());
    const noUsername = await call('POST', '/api/auth/login', { body: { username: 'fallback' + suffix, password } });
    assert.equal(noUsername.status, 401);

    await call('POST', '/api/auth/delete', { token: (await register('temp' + suffix, 'temp' + suffix + '@example.com')).idToken, body: { password } });
    const reused = await register('temp' + suffix, 'temp2' + suffix + '@example.com');
    assert.equal(reused.username, 'temp' + suffix);
    assert.equal(JSON.stringify(logs).includes(password), false);
  });

  test('checkout and portal authorize the signed-in user and the server price', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const user = await register('pay' + suffix, 'pay' + suffix + '@example.com');
    const other = await register('other' + suffix, 'other' + suffix + '@example.com');
    assert.equal((await call('POST', '/api/billing/checkout', { body: { country: 'US' } })).status, 401);
    assert.equal((await call('POST', '/api/billing/checkout', { token: user.idToken, body: { country: 'GB' } })).status, 400);
    const before = fake.state.sessions.length;
    fake.prices.price_usd_test.unit_amount = 100;
    const badPrice = await call('POST', '/api/billing/checkout', { token: user.idToken, body: { country: 'US', price: 'price_free', priceId: 'price_free' } });
    assert.equal(badPrice.status, 500);
    assert.equal(badPrice.json.error.message, 'PRICE_MISCONFIGURED');
    assert.equal(fake.state.sessions.length, before);
    fake.prices.price_usd_test.unit_amount = 999;

    const us = await call('POST', '/api/billing/checkout', { token: user.idToken, body: { country: 'US', priceId: 'price_free', currency: 'eur' } });
    assert.equal(us.status, 200, us.text);
    assert.equal(us.json.currency, 'USD');
    assert.equal(us.json.label, 'USD 9.99 per month');
    assert.match(us.json.url, /^https:\/\/checkout\.stripe\.test\//);
    const params = fake.state.sessions.at(-1).params;
    assert.equal(params.mode, 'subscription');
    assert.equal(params.line_items[0].price, 'price_usd_test');
    assert.equal(params.line_items[0].quantity, 1);
    assert.equal(Object.hasOwn(params, 'payment_method_types'), false);
    assert.equal(Object.hasOwn(params, 'automatic_tax'), false);
    assert.equal(params.subscription_data.trial_period_days, undefined);
    assert.match(params.integration_identifier, /^bracket_checkout_[a-z]{8}$/);
    assert.equal(params.metadata.firebaseUid, user.localId);
    assert.equal(params.metadata.currency, 'usd');
    assert.ok(fake.state.sessions.at(-1).opts.idempotencyKey);
    const session = fake.state.sessions.at(-1).session;
    session.payment_status = 'paid';
    const viewed = await call('GET', '/api/billing/session?session_id=' + session.id, { token: user.idToken });
    assert.equal(viewed.status, 200);
    assert.equal(viewed.json.payment_status, 'paid');
    const still = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(still.json.entitlement.active, false);
    assert.equal((await call('GET', '/api/billing/session?session_id=' + session.id, { token: other.idToken })).status, 404);

    const ca = await call('POST', '/api/billing/checkout', { token: other.idToken, body: { country: 'CA' } });
    assert.equal(ca.json.currency, 'CAD');
    assert.equal(ca.json.label, 'CAD 9.99 per month');
    assert.equal(fake.state.sessions.at(-1).params.line_items[0].price, 'price_cad_test');
    assert.equal(fake.state.sessions.at(-1).params.metadata.currency, 'cad');

    const portalOther = await call('POST', '/api/billing/portal', { token: user.idToken, body: { customer: 'cus_stolen' } });
    assert.equal(portalOther.status, 200);
    assert.equal(fake.state.portal.at(-1).customer, params.customer);
    const noCustomer = await register('fresh' + suffix, 'fresh' + suffix + '@example.com');
    assert.equal((await call('POST', '/api/billing/portal', { token: noCustomer.idToken, body: {} })).status, 409);
    assert.equal((await call('GET', '/api/online/sync', { token: user.idToken })).json.gated, false);
  });

  test('webhooks verify signatures, ignore the success page, and follow the subscription lifecycle', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const user = await register('life' + suffix, 'life' + suffix + '@example.com');
    const checkout = await call('POST', '/api/billing/checkout', { token: user.idToken, body: { country: 'US' } });
    const customer = fake.state.sessions.at(-1).params.customer;
    const uid = user.localId;
    const subId = 'sub_' + suffix;
    fake.state.subs.set(subId, subscription({
      id: subId, status: 'active', priceId: 'price_usd_test', currency: 'usd', unitAmount: 999,
      periodEnd: 1_800_000_000, customer, uid
    }));

    const unsigned = await call('POST', '/api/stripe/webhook', { raw: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(unsigned.status, 400);
    assert.equal(unsigned.json.error.message, 'INVALID_SIGNATURE');
    const staleEvent = event('checkout.session.completed', {
      id: 'cs_stale', payment_status: 'paid', customer, subscription: subId, client_reference_id: uid, metadata: { firebaseUid: uid }
    });
    const stale = await postEvent(staleEvent, Math.floor(Date.now() / 1000) - 1000);
    assert.equal(stale.status, 400);

    const unpaid = await postEvent(event('checkout.session.completed', {
      id: 'cs_unpaid', object: 'checkout.session', payment_status: 'unpaid', customer, subscription: subId,
      client_reference_id: uid, metadata: { firebaseUid: uid }
    }));
    assert.equal(unpaid.status, 200);
    assert.equal((await call('GET', '/api/billing/me', { token: user.idToken })).json.entitlement.active, false);

    const failedAsync = await postEvent(event('checkout.session.async_payment_failed', {
      id: 'cs_fail', payment_status: 'unpaid', customer, subscription: subId, client_reference_id: uid, metadata: { firebaseUid: uid }
    }));
    assert.equal(failedAsync.status, 200);
    assert.equal((await call('GET', '/api/billing/me', { token: user.idToken })).json.entitlement.active, false);

    const paidEvent = event('checkout.session.async_payment_succeeded', {
      id: 'cs_ok', payment_status: 'paid', customer, subscription: subId, client_reference_id: uid, metadata: { firebaseUid: uid }
    });
    const paid = await postEvent(paidEvent);
    assert.equal(paid.status, 200, paid.text);
    assert.equal(paid.json.duplicate, false);
    let me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.active, true);
    assert.equal(me.json.entitlement.access, 'paid');
    assert.equal(me.json.entitlement.currency, 'usd');
    assert.match(me.json.entitlement.summary, /USD 9\.99 per month/);
    const replay = await postEvent(paidEvent);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.duplicate, true);

    const tampered = sign(event('checkout.session.completed', { payment_status: 'paid', customer, subscription: subId, metadata: { firebaseUid: uid } }));
    const flipped = tampered.payload.replace('paid', 'unpaid');
    const bad = await call('POST', '/api/stripe/webhook', { raw: flipped, headers: { 'stripe-signature': tampered.header, 'content-type': 'application/json' } });
    assert.equal(bad.status, 400);

    fake.state.subs.set(subId, subscription({
      id: subId, status: 'active', priceId: 'price_usd_test', currency: 'usd', unitAmount: 999,
      periodEnd: 1_900_000_000, customer, uid
    }));
    const renewal = await postEvent(event('invoice.paid', {
      customer, amount_paid: 999, status: 'paid',
      parent: { subscription_details: { subscription: subId } }
    }));
    assert.equal(renewal.status, 200, renewal.text);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.currentPeriodEnd, 1_900_000_000_000);
    assert.equal(me.json.entitlement.active, true);

    fake.state.subs.set(subId, subscription({
      id: subId, status: 'past_due', priceId: 'price_usd_test', currency: 'usd', unitAmount: 999,
      periodEnd: 1_900_000_000, customer, uid
    }));
    const failedPay = await postEvent(event('invoice.payment_failed', {
      customer, amount_paid: 0, status: 'open', parent: { subscription_details: { subscription: subId } }
    }));
    assert.equal(failedPay.status, 200, failedPay.text);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.access, 'grace');
    assert.equal(me.json.entitlement.active, true);
    const graceUntil = me.json.entitlement.graceUntil;
    clock.t = graceUntil + 1000;
    const graceOver = await postEvent(event('customer.subscription.updated', fake.state.subs.get(subId)));
    assert.equal(graceOver.status, 200, graceOver.text);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.active, false);

    fake.state.subs.set(subId, subscription({
      id: subId, status: 'active', priceId: 'price_usd_test', currency: 'usd', unitAmount: 999,
      periodEnd: 2_000_000_000, customer, uid, cancel: true
    }));
    clock.t = Date.parse('2026-06-01T00:00:00Z');
    const scheduled = await postEvent(event('customer.subscription.updated', fake.state.subs.get(subId)));
    assert.equal(scheduled.status, 200, scheduled.text);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.active, true);
    assert.equal(me.json.entitlement.cancelAtPeriodEnd, true);

    const removed = await postEvent(event('customer.subscription.deleted', { ...fake.state.subs.get(subId), status: 'canceled' }));
    assert.equal(removed.status, 200, removed.text);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.active, false);

    fake.state.subs.set('sub_bad_' + suffix, subscription({
      id: 'sub_bad_' + suffix, status: 'active', priceId: 'price_free', currency: 'usd', unitAmount: 0,
      periodEnd: 2_000_000_000, customer, uid
    }));
    const wrong = await postEvent(event('customer.subscription.updated', fake.state.subs.get('sub_bad_' + suffix)));
    assert.equal(wrong.status, 200);
    me = await call('GET', '/api/billing/me', { token: user.idToken });
    assert.equal(me.json.entitlement.active, false);
    assert.equal(me.json.entitlement.reason, 'price_not_allowlisted');

    const stranger = await register('stranger' + suffix, 'stranger' + suffix + '@example.com');
    const conflict = await postEvent(event('customer.subscription.updated', subscription({
      id: subId, status: 'active', priceId: 'price_usd_test', currency: 'usd', unitAmount: 999,
      periodEnd: 2_100_000_000, customer, uid: stranger.localId
    })));
    assert.equal(conflict.status, 200);
    assert.equal(conflict.json.duplicate, false);
    const strangerMe = await call('GET', '/api/billing/me', { token: stranger.idToken });
    assert.equal(strangerMe.json.entitlement.active, false);
  });

  test('clients cannot write entitlements, usernames, or another person\'s plan', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const owner = await register('own' + suffix, 'own' + suffix + '@example.com');
    const other = await register('else' + suffix, 'else' + suffix + '@example.com');
    const fsBase = 'http://' + process.env.FIRESTORE_EMULATOR_HOST + '/v1/projects/demo-bracket/databases/(default)/documents';
    const plan = {
      fields: {
        v: { integerValue: '1' }, salt: { stringValue: 'c2FsdA==' }, iter: { integerValue: '600000' },
        iv: { stringValue: 'aXY=' }, z: { booleanValue: false }, data: { stringValue: 'Y2lwaGVy' }
      }
    };
    const ok = await fetch(fsBase + '/users/' + owner.localId + '?currentDocument.exists=false', {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify(plan)
    });
    assert.equal(ok.status, 200, await ok.text());
    const tamper = await fetch(fsBase + '/users/' + owner.localId, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { ...plan.fields, active: { booleanValue: true }, entitlement: { stringValue: 'paid' } } })
    });
    assert.equal(tamper.status, 403);
    const grant = await fetch(fsBase + '/entitlements/' + owner.localId, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify({ fields: { active: { booleanValue: true } } })
    });
    assert.equal(grant.status, 403);
    const names = await fetch(fsBase + '/usernames/own' + suffix, { headers: { authorization: 'Bearer ' + owner.idToken } });
    assert.equal(names.status, 403);
    const billing = await fetch(fsBase + '/billing/' + owner.localId, { headers: { authorization: 'Bearer ' + owner.idToken } });
    assert.equal(billing.status, 403);
    const otherPlan = await fetch(fsBase + '/users/' + other.localId, { headers: { authorization: 'Bearer ' + owner.idToken } });
    assert.equal(otherPlan.status, 403);
    const anon = await fetch(fsBase + '/users/' + owner.localId);
    assert.equal(anon.status, 403);

    await publishAccessPolicy(db, ['sync']);
    const gated = await fetch(fsBase + '/users/' + owner.localId, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify(plan)
    });
    assert.equal(gated.status, 403, await gated.text());
    await db.collection('entitlements').doc(owner.localId).set({
      active: true, access: 'paid', expiresAt: Timestamp.fromMillis(Date.now() + 86_400_000)
    });
    const allowed = await fetch(fsBase + '/users/' + owner.localId, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify(plan)
    });
    assert.equal(allowed.status, 200, await allowed.text());
    await db.collection('entitlements').doc(owner.localId).set({
      active: true, access: 'paid', expiresAt: Timestamp.fromMillis(Date.now() - 1000)
    });
    const expired = await fetch(fsBase + '/users/' + owner.localId, {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + owner.idToken, 'content-type': 'application/json' },
      body: JSON.stringify(plan)
    });
    assert.equal(expired.status, 403);
    await publishAccessPolicy(db, []);
  });

  test('a gated sync route refuses unpaid accounts and still cannot gate offline tools', async () => {
    assert.throws(() => configFromEnv({ PAID_FEATURES: 'calculator' }), /Offline tools/);
    const suffix = Math.random().toString(36).slice(2, 8);
    const user = await register('gate' + suffix, 'gate' + suffix + '@example.com');
    const gatedConfig = { ...config, gatedFeatures: ['sync'] };
    const handler = createHandler({
      config: gatedConfig,
      auth: (await import('firebase-admin/auth')).getAuth(),
      db,
      stripe: fake.api,
      root,
      now: () => clock.t,
      fetch: globalThis.fetch
    });
    const gatedServer = await startServer(handler);
    const gatedBase = 'http://127.0.0.1:' + gatedServer.address().port;
    const denied = await fetch(gatedBase + '/api/online/sync', { headers: { authorization: 'Bearer ' + user.idToken } });
    assert.equal(denied.status, 402);
    await db.collection('entitlements').doc(user.localId).set({
      active: true, access: 'paid', expiresAt: Timestamp.fromMillis(clock.t + 86_400_000), currency: 'usd'
    });
    const allowed = await fetch(gatedBase + '/api/online/sync', { headers: { authorization: 'Bearer ' + user.idToken } });
    assert.equal(allowed.status, 200);
    await new Promise((resolve) => gatedServer.close(resolve));
  });
});
