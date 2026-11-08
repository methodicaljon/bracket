import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const pwField = html.slice(html.indexOf('function pwField'), html.indexOf('function hidePasswords'));
const SECRET = 'pw-sample-9';

test('password markup stays masked and uses password autocomplete', () => {
  assert.match(pwField, /type="password"/);
  assert.equal(pwField.includes("type=\"' + (shown"), false);
  assert.match(pwField, /autocomplete="' \+ kind \+ '"/);
  assert.match(pwField, /autocapitalize="off"/);
  assert.match(pwField, /autocorrect="off"/);
  assert.match(pwField, /spellcheck="false"/);
  assert.match(pwField, /data-password="1"/);
  assert.equal(html.includes("pwField('a-old', 'Old password', 'off')"), false);
  assert.match(html, /pwField\('a-old', 'Old password', 'current-password'\)/);
  assert.match(html, /function hidePasswords/);
  assert.match(html, /a\.dropPasswords = true/);
});

test('sign-in, create, and reset do not leave a password in a text field', { timeout: 30000 }, async (t) => {
  let puppeteer;
  try { puppeteer = await import('puppeteer-core'); } catch { puppeteer = null; }
  const chrome = ['/usr/local/bin/google-chrome', '/usr/bin/google-chrome'].find((file) => {
    try { readFileSync(file); return true; } catch { return false; }
  });
  if (!puppeteer || !chrome) {
    t.skip('Chrome is not available for the password-field interaction test');
    return;
  }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
    if (!['index.html', 'config.js', 'manifest.webmanifest', 'sw.js'].includes(name) && !name.startsWith('icon-')) {
      res.writeHead(404); res.end(); return;
    }
    const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.html') ? 'text/html' : 'text/plain';
    res.writeHead(200, { 'content-type': type });
    res.end(readFileSync(path.join(root, name)));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port + '/', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('#w-signin', { timeout: 15000 });
    await page.click('#w-signin');
    await page.waitForSelector('#a-pass');
    const signIn = await fieldInfo(page, '#a-pass');
    assert.equal(signIn.type, 'password');
    assert.equal(signIn.autocomplete, 'current-password');
    assert.equal(signIn.autocapitalize, 'off');
    assert.equal(signIn.autocorrect, 'off');
    assert.equal(signIn.spellcheck, false);
    await page.type('#a-pass', SECRET);
    await page.click('[data-pw="a-pass"]');
    assert.equal(await page.$eval('#a-pass', (el) => el.type), 'text');
    await page.click('[data-acct="create"]');
    await page.waitForFunction(() => document.querySelector('#a-pass') && document.querySelector('#a-pass').autocomplete === 'new-password');
    const created = await fieldInfo(page, '#a-pass');
    assert.equal(created.type, 'password');
    assert.equal(created.autocomplete, 'new-password');
    assert.equal(created.value, '');
    assert.deepEqual(await leaked(page), []);
    await page.type('#a-pass', SECRET);
    await page.click('[data-pw="a-pass"]');
    await page.click('[data-acct="signin"]');
    await page.waitForFunction(() => document.querySelector('#a-pass') && document.querySelector('#a-pass').autocomplete === 'current-password');
    assert.equal(await page.$eval('#a-pass', (el) => el.type), 'password');
    assert.equal(await page.$eval('#a-pass', (el) => el.value), '');
    await page.click('[data-acct-identity="email"]');
    await page.waitForSelector('#a-pass');
    assert.equal(await page.$eval('#a-pass', (el) => el.type), 'password');
    assert.equal(await page.$eval('#a-pass', (el) => el.value), '');
    await page.click('[data-acct-mode="reset"]');
    await page.waitForSelector('#a-recover');
    assert.equal(await page.$('#a-pass'), null);
    assert.deepEqual(await leaked(page), []);
    const stored = await page.evaluate((secret) => JSON.stringify(window.localStorage).includes(secret), SECRET);
    assert.equal(stored, false);
    const rendered = await page.evaluate((secret) => document.documentElement.outerHTML.includes(secret), SECRET);
    assert.equal(rendered, false);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

function fieldInfo(page, selector) {
  return page.$eval(selector, (el) => ({
    type: el.type,
    autocomplete: el.getAttribute('autocomplete'),
    autocapitalize: el.getAttribute('autocapitalize'),
    autocorrect: el.getAttribute('autocorrect'),
    spellcheck: el.spellcheck,
    value: el.value
  }));
}

function leaked(page) {
  return page.evaluate((secret) => [...document.querySelectorAll('input, textarea')].filter((el) => el.type !== 'password' && String(el.value || '').includes(secret)).map((el) => el.id), SECRET);
}
