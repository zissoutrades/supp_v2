// Dual Browser Context Fixture
// Provides two independent Chrome instances with the extension installed
// One for shared inbox (leader), one for agent

import { test as base, chromium, BrowserContext, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { GmailMockClient } from './gmail-mock.js';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load test environment
dotenv.config({ path: path.resolve(__dirname, '../../.env.test') });

const EXTENSION_PATH = path.resolve(__dirname, '../../dist-test');
// Test build injects content script on localhost:4001 (Mockoon) — no Gmail login needed.
const TEST_URL = 'http://localhost:4001/';

// ── Test accounts (from .env.test) ──────────────────────────────────────────
const SHARED_INBOX_EMAIL = process.env.TEST_SHARED_INBOX_EMAIL || 'supp.ext.testo@gmail.com';
const AGENT_EMAIL        = process.env.TEST_AGENT1_EMAIL       || 'suppv2.test.agent@gmail.com';

// Firebase config constructed from individual env vars
const TEST_FIREBASE_CONFIG = {
  apiKey:            process.env.TEST_FIREBASE_API_KEY,
  authDomain:        process.env.TEST_FIREBASE_AUTH_DOMAIN,
  databaseURL:       process.env.TEST_FIREBASE_DATABASE_URL,
  projectId:         process.env.TEST_FIREBASE_PROJECT_ID,
  storageBucket:     process.env.TEST_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.TEST_FIREBASE_MESSAGING_SENDER_ID,
  appId:             process.env.TEST_FIREBASE_APP_ID,
};
const TEST_ROOM_ID = process.env.TEST_FIREBASE_ROOM_ID || 'playwright-leader-test';

// ── Test team configuration ──────────────────────────────────────────────────
// sharedPage = main shared inbox (priority 1000 — always wins election).
// agentPage  = regular support agent (priority 99).
const TEST_TEAM_CONFIG = {
  version: 1,
  teamId: 'playwright-test-team',
  createdAt: Date.now(),
  sharedInboxEmail: SHARED_INBOX_EMAIL,
  mainAccount: {
    email: SHARED_INBOX_EMAIL,
    createdAt: Date.now(),
  },
  agents: [
    {
      agentId: 'test-agent-shared',
      email: SHARED_INBOX_EMAIL,
      name: 'Shared Inbox',
      role: 'owner',
      joinedAt: Date.now(),
      priority: 100,
    },
    {
      agentId: 'test-agent-1',
      email: AGENT_EMAIL,
      name: 'Agent 1',
      role: 'agent',
      joinedAt: Date.now(),
      priority: 99,
    },
  ],
  yjsRoomId: TEST_ROOM_ID,
  // firebaseConfig embedded so initP2PSync picks it up from teamConfig
  firebaseConfig: TEST_FIREBASE_CONFIG.apiKey ? TEST_FIREBASE_CONFIG : undefined,
  settings: {
    leaderHeartbeatInterval: 2000,  // faster for tests
    leaderTimeout: 8000,            // faster for tests (vs 15s in production)
    inboxCheckInterval: 30000,
  },
};

// ── Test OAuth tokens ────────────────────────────────────────────────────────
// Injected into chrome.storage.local so token-manager uses them in test builds
// (bypasses refresh token exchange — see token-manager.js test mode handling).
const TEST_TOKENS: Record<string, string> = {
  [SHARED_INBOX_EMAIL]: process.env.TEST_SHARED_INBOX_TOKEN || 'test-token-shared',
  [AGENT_EMAIL]:        process.env.TEST_AGENT1_TOKEN        || 'test-token-agent',
};

/**
 * Poll until the extension service worker appears in the context.
 * Needed because launchPersistentContext returns before the SW is registered,
 * and waitForEvent misses it when the SW was already running in a persistent profile.
 */
async function waitForServiceWorker(ctx: BrowserContext, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const workers = ctx.serviceWorkers();
    if (workers.length > 0) return workers[0];
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`Extension service worker did not appear within ${timeoutMs}ms — is the extension loaded?`);
}

/**
 * Inject team config and agent email into extension storage via the service worker.
 * Must be called before navigating to Gmail so the boot sequence picks up the config.
 */
