import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAccounts } from './accounts.js';
import { createBilling, publicOffer } from './billing.js';
import { allowlistFrom } from './config.js';
import { HttpError } from './errors.js';
import { OFFERS } from './entitlement.js';

const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/config.js', 'config.js'],
  ['/manifest.webmanifest', 'manifest.webmanifest'],
  ['/sw.js', 'sw.js'],
  ['/icon-192.png', 'icon-192.png'],
  ['/icon-512.png', 'icon-512.png'],
  ['/icon-maskable-512.png', 'icon-maskable-512.png']
]);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png'
};

// Bracket ships as one HTML file, so scripts and styles are inline. Stripe.js is not loaded.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://firestore.googleapis.com https://*.googleapis.com http://127.0.0.1:* http://localhost:*",
  "frame-src https://*.stripe.com https://*.stripe.network",
  "form-action 'self' https://checkout.stripe.com https://billing.stripe.com",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'"
].join('; ');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'TOO_LARGE'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function createHandler(deps) {
  const config = deps.config;
  const clock = deps.now || (() => Date.now());
  const logger = deps.logger || console;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const accounts = deps.auth && deps.db ? createAccounts({ ...deps, fetch: fetchImpl, now: clock }) : null;
  const billing = deps.db ? createBilling({
    db: deps.db,
    stripe: deps.stripe,
    config,
    allowlist: deps.allowlist || allowlistFrom(config),
    now: clock,
    randomInt: deps.randomInt
  }) : null;
  const hits = new Map();

  function allow(action, ip) {
    const limit = config.limits[action];
    const windowMs = config.limits.windowMs;
    const key = action + ':' + ip;
    const fresh = (hits.get(key) || []).filter((at) => clock() - at < windowMs);
    if (fresh.length >= limit) {
      hits.set(key, fresh);
      return false;
    }
    fresh.push(clock());
    hits.set(key, fresh);
    return true;
  }

  function send(res, status, body) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer'
    });
    res.end(JSON.stringify(body));
  }

  function fail(res, status, code) {
    send(res, status, { error: { message: code } });
  }

  async function requireUser(req) {
    if (!deps.auth) throw new HttpError(503, 'FIREBASE_NOT_CONFIGURED');
    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer\s+(\S+)$/);
    if (!match) throw new HttpError(401, 'UNAUTHENTICATED');
    try {
      const decoded = await deps.auth.verifyIdToken(match[1], true);
      return { uid: decoded.uid, email: decoded.email || null };
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED');
    }
  }

  async function userEmail(user) {
    if (user.email) return user.email;
    const record = await deps.auth.getUser(user.uid);
    if (!record.email) throw new HttpError(400, 'MISSING_EMAIL');
    return record.email;
  }

  async function serveStatic(req, res, pathname) {
    const name = PUBLIC_FILES.get(pathname);
    if (!name) return false;
    const file = path.resolve(deps.root, name);
    if (!file.startsWith(path.resolve(deps.root) + path.sep) && file !== path.resolve(deps.root)) return false;
    const ext = path.extname(name);
    const headers = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin',
      'x-frame-options': 'DENY',
      'cache-control': name === 'index.html' || name === 'sw.js' || name === 'config.js' ? 'no-cache' : 'public, max-age=86400'
    };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    createReadStream(file).pipe(res);
    return true;
  }

  return async function handler(req, res) {
    try {
      const url = new URL(req.url, config.publicBaseUrl);
      const pathname = url.pathname;
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        const served = await serveStatic(req, res, pathname);
        if (served) return;
        fail(res, 404, 'NOT_FOUND');
        return;
      }

      if (req.method === 'POST' && pathname === '/api/stripe/webhook') {
        if (!config.webhookReady || !deps.stripe) return fail(res, 503, 'WEBHOOK_NOT_CONFIGURED');
        if (config.enforceWebhookIps) {
          const ip = clientIp(req, config);
          if (!config.webhookIps.includes(ip)) return fail(res, 403, 'FORBIDDEN');
        }
        const raw = await readBody(req, 1024 * 1024);
        const signature = req.headers['stripe-signature'];
        let event;
        try {
          event = deps.stripe.webhooks.constructEvent(raw, signature, config.stripeWebhookSecret);
        } catch {
          return fail(res, 400, 'INVALID_SIGNATURE');
        }
        if (!billing) return fail(res, 503, 'FIREBASE_NOT_CONFIGURED');
        const result = await billing.applyEvent(event);
        return send(res, 200, { received: true, duplicate: !!result.duplicate });
      }

      const rawJson = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readBody(req, 32 * 1024);
      let body = {};
      if (rawJson.length) {
        try { body = JSON.parse(rawJson.toString('utf8')); }
        catch { throw new HttpError(400, 'INVALID_JSON'); }
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'INVALID_JSON');
      const ip = clientIp(req, config);

      if (req.method === 'GET' && pathname === '/api/health') {
        return send(res, 200, {
          ok: true,
          stripe: {
            api: !!config.stripeApiReady,
            webhook: !!config.webhookReady,
            livemode: !!config.livemode,
            restrictedKey: !!config.restrictedKey
          },
          firebase: { emulator: !!config.firebaseEmulator, admin: !!deps.auth },
          gatedFeatures: config.gatedFeatures,
          offlineToolsRequireSubscription: false,
          automaticTax: false,
          trial: false
        });
      }

      if (req.method === 'GET' && pathname === '/api/billing/offers') {
        return send(res, 200, {
          offers: OFFERS.map(publicOffer),
          trial: false,
          automaticTax: false,
          offlineToolsRequireSubscription: false,
          gatedFeatures: config.gatedFeatures
        });
      }

      if (req.method === 'POST' && pathname === '/api/auth/register') {
        if (!accounts) return fail(res, 503, 'FIREBASE_NOT_CONFIGURED');
        if (!allow('register', ip)) return fail(res, 429, 'TOO_MANY_ATTEMPTS_TRY_LATER');
        return send(res, 200, await accounts.register(body));
      }
      if (req.method === 'POST' && pathname === '/api/auth/login') {
        if (!accounts) return fail(res, 503, 'FIREBASE_NOT_CONFIGURED');
        if (!allow('login', ip)) return fail(res, 429, 'TOO_MANY_ATTEMPTS_TRY_LATER');
        return send(res, 200, await accounts.login(body));
      }
      if (req.method === 'POST' && pathname === '/api/auth/reset') {
        if (!accounts) return fail(res, 503, 'FIREBASE_NOT_CONFIGURED');
        if (!allow('reset', ip)) return fail(res, 429, 'TOO_MANY_ATTEMPTS_TRY_LATER');
        return send(res, 200, await accounts.reset(body));
      }
      if (req.method === 'POST' && pathname === '/api/auth/logout') {
        const user = await requireUser(req);
        return send(res, 200, await accounts.logout(user.uid));
      }
      if (req.method === 'POST' && pathname === '/api/auth/delete') {
        const user = await requireUser(req);
        if (!allow('delete', ip)) return fail(res, 429, 'TOO_MANY_ATTEMPTS_TRY_LATER');
        return send(res, 200, await accounts.removeAccount(user.uid, body.password, deps.stripe));
      }

      if (!billing && pathname.startsWith('/api/billing')) return fail(res, 503, 'FIREBASE_NOT_CONFIGURED');

      if (req.method === 'GET' && pathname === '/api/billing/me') {
        const user = await requireUser(req);
        const described = await billing.describe(user.uid);
        return send(res, 200, { email: user.email, ...described });
      }
      if (req.method === 'POST' && pathname === '/api/billing/checkout') {
        const user = await requireUser(req);
        const result = await billing.createCheckout({
          uid: user.uid,
          email: await userEmail(user),
          country: body.country
        });
        return send(res, 200, result);
      }
      if (req.method === 'POST' && pathname === '/api/billing/portal') {
        const user = await requireUser(req);
        return send(res, 200, await billing.createPortal({ uid: user.uid }));
      }
      if (req.method === 'GET' && pathname === '/api/billing/session') {
        const user = await requireUser(req);
        return send(res, 200, await billing.readSession({ uid: user.uid, sessionId: url.searchParams.get('session_id') }));
      }
      if (req.method === 'GET' && pathname === '/api/online/sync') {
        const user = await requireUser(req);
        if (!config.gatedFeatures.includes('sync')) return send(res, 200, { ok: true, gated: false, feature: 'sync' });
        const ent = await billing.readEntitlement(user.uid);
        if (!ent.active) return fail(res, 402, 'SUBSCRIPTION_REQUIRED');
        return send(res, 200, { ok: true, gated: true, feature: 'sync' });
      }

      if (pathname.startsWith('/api/')) return fail(res, 404, 'NOT_FOUND');
      return fail(res, 404, 'NOT_FOUND');
    } catch (err) {
      if (err instanceof HttpError) return fail(res, err.status, err.code);
      logger.error('request_failed', { name: err && err.name ? err.name : 'Error' });
      return fail(res, 500, 'SERVER');
    }
  };
}

export function startServer(handler) {
  return import('node:http').then(({ createServer }) => new Promise((resolve) => {
    const server = createServer((req, res) => {
      Promise.resolve(handler(req, res)).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'SERVER' } }));
        }
        console.error('unhandled', err && err.name);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  }));
}

export async function readStatic(root, name) {
  return readFile(path.join(root, name));
}
