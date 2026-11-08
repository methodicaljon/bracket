import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const allow = new Set([
  'rk_test_replace_me',
  'sk_test_replace_me',
  'rk_test_placeholder',
  'whsec_replace_me',
  'whsec_placeholder',
  'price_replace_me'
]);
const skipDir = new Set(['node_modules', '.git', 'coverage', '.firebase']);
const pattern = /(?:rk|sk)_(?:test|live)_[A-Za-z0-9_]+|whsec_[A-Za-z0-9_]+|BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|"type"\s*:\s*"service_account"/g;

async function walk(dir, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (skipDir.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile() && entry.name !== 'check-secrets.mjs') out.push(full);
  }
}

const files = [];
await walk(root, files);
const problems = [];
for (const file of files) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch { continue; }
  if (text.includes('\0')) continue;
  for (const match of text.matchAll(pattern)) {
    if (!allow.has(match[0])) problems.push(path.relative(root, file) + ': ' + match[0].slice(0, 24));
  }
}
if (problems.length) {
  console.error('Refusing secrets or private credentials:\n' + problems.join('\n'));
  process.exit(1);
}
console.log('No secrets found in ' + files.length + ' files.');
