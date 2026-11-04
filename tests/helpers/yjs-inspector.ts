// Yjs Inspector - Helpers for reading Yjs state via __suppDebug bridge
// Uses page.evaluate() to call window.__suppDebug methods

import { Page } from '@playwright/test';

/**
 * Get all tickets from the Yjs document
 */
export async function getTickets(page: Page): Promise<Array<[string, any]>> {
  return await page.evaluate(() => {
    return (window as any).__suppDebug.getTickets();
  });
}

/**
 * Get a specific ticket by thread ID
 */
export async function getTicket(page: Page, threadId: string): Promise<any | null> {
  const tickets = await getTickets(page);
  const found = tickets.find(([_, ticket]) => ticket.originalThreadId === threadId);
  return found ? found[1] : null;
}

/**
 * Get all presence entries
 */
export async function getPresence(page: Page): Promise<Array<[string, any]>> {
  return await page.evaluate(() => {
    return (window as any).__suppDebug.getPresence();
  });
}

/**
 * Get the reply queue
 */
export async function getReplyQueue(page: Page): Promise<any[]> {
  return await page.evaluate(() => {
    return (window as any).__suppDebug.getReplyQueue();
  });
}

/**
 * Check if this agent is the leader
 */
export async function isLeader(page: Page): Promise<boolean> {
  return await page.evaluate(() => {
    return (window as any).__suppDebug.isLeader();
  });
}

/**
 * Wait for Yjs persistence to sync.
 * Polls getYjsSyncState() until it returns 'synced' or the timeout expires.
 * Using polling instead of the async waitForSync message to avoid 8s proxy timeout
 * issues in environments where async postMessage response timing is unreliable.
 */
export async function waitForYjsSync(page: Page, timeoutMs: number = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => (window as any).__suppDebug.getYjsSyncState());
      if (state === 'synced') return;
    } catch {
      // bridge not yet ready — keep polling
    }
    await new Promise(r => setTimeout(r, 100));
  }
  // If still not 'synced' after timeout, IndexedDB is likely empty/new (ok for tests)
}

/**
 * Wait for a ticket field to sync across two pages
 * Polls both pages until the field matches the expected value
 */
export async function waitForTicketSync(
  pageA: Page,
  pageB: Page,
  threadId: string,
  field: string,
  expectedValue: any,
  timeoutMs: number = 5000
): Promise<void> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const ticketA = await getTicket(pageA, threadId);
    const ticketB = await getTicket(pageB, threadId);

    if (ticketA && ticketB &&
        ticketA[field] === expectedValue &&
        ticketB[field] === expectedValue) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 100));
  }

  throw new Error(`Ticket field ${field} did not sync to ${expectedValue} within ${timeoutMs}ms`);
}
