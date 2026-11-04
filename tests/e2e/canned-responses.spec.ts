// Canned Responses E2E Tests
// Tests personal/team CR storage, Yjs sync, and variable substitution.
// Compose dropdown and management modal require InboxSDK — verified manually in production.

import { test, expect } from '../helpers/contexts.js';
import { waitForYjsSync } from '../helpers/yjs-inspector.js';
import { installFailureDump } from '../helpers/on-failure.js';
import { Page } from '@playwright/test';

let _sharedPage: Page | null = null;
let _agentPage:  Page | null = null;
installFailureDump(() => _sharedPage, () => _agentPage);

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeCR(overrides: Record<string, any> = {}) {
  return {
    id:          'cr-test-' + Date.now(),
    title:       'Test Response',
    body:        'Hello {{customer_name}}, your ticket {{ticket_id}} is being handled by {{agent_name}}.',
    tags:        [] as string[],
    scope:       'personal' as 'personal' | 'team',
    createdBy:   'test@example.com',
    createdAt:   Date.now(),
    usageCount:  0,
    lastUsedAt:  0,
    lastModified: Date.now(),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

test.describe('Canned Responses', () => {

  test('personal canned response is saved to local storage only', async ({ sharedPage }) => {
    _sharedPage = sharedPage;
    await waitForYjsSync(sharedPage, 5000);

    const cr = makeCR({
      id:    'cr-personal-' + Date.now(),
      title: 'My Personal Response',
      body:  'This is personal.',
      scope: 'personal',
    });

    // Save via debug bridge (writes to chrome.storage.local)
    await sharedPage.evaluate(
      (c) => (window as any).__suppDebug.savePersonalCannedResponse(c),
      cr,
    );

    // Assert it appears in personal CRs
    const personal = await sharedPage.evaluate(
      () => (window as any).__suppDebug.getPersonalCannedResponses()
    );
    expect(personal.some((r: any) => r.id === cr.id)).toBe(true);

    // Assert it is NOT in Yjs cannedResponses (team CRs)
    const team = await sharedPage.evaluate(
      () => (window as any).__suppDebug.getCannedResponses()
    );
    expect(team.some(([id]: [string, any]) => id === cr.id)).toBe(false);
  });

  test('team canned response is stored in Yjs and readable via debug bridge', async ({ agentPage }) => {
    // Note: Cross-page Yjs sync is already covered by yjs-sync.spec.ts.
    // Here we verify that the cannedResponses Y.Map is writable and readable via the
    // debug bridge, which is the foundation the compose dropdown depends on.
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    const cr = makeCR({
      id:    'cr-team-' + Date.now(),
      title: 'Team Shared Response',
      body:  'This is a team response.',
      scope: 'team',
    });

    // Write team CR directly into Yjs via setMapEntry
    await agentPage.evaluate(
      ([id, c]) => (window as any).__suppDebug.setMapEntry('cannedResponses', id, c),
      [cr.id, cr] as [string, any],
    );

    // Read it back via getCannedResponses — confirms the map round-trip works
    const entries = await agentPage.evaluate(
      () => (window as any).__suppDebug.getCannedResponses()
    );
    expect(entries.some(([id]: [string, any]) => id === cr.id)).toBe(true);

    // Also confirm it is NOT in personal storage on the same page
    const personal = await agentPage.evaluate(
      () => (window as any).__suppDebug.getPersonalCannedResponses()
    );
    expect(personal.some((r: any) => r.id === cr.id)).toBe(false);
  });

  test('variable substitution replaces template variables in CR body', async ({ agentPage }) => {
    _agentPage = agentPage;
    await waitForYjsSync(agentPage, 5000);

    // Test agent_name substitution (no ticket needed)
    const bodyAgent = 'Reply from {{agent_name}}.';
    const result1 = await agentPage.evaluate(
      ([b, an]) => (window as any).__suppDebug.substituteVariables(b, null, an),
      [bodyAgent, 'Alice'] as [string, string],
    );
    expect(result1).not.toContain('{{');
    expect(result1).toContain('Alice');

    // Test that unknown variables are left as-is
    const bodyUnknown = 'Ticket: {{unknown_var}} is open.';
    const result2 = await agentPage.evaluate(
      ([b, an]) => (window as any).__suppDebug.substituteVariables(b, null, an),
      [bodyUnknown, ''] as [string, string],
    );
    expect(result2).toContain('{{unknown_var}}');

    // Test ticket-based variables by seeding a ticket via setMapEntry
    const ticketId = 'tkt-cr-subst-' + Date.now();
    const ticket = {
      ticketId,
      originalThreadId: `orig-${ticketId}`,
      status: 'open', assignee: null, tags: [], notes: '', customerId: '',
      customerEmail: 'john@example.com', customerName: 'John Doe',
      subject: 'Help', shadowEmail: `tkt-${ticketId}@tkt.suppapp.com`,
      shadowThreads: {}, excluded: false,
      lastModified: Date.now(), createdAt: Date.now(),
      messageCount: 1, lastReply: null, lastReplyBy: null,
    };
    await agentPage.evaluate(
      ([id, t]) => (window as any).__suppDebug.setMapEntry('tickets', id, t),
      [ticketId, ticket] as [string, any],
    );

    const bodyTicket = 'Hi {{customer_name}}, ticket {{ticket_id}}.';
    const result3 = await agentPage.evaluate(
      ([b, tid, an]) => (window as any).__suppDebug.substituteVariables(b, tid, an),
      [bodyTicket, ticketId, 'Bob'] as [string, string, string],
    );
    expect(result3).not.toContain('{{');
    expect(result3).toContain('John Doe');
    expect(result3).toContain(ticketId);
  });

});
