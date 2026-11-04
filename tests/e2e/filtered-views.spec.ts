// Filtered Views E2E Tests
// Tests the query / filtering logic that drives the 6 Supp custom list routes.
// InboxSDK (which renders the actual thread list UI) is skipped in the test
// build — filtering logic is verified directly via the debug bridge's
// getFilteredView() method. DOM label rendering is validated manually in
// production Gmail.

import { test, expect, AGENT_EMAIL } from '../helpers/contexts.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { waitForYjsSync } from '../helpers/yjs-inspector.js';
import { Page } from '@playwright/test';

let _agentPage: Page | null = null;
installFailureDump(() => null, () => _agentPage);

// ── Ticket factory ────────────────────────────────────────────────────────────

const BASE_TICKET = {
  status:          'open' as const,
  assignee:        null as string | null,
  tags:            [] as string[],
  notes:           '',
  customerId:      '',
  customerEmail:   'customer@example.com',
  customerName:    'Test Customer',
  subject:         'Test subject',
  shadowEmail:     'tkt-test@tkt.suppapp.com',
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

async function getFilteredView(page: Page, routeId: string): Promise<any[]> {
  return await page.evaluate(
    (r) => (window as any).__suppDebug.getFilteredView(r),
    routeId,
  );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Filtered Views', () => {

  test('All Tickets view returns all non-excluded tickets', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    await seedTicket(agentPage, 'fv-all-1', { status: 'open' });
    await seedTicket(agentPage, 'fv-all-2', { status: 'pending' });
    await seedTicket(agentPage, 'fv-all-3', { status: 'solved' });
    await seedTicket(agentPage, 'fv-all-excl', { excluded: true });

    const results = await getFilteredView(agentPage, 'supp-all');
    const ids = results.map((t: any) => t.ticketId);

    expect(ids).toContain('fv-all-1');
    expect(ids).toContain('fv-all-2');
    expect(ids).toContain('fv-all-3');
    expect(ids).not.toContain('fv-all-excl');
  });

  test('My Tickets view filters by current agent email', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    await seedTicket(agentPage, 'fv-mine-yes', { assignee: AGENT_EMAIL });
    await seedTicket(agentPage, 'fv-mine-no',  { assignee: 'other@example.com' });

    const results = await getFilteredView(agentPage, 'supp-mine');
    const ids = results.map((t: any) => t.ticketId);

    expect(ids).toContain('fv-mine-yes');
    expect(ids).not.toContain('fv-mine-no');
  });

  test('Open view returns only open tickets', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    await seedTicket(agentPage, 'fv-open-yes',  { status: 'open' });
    await seedTicket(agentPage, 'fv-open-pend', { status: 'pending' });
    await seedTicket(agentPage, 'fv-open-solv', { status: 'solved' });

    const results = await getFilteredView(agentPage, 'supp-open');
    const ids = results.map((t: any) => t.ticketId);

    expect(ids).toContain('fv-open-yes');
    expect(ids).not.toContain('fv-open-pend');
    expect(ids).not.toContain('fv-open-solv');
  });

  test('Unassigned view returns tickets with no assignee', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    await seedTicket(agentPage, 'fv-unassigned-yes', { assignee: null });
    await seedTicket(agentPage, 'fv-unassigned-no',  { assignee: AGENT_EMAIL });

    const results = await getFilteredView(agentPage, 'supp-unassigned');
    const ids = results.map((t: any) => t.ticketId);

    expect(ids).toContain('fv-unassigned-yes');
    expect(ids).not.toContain('fv-unassigned-no');
  });

  test('results are sorted by lastModified descending', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    const now = Date.now();
    await seedTicket(agentPage, 'fv-sort-old', { lastModified: now - 2000 });
    await seedTicket(agentPage, 'fv-sort-new', { lastModified: now });
    await seedTicket(agentPage, 'fv-sort-mid', { lastModified: now - 1000 });

    const results = await getFilteredView(agentPage, 'supp-all');
    const idx = (id: string) => results.findIndex((t: any) => t.ticketId === id);

    // Newest should appear before older ones
    expect(idx('fv-sort-new')).toBeLessThan(idx('fv-sort-mid'));
    expect(idx('fv-sort-mid')).toBeLessThan(idx('fv-sort-old'));
  });

});
