import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let configured = false;

/** How this process should talk to Firebase Admin. Cloud Run sets K_SERVICE and has no key file. */
export function firebaseAdminMode(env, config) {
  const source = env || {};
  if (config && config.firebaseEmulator) return 'emulator';
  if (config && config.serviceAccountJson) return 'service-account-json';
  if (String(source.GOOGLE_APPLICATION_CREDENTIALS || '').trim()) return 'adc-file';
  if (String(source.K_SERVICE || '').trim() || String(source.K_REVISION || '').trim()) return 'adc-runtime';
  return 'off';
}

export function initFirebase(config, options = {}) {
  const mode = options.mode || firebaseAdminMode(process.env, config);
  if (mode === 'off') throw new Error('Firebase Admin is not configured');
  if (!getApps().length) {
    const appOptions = { projectId: config.projectId };
    if (mode === 'service-account-json') {
      appOptions.credential = cert(JSON.parse(config.serviceAccountJson));
    } else if (mode === 'adc-file' || mode === 'adc-runtime') {
      appOptions.credential = applicationDefault();
    }
    initializeApp(appOptions);
  }
  const db = getFirestore();
  if (!configured) {
    db.settings({ ignoreUndefinedProperties: true });
    configured = true;
  }
  return { auth: getAuth(), db };
}

export async function publishAccessPolicy(db, gatedFeatures) {
  await db.collection('accessPolicy').doc('current').set({
    gatedFeatures,
    offlineToolsRequireSubscription: false,
    updatedAt: Date.now()
  });
}
