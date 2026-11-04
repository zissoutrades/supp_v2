// Firebase Reset — Global Setup
// Clears Firebase signaling state before the test suite runs
// Runs once per test session (not per test)

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load test environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

async function waitForMockoon(url: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status === 404) return; // server is up
    } catch {
      // not yet ready
    }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`[Global Setup] Mockoon did not become ready at ${url} within ${timeoutMs}ms`);
}

async function globalSetup() {
  console.log('[Global Setup] Waiting for Mockoon on port 4001...');
  await waitForMockoon('http://localhost:4001/');
  console.log('[Global Setup] Mockoon is ready');

  console.log('[Global Setup] Clearing Firebase signaling state...');

  // Check if Firebase credentials are configured
  if (!process.env.TEST_FIREBASE_DATABASE_URL) {
    console.warn('[Global Setup] Firebase credentials not found in .env.test - skipping Firebase reset');
    console.warn('[Global Setup] This is expected if you haven\'t set up Firebase yet');
    return;
  }

  try {
    // Import Firebase dynamically to avoid errors if not configured
    const { initializeApp } = await import('firebase/app');
    const { getDatabase, ref, remove } = await import('firebase/database');

    const firebaseConfig = {
      apiKey: process.env.TEST_FIREBASE_API_KEY,
      authDomain: process.env.TEST_FIREBASE_AUTH_DOMAIN,
      databaseURL: process.env.TEST_FIREBASE_DATABASE_URL,
      projectId: process.env.TEST_FIREBASE_PROJECT_ID,
      storageBucket: process.env.TEST_FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.TEST_FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.TEST_FIREBASE_APP_ID
    };

    const app = initializeApp(firebaseConfig, 'test-cleanup');
    const db = getDatabase(app);

    // Clear signaling rooms (used in sub-phase 02+)
    // Wrap in a timeout so a slow/unreachable Firebase does not hang globalSetup
    await Promise.race([
      remove(ref(db, 'rooms')),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('Firebase reset timed out after 8s')), 8000)),
    ]);
    console.log('[Global Setup] Firebase signaling state cleared');

  } catch (error: any) {
    console.warn('[Global Setup] Firebase reset failed (this is OK if Firebase not yet set up):', error.message);
  }
}

export default globalSetup;
