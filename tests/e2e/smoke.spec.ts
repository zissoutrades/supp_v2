// Smoke test — verifies the extension loads, content script runs, and debug bridge responds.

import { test, expect } from '../helpers/contexts.js';

test('extension debug bridge responds on localhost:4001', async ({ sharedPage }) => {
  // If we get here, the content script is running (fixture waited for ping response)
  const isLeader = await sharedPage.evaluate(() => (window as any).__suppDebug.isLeader());
  console.log('[Smoke] isLeader:', isLeader);

  const agentEmail = await sharedPage.evaluate(() => (window as any).__suppDebug.getAgentEmail());
  console.log('[Smoke] agentEmail:', agentEmail);

  expect(typeof isLeader).toBe('boolean');
});
