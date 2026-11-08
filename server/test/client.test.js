import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { inflateSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');

function extract(marker) {
  const at = html.indexOf(marker);
  assert.ok(at > 0, marker);
  const start = html.lastIndexOf('<script>', at) + '<script>'.length;
  const end = html.indexOf('</script>', at);
  return html.slice(start, end);
}

function browserGlobal() {
  const sandbox = {
    console, Uint8Array, TextEncoder, TextDecoder, Promise, JSON, Array, Object, String, Math, Number, Error, Date, Map, Set,
    parseInt, parseFloat, isFinite, Infinity, btoa: globalThis.btoa, atob: globalThis.atob
  };
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  sandbox.crypto = globalThis.crypto;
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  return sandbox;
}

test('public Firebase web config is present and Analytics is not loaded', () => {
  const config = readFileSync(path.join(root, 'config.js'), 'utf8');
  assert.match(config, /apiKey: "AIzaSyD5JE62xVaHn5uDvWPr7SaysaD6byzzyvg"/);
  assert.match(config, /authDomain: "bracket-2b961\.firebaseapp\.com"/);
  assert.match(config, /projectId: "bracket-2b961"/);
  assert.match(config, /storageBucket: "bracket-2b961\.firebasestorage\.app"/);
  assert.match(config, /messagingSenderId: "738923787461"/);
  assert.match(config, /appId: "1:738923787461:web:e4678adbed978a28af6cac"/);
  assert.equal(/measurementId\s*:/.test(config), false);
  assert.equal(html.includes('googletagmanager'), false);
  assert.equal(html.includes('firebase-analytics'), false);
  assert.equal(html.includes('G-1LVNHGJJZE'), false);
});

test('a missing server identity has its own message', () => {
  const cloud = browserGlobal();
  vm.runInContext(extract('/* Bracket accounts and sync.'), cloud);
  assert.equal(cloud.module.exports.messageFor('FIREBASE_NOT_CONFIGURED'), 'Sign-in isn\'t available on this server yet.');
});

test('inline scripts parse', () => {
  const parts = html.split('<script>').slice(1);
  assert.ok(parts.length >= 5);
  for (const part of parts) {
    const code = part.slice(0, part.indexOf('</script>'));
    new vm.Script(code, { filename: 'index-inline.js' });
  }
});

test('local plan storage and encryption format are unchanged', () => {
  assert.match(html, /var STORE = 'bracket\.v1'/);
  assert.match(html, /var META = 'bracket\.sync'/);
  assert.match(html, /var FORMAT = 1/);
  assert.match(html, /var ITER = 600000/);
  const cloud = browserGlobal();
  vm.runInContext(extract('/* Bracket accounts and sync.'), cloud);
  const api = cloud.module.exports;
  assert.equal(api.MIN_PASSWORD, 8);
  const password = 'correct horse';
  const salt = new Uint8Array(16).fill(7);
  return api._t.deriveKey(password, salt, 1000).then((key) => {
    return api._t.seal(key, 'uid-1', JSON.stringify({ app: 'bracket', v: 1, state: { gross: 10 } })).then((box) => {
      return api._t.open(key, 'uid-1', box).then((text) => {
        assert.equal(JSON.parse(text).state.gross, 10);
      });
    });
  });
});

test('email sign-in still calls Firebase and username sign-in calls the server', async () => {
  const cloud = browserGlobal();
  vm.runInContext(extract('/* Bracket accounts and sync.'), cloud);
  const api = cloud.module.exports;
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(String(url));
    const href = String(url);
    if (href.includes('/api/auth/login') || href.includes('/api/auth/register')) {
      return json({ idToken: 'id', refreshToken: 'refresh', expiresIn: '3600', localId: 'uid-1', email: 'owner@example.com', username: 'ada' });
    }
    if (href.includes('accounts:signInWithPassword') || href.includes('accounts:signUp')) {
      return json({ idToken: 'id', refreshToken: 'refresh', expiresIn: '3600', localId: 'uid-1', email: 'owner@example.com' });
    }
    return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
  };
  const storage = memory();
  const cfg = api.configFrom({ firebase: { apiKey: 'AIzaSyDEMOKEYBRACKET123456', projectId: 'demo-bracket' } });
  const session = api.create({
    config: cfg,
    apiBase: 'http://accounts.local',
    fetch,
    storage,
    hooks: { snapshot: () => ({}), apply: () => true, hasPlan: () => false, changed: () => {} },
    delay: 1000
  });
  await session.signIn('owner@example.com', 'password1');
  assert.ok(calls.some((url) => url.includes('accounts:signInWithPassword')));
  assert.equal(calls.some((url) => url.includes('/api/auth/login')), false);
  calls.length = 0;
  await session.signOut(true);
  await session.signInUsername('Ada', 'password1');
  assert.ok(calls.some((url) => url.includes('/api/auth/login')));
  assert.equal(calls.some((url) => url.includes('accounts:signInWithPassword')), false);
  const info = session.info();
  assert.equal(info.signedIn, true);
  assert.equal(info.username, 'ada');
  assert.equal(info.email, 'owner@example.com');
});

