// Reply Flow E2E Tests
// Tests that agent replies are queued in Yjs and the leader dispatches them.

import { test, expect } from '../helpers/contexts.js';
import { getReplyQueue } from '../helpers/yjs-inspector.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { Page } from '@playwright/test';

let _sharedPage: Page | null = null;
let _agentPage:  Page | null = null;
installFailureDump(() => _sharedPage, () => _agentPage);

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function waitForLeader(page: Page) {
  await page.waitForFunction(
    () => (window as any).__suppDebug?.isLeader?.(),
    { timeout: 20_000 },
  );
}

/** Seed a minimal ticket directly into the Yjs tickets map via debug bridge. */
async function seedTicket(page: Page, ticket: {
  ticketId: string;
  originalThreadId: string;
  customerEmail: string;
  customerName: string;
  subject: string;
  shadowEmail: string;
  status?: string;
}) {
  const data = {
    ticketId:         ticket.ticketId,
    originalThreadId: ticket.originalThreadId,
    customerEmail:    ticket.customerEmail,
    customerName:     ticket.customerName,
    subject:          ticket.subject,
    shadowEmail:      ticket.shadowEmail,
    status:           ticket.status ?? 'open',
    assignee:         null,
    tags:             [],
    notes:            '',
    customerId:       '',
    shadowThreads:    {},
    excluded:         false,
    createdAt:        Date.now(),
    lastModified:     Date.now(),
    messageCount:     1,
    lastReply:        null,
    lastReplyBy:      null,
  };
  await page.evaluate(
    ([ticketId, ticketData]) => (window as any).__suppDebug.setMapEntry('tickets', ticketId, ticketData),
    [ticket.ticketId, data] as [string, any],
  );
}

/** Push a reply queue entry onto the Yjs replyQueue array via debug bridge. */
async function pushReplyEntry(page: Page, entry: {
  id: string;
  ticketId: string;
  agentEmail: string;
  text: string;
  html?: string;
  subject: string;
  statusAfterSend?: string;
}) {
  const data: any = {
    id:         entry.id,
    ticketId:   entry.ticketId,
    agentEmail: entry.agentEmail,
    html:       entry.html ?? '',
    text:       entry.text,
    subject:    entry.subject,
    timestamp:  Date.now(),
    status:     'pending',
  };
  if (entry.statusAfterSend) {
    data.statusAfterSend = entry.statusAfterSend;
  }
  await page.evaluate(
    ([arrayName, value]) => (window as any).__suppDebug.pushArrayEntry(arrayName, value),
    ['replyQueue', data] as [string, any],
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test.describe('Reply Flow', () => {

  test('agent reply is written to replyQueue', async ({ sharedPage, agentPage, mock }) => {
    _sharedPage = sharedPage;
    _agentPage  = agentPage;

    // Ensure the shared inbox wins leader election so the agent's dispatcher
    // does NOT run — otherwise it would immediately process (and remove) the entry.
    await waitForLeader(sharedPage);

    // Push a reply to agentPage's isolated Yjs doc (no P2P sync in tests).
    // The dispatcher on sharedPage won't see this entry.
    await pushReplyEntry(agentPage, {
      id:         'reply-test-001',
      ticketId:   'tkt-test123',
      agentEmail: 'agent1@test.com',
      text:       'Thank you for reaching out. We will look into this.',
      subject:    'Re: Test request',
    });

    const queue = await getReplyQueue(agentPage);
    expect(queue).toHaveLength(1);
    expect(queue[0].id).toBe('reply-test-001');
    expect(queue[0].text).toContain('Thank you');
  });

  test('leader drains replyQueue and sends via Gmail API', async ({
    sharedPage, agentPage, mock,
  }) => {
    _sharedPage = sharedPage;
    _agentPage  = agentPage;

    await waitForLeader(sharedPage);

    // Seed a ticket in the shared inbox Yjs doc (leader's doc)
    const ticketId = 'tkt-drain-test';
    await seedTicket(sharedPage, {
      ticketId,
      originalThreadId: 'thread-drain-001',
      customerEmail:    'customer@example.com',
      customerName:     'Test Customer',
      subject:          'Order shipped',
      shadowEmail:      `${ticketId}@tkt.suppapp.com`,
    });

    // Push a reply entry to the leader's replyQueue (simulates P2P sync from agent)
    await pushReplyEntry(sharedPage, {
      id:         'reply-drain-001',
      ticketId,
      agentEmail: 'agent1@test.com',
      text:       'Your order has been shipped.',
      subject:    'Re: Order shipped',
    });

    // Wait for leader to drain the queue
    await sharedPage.waitForFunction(
      async () => {
        const q: any[] = await (window as any).__suppDebug.getReplyQueue();
        return q.length === 0;
      },
      { timeout: 15_000 },
    );

    // Verify the Gmail send API was called
    const sendCalls = await mock.getSendCalls();
    expect(sendCalls.length).toBeGreaterThan(0);

    // The send body is JSON with a base64url-encoded 'raw' field
    const lastCall = sendCalls[sendCalls.length - 1];
    const parsed = JSON.parse(lastCall.body);
    expect(parsed).toHaveProperty('raw');

    // Decode and verify it contains the reply text
    const b64 = parsed.raw.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(b64);
    expect(decoded).toContain('shipped');
  });

  test('Send+Solved sets ticket status after reply', async ({
    sharedPage, agentPage, mock,
  }) => {
    _sharedPage = sharedPage;
    _agentPage  = agentPage;

    await waitForLeader(sharedPage);

    const ticketId = 'tkt-solved-test';
    await seedTicket(sharedPage, {
      ticketId,
      originalThreadId: 'thread-solved-001',
      customerEmail:    'customer@example.com',
      customerName:     'Test Customer',
      subject:          'Issue resolved',
      shadowEmail:      `${ticketId}@tkt.suppapp.com`,
      status:           'open',
    });

    await pushReplyEntry(sharedPage, {
      id:              'reply-solved-001',
      ticketId,
      agentEmail:      'agent1@test.com',
      text:            'Issue resolved. Closing this ticket.',
      subject:         'Re: Issue resolved',
      statusAfterSend: 'solved',
    });

    // Wait for the ticket status to become 'solved' (more robust than waiting for
    // queue drain then reading ticket — avoids timing gap between queue removal and assertion).
    await sharedPage.waitForFunction(
      async (tid) => {
        const ticket = await (window as any).__suppDebug.getMapEntry('tickets', tid);
        return ticket?.status === 'solved';
      },
      ticketId,
      { timeout: 15_000 },
    );

    const ticket = await sharedPage.evaluate(
      (tid) => (window as any).__suppDebug.getMapEntry('tickets', tid),
      ticketId,
    );
    expect((ticket as any)?.status).toBe('solved');
  });

});
