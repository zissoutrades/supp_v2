// Side Panel E2E Tests
// Tests that the side panel mounts correctly and that field interactions
// write to / read from Yjs. InboxSDK integration (thread-open trigger) is
// verified manually; here we drive the panel via the debug bridge.

import { test, expect, AGENT_EMAIL } from '../helpers/contexts.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { Page } from '@playwright/test';

let _sharedPage: Page | null = null;
let _agentPage:  Page | null = null;
installFailureDump(() => _sharedPage, () => _agentPage);

// ── Helpers ──────────────────────────────────────────────────────────────────

const TICKET_BASE = {
  status:          'open' as const,
  assignee:        null,
  tags:            [] as string[],
  notes:           '',
  customerId:      '',
  customerEmail:   'customer@example.com',
  customerName:    'Test Customer',
  subject:         'Test subject',
  originalThreadId: 'thread-sp-001',
  shadowEmail:     'tkt-sp001@tkt.suppapp.com',
  shadowThreads:   {} as Record<string, string>,
  excluded:        false,
  createdAt:       Date.now(),
  lastModified:    Date.now(),
  messageCount:    1,
  lastReply:       null,
  lastReplyBy:     null,
};

async function seedTicket(page: Page, ticketId: string, overrides: Partial<typeof TICKET_BASE> = {}) {
  const data = { ticketId, ...TICKET_BASE, ...overrides };
  await page.evaluate(
    ([id, d]) => (window as any).__suppDebug.setMapEntry('tickets', id, d),
    [ticketId, data] as [string, any],
  );
}

async function openPanel(page: Page, ticketId: string) {
  await page.evaluate(
    (id) => (window as any).__suppDebug.openSidePanel(id),
    ticketId,
  );
  // Wait for panel to appear in the DOM
  await page.locator('[data-supp-side-panel]').waitFor({ timeout: 5_000 });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test.describe('Side Panel', () => {

  test('side panel mounts and shows all metadata fields', async ({ agentPage }) => {
    _agentPage = agentPage;

    await seedTicket(agentPage, 'tkt-sp-mount', {
      status:    'pending',
      notes:     'Some internal notes',
      customerId: 'usr-123',
    });

    await openPanel(agentPage, 'tkt-sp-mount');

    // Panel container present
    await expect(agentPage.locator('[data-supp-side-panel]')).toBeVisible();

    // Status buttons all present
    await expect(agentPage.locator('[data-supp-status-option="open"]')).toBeVisible();
    await expect(agentPage.locator('[data-supp-status-option="pending"]')).toBeVisible();
    await expect(agentPage.locator('[data-supp-status-option="solved"]')).toBeVisible();

    // Assignee dropdown present
    await expect(agentPage.locator('[data-supp-assignee-selector]')).toBeVisible();

    // Notes textarea contains seeded value
    await expect(agentPage.locator('[data-supp-notes]')).toHaveValue('Some internal notes');

    // Customer ID input contains seeded value
    await expect(agentPage.locator('[data-supp-customer-id]')).toHaveValue('usr-123');
  });

  test('clicking a status option updates Yjs', async ({ agentPage }) => {
    _agentPage = agentPage;

    await seedTicket(agentPage, 'tkt-sp-status', { status: 'open' });
    await openPanel(agentPage, 'tkt-sp-status');

    await agentPage.locator('[data-supp-status-option="pending"]').click();

    // Verify Yjs reflects the change
    await agentPage.waitForFunction(
      async (id) => {
        const t = await (window as any).__suppDebug.getMapEntry('tickets', id);
        return t?.status === 'pending';
      },
      'tkt-sp-status',
      { timeout: 5_000 },
    );

    const ticket = await agentPage.evaluate(
      (id) => (window as any).__suppDebug.getMapEntry('tickets', id),
      'tkt-sp-status',
    );
    expect((ticket as any).status).toBe('pending');
  });

  test('selecting an assignee updates Yjs', async ({ agentPage }) => {
    _agentPage = agentPage;

    // Seed the agent into awareness so they appear as an assignee option
    await agentPage.evaluate(
      (email) => (window as any).__suppDebug.injectAwareness(99902, {
        agentId: 'test-agent-sp', email,
        name: 'Test Agent', role: 'agent',
        status: 'online', lastSeen: Date.now(),
        isLeader: false, priority: 99, tokenVersions: [],
      }),
      AGENT_EMAIL,
    );

    await seedTicket(agentPage, 'tkt-sp-assign', { assignee: null });
    await openPanel(agentPage, 'tkt-sp-assign');

    await expect(agentPage.locator(`[data-supp-assignee-option="${AGENT_EMAIL}"]`)).toBeAttached();
    await agentPage.locator('[data-supp-assignee-selector]').selectOption(AGENT_EMAIL);

    await agentPage.waitForFunction(
      async (id) => {
        const t = await (window as any).__suppDebug.getMapEntry('tickets', id);
        return t?.assignee != null;
      },
      'tkt-sp-assign',
      { timeout: 5_000 },
    );

    const ticket = await agentPage.evaluate(
      (id) => (window as any).__suppDebug.getMapEntry('tickets', id),
      'tkt-sp-assign',
    );
    expect((ticket as any).assignee).toBe(AGENT_EMAIL);
  });

});