test('Canadian and US tax engines still calculate', () => {
  const sandbox = browserGlobal();
  vm.runInContext(extract('/* Bracket tax engine:'), sandbox);
  vm.runInContext(extract('/* Bracket US tax engine'), sandbox);
  const tax = sandbox.BracketTax;
  assert.equal(tax.countryOf('ON'), 'CA');
  assert.equal(tax.countryOf('AZ'), 'US');
  const on = tax.calc(72500, 'ON');
  const az = tax.calc(72500, 'AZ');
  assert.equal(on.gross, 72500);
  assert.ok(on.incomeTax > 8000 && on.incomeTax < 20000);
  assert.ok(on.net < on.gross);
  assert.equal(tax.calc(72500, 'ON').incomeTax, on.incomeTax);
  assert.equal(az.gross, 72500);
  assert.ok(az.fed > 0 || az.incomeTax > 0);
  assert.equal(tax.known('ON'), true);
  assert.equal(tax.known('ZZ'), false);
});

test('original icon files keep their roles', () => {
  const expected = {
    'icon-192.png': '07130e1d1482fded273b33c2d89b36fc76b8019c1f47af27b8afffcde2196419',
    'icon-512.png': '605f610fd0f18f064bad7d482c1943538045dabf6e94514402807229184d1856',
    'icon-maskable-512.png': '15e98bc1968f5239354790c16da058870ede98053f275581385419dcaffd32fd'
  };
  for (const [name, hash] of Object.entries(expected)) {
    const bytes = readFileSync(path.join(root, name));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), hash);
  }
  const regular = corners(readFileSync(path.join(root, 'icon-512.png')));
  const maskable = corners(readFileSync(path.join(root, 'icon-maskable-512.png')));
  const small = corners(readFileSync(path.join(root, 'icon-192.png')));
  assert.equal(regular[0][3], 0, 'regular 512 icon has transparent corners');
  assert.equal(small[0][3], 0, '192 icon has transparent corners');
  assert.equal(maskable[0][3], 255, 'maskable icon is full bleed');
  assert.equal(maskable[3][3], 255);
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.webmanifest'), 'utf8'));
  const icons = Object.fromEntries(manifest.icons.map((icon) => [icon.purpose || 'any', icon.src]));
  assert.equal(icons.any, 'icon-512.png');
  assert.equal(icons.maskable, 'icon-maskable-512.png');
  assert.ok(manifest.icons.some((icon) => icon.src === 'icon-192.png' && !icon.purpose));
});

