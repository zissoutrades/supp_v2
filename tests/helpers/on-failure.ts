// On-Failure Dump - Captures Yjs state when tests fail
// Saves state to test-results/failure-dumps/{test-name}.json for debugging

import { test, Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';

/**
 * Dump Yjs state from both browser contexts to a JSON file
 * Call this in test.afterEach() to capture state on failure
 */
export async function dumpStateOnFailure(
  testName: string,
  sharedPage: Page | null,
  agentPage: Page | null,
  testInfo: any
): Promise<void> {
  if (testInfo.status !== 'failed') {
    return;
  }

  console.log(`[Failure Dump] Test failed: ${testName}, capturing state...`);

  const dumpDir = path.join(process.cwd(), 'test-results', 'failure-dumps');
  fs.mkdirSync(dumpDir, { recursive: true });

  const dumpPath = path.join(dumpDir, `${testName.replace(/[^a-z0-9]/gi, '-')}.json`);

  const state: any = {
    testName,
    timestamp: new Date().toISOString(),
    sharedInbox: null,
    agent: null
  };

  try {
    if (sharedPage) {
      state.sharedInbox = await sharedPage.evaluate(async () => {
        const debug = (window as any).__suppDebug;
        return {
          tickets: await debug.getTickets(),
          presence: await debug.getPresence(),
          replyQueue: await debug.getReplyQueue(),
          cannedResponses: await debug.getCannedResponses(),
          syncState: await debug.getYjsSyncState(),
          isLeader: await debug.isLeader()
        };
      });
    }
  } catch (error) {
    state.sharedInbox = { error: String(error) };
  }

  try {
    if (agentPage) {
      state.agent = await agentPage.evaluate(async () => {
        const debug = (window as any).__suppDebug;
        return {
          tickets: await debug.getTickets(),
          presence: await debug.getPresence(),
          replyQueue: await debug.getReplyQueue(),
          cannedResponses: await debug.getCannedResponses(),
          syncState: await debug.getYjsSyncState(),
          isLeader: await debug.isLeader()
        };
      });
    }
  } catch (error) {
    state.agent = { error: String(error) };
  }

  fs.writeFileSync(dumpPath, JSON.stringify(state, null, 2));
  console.log(`[Failure Dump] State saved to ${dumpPath}`);
}

/**
 * Register a test.afterEach hook that dumps Yjs state on failure.
 * Call once at the top level of a spec file, passing getter functions
 * for the pages (which may be set/cleared by individual tests).
 */
export function installFailureDump(
  getSharedPage: () => Page | null,
  getAgentPage: () => Page | null,
): void {
  test.afterEach(async ({ }, testInfo) => {
    await dumpStateOnFailure(testInfo.title, getSharedPage(), getAgentPage(), testInfo);
  });
}
