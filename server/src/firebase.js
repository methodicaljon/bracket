import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

let configured = false;

export function initFirebase(config) {
  if (!getApps().length) {
    const options = { projectId: config.projectId };
    if (!config.firebaseEmulator && config.serviceAccountJson) {
      options.credential = cert(JSON.parse(config.serviceAccountJson));
    } else if (!config.firebaseEmulator && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      options.credential = applicationDefault();
    }
    initializeApp(options);
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