test('service worker drops stale caches and does not cache API responses', async () => {
  const source = readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(source, /bracket-v7/);
  const store = new Map();
  const listeners = {};
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return new Response('fresh', { status: 200 });
  };
  const caches = {
    async open(name) {
      if (!store.has(name)) store.set(name, new Map());
      const bucket = store.get(name);
      return {
        async addAll() {},
        async put(req) { bucket.set(req.url, true); },
        async match(req) { return bucket.get(typeof req === 'string' ? req : req.url); }
      };
    },
    async keys() { return [...store.keys()]; },
    async delete(name) { return store.delete(name); },
    async match(req) {
      for (const bucket of store.values()) {
        if (bucket.get(req.url)) return new Response('cached-' + req.url, { status: 200 });
      }
      return undefined;
    }
  };
  const sandbox = { URL, Response, Promise, console, caches, fetch: fetchImpl };
  sandbox.self = {
    location: { origin: 'http://localhost' },
    addEventListener(type, fn) { listeners[type] = fn; },
    skipWaiting() { return Promise.resolve(); },
    clients: { claim() { return Promise.resolve(); } }
  };
  vm.runInNewContext(source, sandbox, { filename: 'sw.js' });
  store.set('bracket-v6', new Map([['http://localhost/index.html', true]]));
  let activateDone;
  listeners.activate({ waitUntil(p) { activateDone = p; } });
  await activateDone;
  assert.equal(store.has('bracket-v6'), false);

  let apiResponded = false;
  listeners.fetch({
    request: { method: 'GET', url: 'http://localhost/api/billing/me' },
    respondWith() { apiResponded = true; }
  });
  assert.equal(apiResponded, false);

  let body = '';
  let freshDone;
  listeners.fetch({
    request: { method: 'GET', url: 'http://localhost/index.html' },
    respondWith(p) { freshDone = p.then((res) => res.text()).then((text) => { body = text; }); }
  });
  await freshDone;
  assert.equal(body, 'fresh');
  assert.ok(fetchCalls >= 1);
  assert.equal(store.get('bracket-v7').has('http://localhost/index.html'), true);
  const before = store.get('bracket-v7').size;
  let notesDone;
  listeners.fetch({
    request: { method: 'GET', url: 'http://localhost/notes.txt' },
    respondWith(p) { notesDone = p; }
  });
  await notesDone;
  assert.equal(store.get('bracket-v7').has('http://localhost/notes.txt'), false);
  assert.equal(store.get('bracket-v7').size, before);

  store.get('bracket-v7').set('http://localhost/index.html', true);
  sandbox.fetch = async () => { throw new Error('offline'); };
  let offline = '';
  let offlineDone;
  listeners.fetch({
    request: { method: 'GET', url: 'http://localhost/index.html' },
    respondWith(p) { offlineDone = p.then((res) => res && res.text ? res.text() : '').then((text) => { offline = text; }); }
  });
  await offlineDone;
  assert.match(offline, /cached-|index\.html/);
});

function json(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function memory() {
  const data = new Map();
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function corners(bytes) {
  const rows = decodePng(bytes);
  const h = rows.length;
  const w = rows[0].length / 4;
  const px = (x, y) => {
    const row = rows[y];
    const o = x * 4;
    return [row[o], row[o + 1], row[o + 2], row[o + 3]];
  };
  return [px(0, 0), px(w - 1, 0), px(0, h - 1), px(w - 1, h - 1)];
}

function decodePng(bytes) {
  const data = bytes instanceof Buffer ? bytes : Buffer.from(bytes);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let pos = 8;
  let width = 0;
  let height = 0;
  let color = 0;
  const idat = [];
  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.subarray(pos + 4, pos + 8).toString('ascii');
    const chunk = data.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      color = chunk[9];
    } else if (type === 'IDAT') idat.push(chunk);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  assert.equal(color, 6);
  const raw = inflate(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  const rows = [];
  let i = 0;
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[i++];
    const row = Buffer.from(raw.subarray(i, i + stride));
    i += stride;
    if (filter === 1) {
      for (let x = 0; x < row.length; x++) row[x] = (row[x] + (x >= bpp ? row[x - bpp] : 0)) & 255;
    } else if (filter === 2) {
      for (let x = 0; x < row.length; x++) row[x] = (row[x] + prev[x]) & 255;
    } else if (filter === 0) {
      /* none */
    } else if (filter === 3) {
      for (let x = 0; x < row.length; x++) {
        const left = x >= bpp ? row[x - bpp] : 0;
        row[x] = (row[x] + Math.floor((left + prev[x]) / 2)) & 255;
      }
    } else if (filter === 4) {
      const paeth = (a, b, c) => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      };
      for (let x = 0; x < row.length; x++) {
        const a = x >= bpp ? row[x - bpp] : 0;
        const b = prev[x];
        const c = x >= bpp ? prev[x - bpp] : 0;
        row[x] = (row[x] + paeth(a, b, c)) & 255;
      }
    } else throw new Error('png filter ' + filter);
    rows.push(row);
    prev = row;
  }
  return rows;
}

function inflate(buffer) {
  return Buffer.from(inflateSync(buffer));
}
