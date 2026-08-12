import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';

export function getAdminDb() {
  if (!getApps().length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    const databaseURL = process.env.FIREBASE_DATABASE_URL;

    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON no está configurada.');
    if (!databaseURL) throw new Error('FIREBASE_DATABASE_URL no está configurada.');

    const serviceAccount = JSON.parse(raw);
    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    initializeApp({
      credential: cert(serviceAccount),
      databaseURL
    });
  }

  return getDatabase();
}
