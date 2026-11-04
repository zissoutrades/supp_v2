// scripts/setup-test-profiles.ts
// One-time setup: creates persistent Chromium profiles for Playwright tests
// with Gmail already logged in. Run this once before the first test run.
//
// Usage: npx tsx scripts/setup-test-profiles.ts

import { chromium } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const EXTENSION_PATH = path.resolve(__dirname, '../dist-test');
const PROFILE_SHARED = path.resolve(__dirname, '../tests/chrome-profiles/shared');
const PROFILE_AGENT  = path.resolve(__dirname, '../tests/chrome-profiles/agent');

// No special flags needed for login — system Chrome handles it natively.
const LAUNCH_ARGS: string[] = [];

async function setupProfile(profileDir: string, account: string): Promise<void> {
  fs.mkdirSync(profileDir, { recursive: true });

  console.log(`\n─────────────────────────────────────────────`);
  console.log(`Opening browser for: ${account}`);
  console.log(`Profile will be saved to: ${profileDir}`);
  console.log(`Log into Gmail as ${account}, then CLOSE THE BROWSER WINDOW.`);
  console.log(`─────────────────────────────────────────────`);

  // Use system Chrome (not Playwright's Chromium) — Google allows login in real Chrome.
  const ctx = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    args: LAUNCH_ARGS,
  });

  const page = await ctx.newPage();
  await page.goto('https://mail.google.com/mail/u/0/', { timeout: 30_000 }).catch(() => {});

  // Wait for the user to close the browser (up to 10 minutes)
  await ctx.waitForEvent('close', { timeout: 600_000 });
  console.log(`✓ Profile saved for ${account}`);
}

(async () => {
  if (!fs.existsSync(EXTENSION_PATH)) {
    console.error(`\n✗ Extension not built. Run 'npm run test:build' first.\n`);
    process.exit(1);
  }

  console.log('\nSetting up test profiles for Playwright.\n');
  console.log('You will need to log into Gmail in each browser window that opens.');
  console.log('Close each window after logging in to proceed to the next account.\n');

  await setupProfile(PROFILE_SHARED, 'supp.ext.testo@gmail.com (shared inbox)');
  await setupProfile(PROFILE_AGENT,  'suppv2.test.agent@gmail.com (agent)');

  console.log('\n✓ Both profiles set up. You can now run: npm test\n');
})();
