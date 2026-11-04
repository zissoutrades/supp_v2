// Shadow Email Pipeline E2E Tests
// Tests that new customer emails trigger ticket creation and shadow insertion.

import { test, expect, AGENT_EMAIL } from '../helpers/contexts.js';
import { waitForYjsSync, getTickets } from '../helpers/yjs-inspector.js';
import { createMockEmail } from '../helpers/gmail-mock.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { Page } from '@playwright/test';

let _sharedPage: Page | null = null;
let _agentPage: Page | null = null;
installFailureDump(() => _sharedPage, () => _agentPage);

/**
 * Inject a fake agent presence entry into the shared inbox Yjs doc.
 * Needed when Firebase P2P sync is not configured — without it, the shadow
 * service sees zero online agents and skips shadow insertion.
 */
async function injectAgentPresence(page: Page, agentEmail: string) {
  await page.evaluate(
    async ({ agentEmail }: { agentEmail: string }) => {
      await (window as any).__suppDebug.injectAwareness(99901, {
        agentId: 'test-agent-injected',
        email: agentEmail,
        lastSeen: Date.now(),
        isLeader: false,
        priority: 99,
        tokenVersions: [],
      });
    },
    { agentEmail },
  );
}

async function waitForLeader(page: Page) {
  // isLeader() returns a Promise — waitForFunction awaits it if the fn returns a Promise.
  await page.waitForFunction(
    () => (window as any).__suppDebug?.isLeader?.(),
    { timeout: 20_000 },
  );
}

test.describe('Shadow Email Pipeline', () => {

  test('new customer email creates a ticket in shared inbox', async ({ sharedPage, mock }) => {
    _sharedPage = sharedPage;

    const email = await mock.injectEmail(createMockEmail({
      subject: 'Order #999 missing',
      from: 'alice@example.com',
    }));

    // Wait for leader election to complete before polling
    await waitForLeader(sharedPage);

    // Trigger immediate poll instead of waiting 30s
    await sharedPage.evaluate(() => (window as any).__suppDebug?.triggerPoll?.());

    // Wait for a ticket with this originalThreadId to appear in Yjs
    await sharedPage.waitForFunction(
      async (threadId: string) => {
        const tickets: Array<[string, any]> = await (window as any).__suppDebug?.getTickets?.() ?? [];
        return tickets.some(([, t]) => t.originalThreadId === threadId);
      },
      email.threadId,
      { timeout: 15_000 },
    );

    const tickets = await getTickets(sharedPage);
    const entry = tickets.find(([, t]) => (t as any).originalThreadId === email.threadId);
    expect(entry).toBeTruthy();
    expect(entry![1]).toMatchObject({ status: 'open', assignee: null });
  });

  test('shadow email is inserted into agent Gmail', async ({ sharedPage, agentPage, mock }) => {
    _sharedPage = sharedPage;
    _agentPage = agentPage;

    const email = await mock.injectEmail(createMockEmail({ subject: 'Shadow insertion test' }));

    await waitForLeader(sharedPage);
    await injectAgentPresence(sharedPage, AGENT_EMAIL);
    await sharedPage.evaluate(() => (window as any).__suppDebug?.triggerPoll?.());

    // triggerPoll() now awaits the full pipeline (ticket + shadow insert).
    // Wait for ticket in Yjs (confirms the pipeline ran), then check insertCalls.
    await sharedPage.waitForFunction(
      async (threadId: string) => {
        const tickets: Array<[string, any]> = await (window as any).__suppDebug?.getTickets?.() ?? [];
        return tickets.some(([, t]) => t.originalThreadId === threadId);
      },
      email.threadId,
      { timeout: 15_000 },
    );

    // Mock server should have received a POST to the insert endpoint
    const insertCalls = await mock.getInsertCalls();
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  test('shadow email has correct RFC 2822 structure', async ({ sharedPage, mock }) => {
    _sharedPage = sharedPage;

    const email = await mock.injectEmail(createMockEmail({
      from: 'bob@customer.com',
      subject: 'RFC 2822 structure check',
    }));

    await waitForLeader(sharedPage);
    await injectAgentPresence(sharedPage, AGENT_EMAIL);
    await sharedPage.evaluate(() => (window as any).__suppDebug?.triggerPoll?.());

    // Wait for ticket creation (confirms full pipeline ran including shadow insert)
    await sharedPage.waitForFunction(
      async (threadId: string) => {
        const tickets: Array<[string, any]> = await (window as any).__suppDebug?.getTickets?.() ?? [];
        return tickets.some(([, t]) => t.originalThreadId === threadId);
      },
      email.threadId,
      { timeout: 15_000 },
    );

    const insertCalls = await mock.getInsertCalls();
    expect(insertCalls.length).toBeGreaterThan(0);

    const lastInsert = insertCalls[insertCalls.length - 1];
    expect(lastInsert.body).toContain('X-Supp-Ticket-ID:');
    expect(lastInsert.body).toContain('X-Supp-Customer-Email: bob@customer.com');
    expect(lastInsert.body).toContain('@tkt.suppapp.com');
    expect(lastInsert.body).toContain('INBOX');
    expect(lastInsert.body).toContain('UNREAD');
  });

});
