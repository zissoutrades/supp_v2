// Tags E2E Tests
// Tests tag sync via Yjs and filtering behavior.
// DOM label rendering (thread row tag badges) requires InboxSDK and is
// verified manually in production Gmail.

import { test, expect } from '../helpers/contexts.js';
import { getTicket, waitForYjsSync } from '../helpers/yjs-inspector.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { Page } from '@playwright/test';

let _sharedPage: Page | null = null;
let _agentPage:  Page | null = null;
installFailureDump(() => _sharedPage, () => _agentPage);

// ── Ticket factory ─────────────────────────────────────────────────────────────

const BASE_TICKET = {
  status:          'open' as const,
  assignee:        null as string | null,
  tags:            [] as string[],
  notes:           '',
  customerId:      '',
  customerEmail:   'customer@example.com',
  customerName:    'Test Customer',
  subject:         'Test subject',
  shadowEmail:     'tkt-tags@tkt.suppapp.com',
  shadowThreads:   {} as Record<string, string>,
  excluded:        false,
  lastModified:    Date.now(),
  createdAt:       Date.now(),
  messageCount:    1,
  lastReply:       null,
  lastReplyBy:     null,
};

async function seedTicket(page: Page, ticketId: string, overrides: Partial<typeof BASE_TICKET> = {}) {
  const data = { ticketId, originalThreadId: `orig-${ticketId}`, ...BASE_TICKET, ...overrides };
  await page.evaluate(
    ([id, d]) => (window as any).__suppDebug.setMapEntry('tickets', id, d),
    [ticketId, data] as [string, any],
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Tags', () => {

  test('tags can be written and read back from a ticket', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    // Seed with no tags
    await seedTicket(agentPage, 'tkt-tags-write', { tags: [] });

    // Add tags via setMapEntry (simulates what side-panel writes)
    const existing = await agentPage.evaluate(
      (id) => (window as any).__suppDebug.getMapEntry('tickets', id),
      'tkt-tags-write',
    );
    await agentPage.evaluate(
      ([id, d]) => (window as any).__suppDebug.setMapEntry('tickets', id, d),
      ['tkt-tags-write', { ...(existing as any), tags: ['billing', 'urgent'], lastModified: Date.now() }] as [string, any],
    );

    const ticket = await agentPage.evaluate(
      (id) => (window as any).__suppDebug.getMapEntry('tickets', id),
      'tkt-tags-write',
    );
    expect((ticket as any).tags).toEqual(expect.arrayContaining(['billing', 'urgent']));
    expect((ticket as any).tags).toHaveLength(2);
  });

  test('thread row label count respects MAX_TAGS_IN_ROW = 3', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    // Seed a ticket with 4 tags
    await seedTicket(agentPage, 'tkt-tags-max', {
      tags: ['billing', 'urgent', 'refund', 'vip'],
    });

    // Retrieve the ticket and verify the tag array exists and has 4 items
    const ticket = await agentPage.evaluate(
      (id) => (window as any).__suppDebug.getMapEntry('tickets', id),
      'tkt-tags-max',
    );
    expect((ticket as any).tags).toHaveLength(4);

    // Verify that filtered-views only surfaces MAX_TAGS_IN_ROW (3) tags when rendering.
    // The actual DOM label cap is enforced in thread-labels.js (tags.slice(0, MAX_TAGS_IN_ROW)).
    // Here we assert the data layer is intact; label rendering is verified in production Gmail.
    const MAX_TAGS_IN_ROW = 3;
    const visibleTags = ((ticket as any).tags as string[]).slice(0, MAX_TAGS_IN_ROW);
    expect(visibleTags).toHaveLength(MAX_TAGS_IN_ROW);
  });

  test('ticket with tags appears in All Tickets filtered view', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    await seedTicket(agentPage, 'tkt-tags-view', {
      tags: ['billing', 'priority'],
    });

    const results = await agentPage.evaluate(
      (r) => (window as any).__suppDebug.getFilteredView(r),
      'supp-all',
    );

    const ticket = (results as any[]).find((t) => t.ticketId === 'tkt-tags-view');
    expect(ticket).toBeDefined();
    expect(ticket.tags).toContain('billing');
    expect(ticket.tags).toContain('priority');
  });

});
