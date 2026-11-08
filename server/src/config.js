import { OFFERS, parseGated } from './entitlement.js';

export const API_VERSION = '2026-10-28.endive';

const PLACEHOLDERS = new Set(['rk_test_replace_me', 'sk_test_replace_me', 'whsec_replace_me', 'price_replace_me', '']);

function clean(value) {
  const text = String(value || '').trim();
  return PLACEHOLDERS.has(text) ? '' : text;
}

export function configFromEnv(env = process.env) {
  const secretKey = clean(env.STRIPE_SECRET_KEY);
  const webhookSecret = clean(env.STRIPE_WEBHOOK_SECRET);
  const priceUsd = clean(env.STRIPE_PRICE_USD);
  const priceCad = clean(env.STRIPE_PRICE_CAD);
  const gatedFeatures = parseGated(env.PAID_FEATURES || '');
  const graceDays = Number(env.GRACE_DAYS || 3);
  const bufferHours = Number(env.PAID_BUFFER_HOURS || 1);
  if (!Number.isFinite(graceDays) || graceDays < 0 || graceDays > 14) {
    throw new Error('GRACE_DAYS must be between 0 and 14');
  }
  if (!Number.isFinite(bufferHours) || bufferHours < 0 || bufferHours > 48) {
    throw new Error('PAID_BUFFER_HOURS must be between 0 and 48');
  }
  const keyLive = /_(live)_/.test(secretKey);
  const restrictedKey = secretKey.startsWith('rk_');
  const stripeKeyShape = /^(rk|sk)_(test|live)_/.test(secretKey);
  return {
    apiVersion: String(env.STRIPE_API_VERSION || API_VERSION).trim() || API_VERSION,
    publicBaseUrl: String(env.PUBLIC_BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, ''),
    port: Number(env.PORT || 8787),
    trustProxy: env.TRUST_PROXY === '1',
    enforceWebhookIps: env.ENFORCE_STRIPE_WEBHOOK_IPS === '1',
    webhookIps: String(env.STRIPE_WEBHOOK_IPS || '').split(',').map((s) => s.trim()).filter(Boolean),
    gatedFeatures,
    graceMs: graceDays * 24 * 60 * 60 * 1000,
    bufferMs: bufferHours * 60 * 60 * 1000,
    offers: OFFERS,
    stripeSecretKey: stripeKeyShape ? secretKey : '',
    stripeWebhookSecret: webhookSecret,
    priceUsd,
    priceCad,
    stripeApiReady: stripeKeyShape && !!priceUsd && !!priceCad,
    webhookReady: !!webhookSecret && stripeKeyShape,
    livemode: keyLive,
    restrictedKey,
    projectId: String(env.FIREBASE_PROJECT_ID || 'demo-bracket').trim(),
    webApiKey: String(env.FIREBASE_WEB_API_KEY || '').trim(),
    serviceAccountJson: String(env.FIREBASE_SERVICE_ACCOUNT_JSON || '').trim(),
    authEmulator: String(env.FIREBASE_AUTH_EMULATOR_HOST || '').trim(),
    firestoreEmulator: String(env.FIRESTORE_EMULATOR_HOST || '').trim(),
    firebaseEmulator: !!(env.FIREBASE_AUTH_EMULATOR_HOST && env.FIRESTORE_EMULATOR_HOST),
    limits: {
      register: 5,
      login: 10,
      reset: 5,
      delete: 5,
      windowMs: 15 * 60 * 1000
    }
  };
}

export function allowlistFrom(config) {
  return {
    [config.priceUsd]: { currency: 'usd', unitAmount: 999, country: 'US' },
    [config.priceCad]: { currency: 'cad', unitAmount: 999, country: 'CA' }
  };
}
