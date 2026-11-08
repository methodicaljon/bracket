import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { configFromEnv } from '../src/config.js';
import { firebaseAdminMode } from '../src/firebase.js';
import { createHandler, startServer } from '../src/http.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const config = configFromEnv({
  FIREBASE_PROJECT_ID: 'bracket-2b961',
  FIREBASE_WEB_API_KEY: 'AIzaSyDEMOKEYBRACKET123456',
  PUBLIC_BASE_URL: 'http://127.0.0.1:8787'
});

test('Cloud Run uses runtime ADC and a local machine without credentials stays off', () => {
  assert.equal(firebaseAdminMode({ K_SERVICE: 'bracket' }, config), 'adc-runtime');
  assert.equal(firebaseAdminMode({ K_REVISION: 'bracket-00002-abc' }, config), 'adc-runtime');
  assert.equal(firebaseAdminMode({ GOOGLE_APPLICATION_CREDENTIALS: '/secrets/adc.json' }, config), 'adc-file');
  assert.equal(firebaseAdminMode({}, config), 'off');
  assert.equal(firebaseAdminMode({ K_SERVICE: '   ', GOOGLE_APPLICATION_CREDENTIALS: '  ' }, config), 'off');
  assert.equal(firebaseAdminMode({ K_SERVICE: 'bracket' }, { ...config, firebaseEmulator: true }), 'emulator');
  assert.equal(
    firebaseAdminMode({ K_SERVICE: 'bracket' }, { ...config, serviceAccountJson: '{"client_email":"example@example.iam.gserviceaccount.com"}' }),
    'service-account-json'
  );
});

test('register without Firebase Admin is 503 and does not start Stripe webhooks', async () => {
  assert.equal(firebaseAdminMode({}, config), 'off');
  const server = await startServer(createHandler({ config, auth: null, db: null, stripe: null, root }));
  try {
    const port = server.address().port;
    const register = await fetch('http://127.0.0.1:' + port + '/api/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    });
    const body = await register.json();
    assert.equal(register.status, 503);
    assert.equal(body.error.message, 'FIREBASE_NOT_CONFIGURED');
    const health = await fetch('http://127.0.0.1:' + port + '/api/health');
    const healthBody = await health.json();
    assert.equal(healthBody.firebase.admin, false);
    assert.equal(healthBody.firebase.emulator, false);
    assert.equal(healthBody.stripe.webhook, false);
    assert.equal(healthBody.offlineToolsRequireSubscription, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
