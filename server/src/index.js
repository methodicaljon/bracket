import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from './config.js';
import { firebaseAdminMode, initFirebase, publishAccessPolicy } from './firebase.js';
import { createHandler } from './http.js';
import { createStripe } from './stripeClient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = configFromEnv();
const firebaseMode = firebaseAdminMode(process.env, config);
const firebase = firebaseMode === 'off' ? { auth: null, db: null } : initFirebase(config, { mode: firebaseMode });
const stripe = config.stripeSecretKey ? createStripe(config) : null;

if (firebase.db) {
  await publishAccessPolicy(firebase.db, config.gatedFeatures);
}

const handler = createHandler({
  config,
  auth: firebase.auth,
  db: firebase.db,
  stripe,
  root
});

const server = createServer((req, res) => {
  Promise.resolve(handler(req, res)).catch((err) => {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'SERVER' } }));
    }
    console.error('unhandled', err && err.name);
  });
});

server.listen(config.port, '0.0.0.0', () => {
  console.log('Bracket listening on ' + config.port);
});
