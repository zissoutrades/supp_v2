// Reset Test State
// Clears Firebase signaling and local test data
// Run this between test sessions to ensure clean state
//
// Usage:
//   npm run test:reset

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env.test') });

async function resetFirebase() {
  console.log('[Reset] Clearing Firebase signaling state...');

  if (!process.env.TEST_FIREBASE_DATABASE_URL) {
    console.log('[Reset] Firebase not configured - skipping');
    return;
  }

  try {
    const { initializeApp } = await import('firebase/app');
    const { getDatabase, ref, remove } = await import('firebase/database');

    const app = initializeApp({
      apiKey: process.env.TEST_FIREBASE_API_KEY,
      authDomain: process.env.TEST_FIREBASE_AUTH_DOMAIN,
      databaseURL: process.env.TEST_FIREBASE_DATABASE_URL,
      projectId: process.env.TEST_FIREBASE_PROJECT_ID,
      storageBucket: process.env.TEST_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.TEST_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.TEST_FIREBASE_APP_ID
    }, 'reset-script');

    const db = getDatabase(app);
    await remove(ref(db, 'rooms'));
    console.log('[Reset] ✓ Firebase cleared');
  } catch (error: any) {
    console.error('[Reset] Firebase reset failed:', error.message);
  }
}

function clearTestResults() {
  console.log('[Reset] Clearing test results...');

  const dirs = [
    path.resolve(__dirname, '../test-results'),
    path.resolve(__dirname, '../playwright-report')
  ];

  for (const dir of dirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`[Reset] ✓ Cleared ${path.basename(dir)}`);
    }
  }
}

async function main() {
  console.log('=== Supp v2 Test State Reset ===\n');

  await resetFirebase();
  clearTestResults();

  console.log('\n✓ Test state reset complete');
}

main().catch(console.error);