async function injectTestConfig(ctx: BrowserContext, agentEmail: string): Promise<void> {
  const sw = await waitForServiceWorker(ctx);

  await sw.evaluate(
    ({ teamConfig, myEmail, firebaseConfig, teamRoomId, testTokens }: any) => {
      return new Promise<void>((resolve) => {
        chrome.storage.local.set({ teamConfig, myEmail, firebaseConfig, teamRoomId, testTokens }, resolve);
      });
    },
    {
      teamConfig: TEST_TEAM_CONFIG,
      myEmail: agentEmail,
      firebaseConfig: TEST_FIREBASE_CONFIG.apiKey ? TEST_FIREBASE_CONFIG : null,
      teamRoomId: TEST_ROOM_ID,
      testTokens: TEST_TOKENS,
    },
  );

  console.log(`[Test Fixture] Injected test config for ${agentEmail}`);

  // Inject the main-world __suppDebug proxy into every page in this context.
  // Content scripts run in an isolated world and cannot write to the page's window.
  // This proxy lives in the main world and communicates with the content script
  // via window.postMessage (both worlds share the same message channel).
  await ctx.addInitScript(() => {
    const MSG_REQ = '__supp_debug_req';
    const MSG_RES = '__supp_debug_res';
    const pending: Record<number, { resolve: (v: any) => void; reject: (e: any) => void }> = {};
    let _id = 0;

    window.addEventListener('message', (e) => {
      if (!e.data || e.data.type !== MSG_RES) return;
      const p = pending[e.data.id];
      if (p) {
        delete pending[e.data.id];
        if (e.data.error) p.reject(new Error(e.data.error));
        else p.resolve(e.data.result);
      }
    });

    function call(method: string, ...args: any[]): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++_id;
        pending[id] = { resolve, reject };
        setTimeout(() => {
          if (pending[id]) { delete pending[id]; reject(new Error(`__suppDebug.${method} timed out`)); }
        }, 8000);
        window.postMessage({ type: MSG_REQ, id, method, args }, '*');
      });
    }

    (window as any).__suppDebug = {
      getTickets:         () => call('getTickets'),
      getPresence:        () => call('getPresence'),
      getReplyQueue:      () => call('getReplyQueue'),
      getCannedResponses: () => call('getCannedResponses'),
      getYjsSyncState:    () => call('getYjsSyncState'),
      isLeader:           () => call('isLeader'),
      getAgentEmail:      () => call('getAgentEmail'),
      waitForSync:        (ms: number) => call('waitForSync', ms),
      disconnectWebRTC:   () => call('disconnectWebRTC'),
      reconnectWebRTC:    () => call('reconnectWebRTC'),
      simulateLeaderCrash: () => call('simulateLeaderCrash'),
      triggerPoll:        () => call('triggerPoll'),
      setMapEntry:              (mapName: string, key: string, value: any) => call('setMapEntry', mapName, key, value),
      getMapEntry:              (mapName: string, key: string) => call('getMapEntry', mapName, key),
      pushArrayEntry:           (arrayName: string, value: any) => call('pushArrayEntry', arrayName, value),
      openSidePanel:            (ticketId: string) => call('openSidePanel', ticketId),
      getFirebaseYjsSyncState:  () => call('getFirebaseYjsSyncState'),
      disconnectWebRTCKeepFirebase: () => call('disconnectWebRTCKeepFirebase'),
      getFilteredView:          (routeId: string) => call('getFilteredView', routeId),
      getYjsDoc:                () => call('getYjsDoc'),
      getPersonalCannedResponses: () => call('getPersonalCannedResponses'),
      savePersonalCannedResponse: (cr: any) => call('savePersonalCannedResponse', cr),
      substituteVariables:      (body: string, ticketId: string | null, agentName: string) =>
                                  call('substituteVariables', body, ticketId, agentName),
      injectAwareness:          (fakeClientId: number, state: any) => call('injectAwareness', fakeClientId, state),
    };
  });
}

const LAUNCH_ARGS = [
  `--disable-extensions-except=${EXTENSION_PATH}`,
  `--load-extension=${EXTENSION_PATH}`,
];

/** Create a fresh unique temp dir for each browser context — avoids accumulated IndexedDB state. */
function makeTempUserDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'supp-test-'));
}

interface TestFixtures {
  sharedCtx: BrowserContext;
  sharedPage: Page;
  agentCtx: BrowserContext;
  agentPage: Page;
  mock: GmailMockClient;
}

/**
 * Extended Playwright test with dual browser contexts
 */
export const test = base.extend<TestFixtures>({
  // Shared inbox browser context
  sharedCtx: async ({}, use) => {
    console.log('[Test Fixture] Launching shared inbox context...');
    const userDataDir = makeTempUserDataDir();
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: LAUNCH_ARGS,
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    await injectTestConfig(ctx, SHARED_INBOX_EMAIL);
    await use(ctx);
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // Shared inbox page — navigates to localhost:4001 (Mockoon), no Gmail login needed
  sharedPage: async ({ sharedCtx }, use) => {
    const page = await sharedCtx.newPage();
    await page.goto(TEST_URL);
    // Wait for the content script to respond to a debug ping (proves it's running)
    await page.waitForFunction(() => {
      return (window as any).__suppDebug.isLeader().then(() => true).catch(() => false);
    }, { timeout: 20000 });
    console.log('[Test Fixture] Shared inbox page ready');
    await use(page);
    await page.close();
  },

  // Agent browser context
  agentCtx: async ({}, use) => {
    console.log('[Test Fixture] Launching agent context...');
    const userDataDir = makeTempUserDataDir();
    const ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: LAUNCH_ARGS,
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    await injectTestConfig(ctx, AGENT_EMAIL);
    await use(ctx);
    await ctx.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // Agent page — navigates to localhost:4001 (Mockoon), no Gmail login needed
  agentPage: async ({ agentCtx }, use) => {
    const page = await agentCtx.newPage();
    await page.goto(TEST_URL);
    // Wait for the debug bridge to respond — agents may not become leader (deferral logic
    // prevents non-sharedInbox agents from claiming leadership without P2P sync), so we
    // check getYjsSyncState() instead of isLeader() here.
    await page.waitForFunction(() => {
      return (window as any).__suppDebug.getYjsSyncState()
        .then((s: string) => s !== undefined)
        .catch(() => false);
    }, { timeout: 20000 });
    console.log('[Test Fixture] Agent page ready');
    await use(page);
    await page.close();
  },

  // Gmail mock client
  mock: async ({}, use) => {
    const mockClient = new GmailMockClient();
    await mockClient.reset();
    await use(mockClient);
    await mockClient.reset();
  },
});

export { expect } from '@playwright/test';
export { SHARED_INBOX_EMAIL, AGENT_EMAIL };
