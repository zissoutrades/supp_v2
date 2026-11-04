// Get Test OAuth Tokens
// Helper script to capture OAuth tokens for test accounts
// Run this once per test account to populate .env.test
//
// Usage:
//   npx tsx scripts/get-test-tokens.ts

import { chromium } from '@playwright/test';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load existing .env.test to get email addresses
dotenv.config({ path: path.resolve(__dirname, '../.env.test') });

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '<your-client-id>';
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive.file'
].join(' ');

async function getTokenForAccount(accountEmail: string): Promise<string | null> {
  console.log(`\nObtaining token for: ${accountEmail}`);
  console.log('A browser window will open. Please sign in with this account.\n');

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  const redirectUri = 'http://localhost:9876/callback';
  const authUrl = `https://accounts.google.com/o/oauth2/auth` +
    `?client_id=${encodeURIComponent(CLIENT_ID)}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=token` +
    `&scope=${encodeURIComponent(SCOPES)}` +
    `&login_hint=${encodeURIComponent(accountEmail)}`;

  try {
    await page.goto(authUrl);

    // Wait for redirect to callback (timeout after 2 minutes)
    await page.waitForURL(new RegExp(redirectUri), { timeout: 120000 });

    const url = page.url();
    const match = url.match(/access_token=([^&]+)/);

    if (!match) {
      console.error('Failed to extract access token from URL');
      return null;
    }

    const token = match[1];
    console.log(`✓ Token obtained for ${accountEmail}`);
    console.log(`\nAdd this to your .env.test file:`);
    console.log(`TEST_SHARED_INBOX_TOKEN=${token}`);
    console.log('(or TEST_AGENT1_TOKEN if this is the agent account)\n');

    return token;

  } catch (error: any) {
    console.error(`Failed to get token: ${error.message}`);
    return null;
  } finally {
    await browser.close();
  }
}

async function main() {
  console.log('=== Supp v2 Test Token Capture ===\n');

  if (!process.env.GOOGLE_OAUTH_CLIENT_ID) {
    console.error('ERROR: GOOGLE_OAUTH_CLIENT_ID not found in .env.test');
    console.error('Please add your OAuth client ID to .env.test first.\n');
    console.error('You can create one at: https://console.cloud.google.com/apis/credentials\n');
    process.exit(1);
  }

  const sharedEmail = process.env.TEST_SHARED_INBOX_EMAIL;
  const agentEmail = process.env.TEST_AGENT1_EMAIL;

  if (!sharedEmail || !agentEmail) {
    console.error('ERROR: TEST_SHARED_INBOX_EMAIL and TEST_AGENT1_EMAIL must be set in .env.test');
    process.exit(1);
  }

  // Get token for shared inbox
  console.log('Step 1: Shared Inbox Account');
  await getTokenForAccount(sharedEmail);

  console.log('\n---\n');

  // Get token for agent
  console.log('Step 2: Agent Account');
  await getTokenForAccount(agentEmail);

  console.log('\n✓ Token capture complete!');
  console.log('Update your .env.test with the tokens printed above.');
}

main().catch(console.error);
