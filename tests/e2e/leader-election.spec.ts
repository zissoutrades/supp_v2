// Leader Election E2E Tests
// Verifies that exactly one leader exists at all times, that the shared inbox
// wins on startup (priority 1000 vs 99), and that the agent takes over when
// the shared inbox crashes.

import { test, expect } from '../helpers/contexts.js';
import { isLeader, waitForYjsSync } from '../helpers/yjs-inspector.js';

test.describe('Leader Election', () => {

  test('shared inbox becomes leader on startup', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    // Give leader election a moment to run and sync across contexts
    await new Promise(resolve => setTimeout(resolve, 5000));

    const sharedIsLeader = await isLeader(sharedPage);
    const agentIsLeader = await isLeader(agentPage);

    expect(sharedIsLeader).toBe(true);
    expect(agentIsLeader).toBe(false);
  });

  test('exactly one leader exists at all times', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    await new Promise(resolve => setTimeout(resolve, 5000));

    const leaders = [
      await isLeader(sharedPage),
      await isLeader(agentPage),
    ];
    const leaderCount = leaders.filter(Boolean).length;
    expect(leaderCount).toBe(1);
  });

  test('agent takes over leadership when shared inbox goes offline', async ({
    sharedPage, agentPage,
  }) => {
    await waitForYjsSync(sharedPage);
    await new Promise(resolve => setTimeout(resolve, 5000));

    expect(await isLeader(sharedPage)).toBe(true);

    // Simulate shared inbox crash — stops heartbeats and marks presence stale
    await sharedPage.evaluate(() => {
      (window as any).__suppDebug.simulateLeaderCrash();
    });

    // Wait for leader timeout (8s in test config) + election + re-election buffer
    await agentPage.waitForFunction(
      () => (window as any).__suppDebug.isLeader(),
      { timeout: 25_000 },
    );

    expect(await isLeader(agentPage)).toBe(true);
  });

});
