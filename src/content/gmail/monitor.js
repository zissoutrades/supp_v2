// Supp v2 - Email Monitor (leader only)
// Polls Gmail History API to detect new messages in the shared inbox.
// Only runs when the current instance is the leader.

import { INBOX_POLL_INTERVAL_MS } from '../../common/constants.js';

export class EmailMonitor {
  /**
   * @param {import('./api.js').GmailAPI} gmailApi - API instance for the shared inbox
   * @param {import('yjs').Doc} ydoc
   * @param {(threadId: string) => void} onNewTicket
   * @param {(threadId: string, ticket: object) => void} onCustomerReply
   */
  constructor(gmailApi, ydoc, onNewTicket, onCustomerReply) {
    this._gmailApi = gmailApi;
    this._tickets = ydoc.getMap('tickets');
    this._onNewTicket = onNewTicket;
    this._onCustomerReply = onCustomerReply;

    this._historyId = null;
    this._pollInterval = null;
    this._running = false;
    this._processedMessageIds = new Set();
  }

  /** Start polling. Fetches initial historyId then polls every INBOX_POLL_INTERVAL_MS. */
  async start() {
    if (this._running) return;
    this._running = true;

    try {
      const profile = await this._gmailApi.getProfile();
      this._historyId = profile.historyId;
      console.log(`[Supp] EmailMonitor started — historyId=${this._historyId}`);
    } catch (err) {
      console.error('[Supp] EmailMonitor: failed to get initial historyId', err);
      this._running = false;
      return;
    }

    // Run first check immediately, then on interval
    this.checkForNewMessages();
    this._pollInterval = setInterval(() => this.checkForNewMessages(), INBOX_POLL_INTERVAL_MS);
  }

  /** Stop polling. */
  stop() {
    this._running = false;
    if (this._pollInterval) {
      clearInterval(this._pollInterval);
      this._pollInterval = null;
    }
    console.log('[Supp] EmailMonitor stopped');
  }

  /** Poll the History API for new messages. Called by interval and by triggerPoll() in tests. */
  async checkForNewMessages() {
    if (!this._running || !this._historyId) return;

    let response;
    try {
      response = await this._gmailApi.getHistory(this._historyId, { labelId: 'INBOX' });
    } catch (err) {
      if (err.message && err.message.includes('404')) {
        // historyId too old — reset cursor
        console.warn('[Supp] EmailMonitor: historyId expired, resetting');
        try {
          const profile = await this._gmailApi.getProfile();
          this._historyId = profile.historyId;
        } catch (e2) {
          console.error('[Supp] EmailMonitor: failed to reset historyId', e2);
        }
      } else {
        console.error('[Supp] EmailMonitor: history poll failed', err);
      }
      return;
    }

    if (!response.history || response.history.length === 0) {
      if (response.historyId) this._historyId = response.historyId;
      return;
    }

    for (const entry of response.history) {
      if (!entry.messagesAdded) continue;
      for (const { message } of entry.messagesAdded) {
        const { id: messageId, threadId } = message;
        if (this._processedMessageIds.has(messageId)) continue;
        this._processedMessageIds.add(messageId);

        // Check if a ticket already exists for this thread
        const existing = this._findTicketByThreadId(threadId);
        if (existing) {
          await this._onCustomerReply(threadId, existing);
        } else {
          await this._onNewTicket(threadId);
        }
      }
    }

    if (response.historyId) {
      this._historyId = response.historyId;
    }
  }

  _findTicketByThreadId(threadId) {
    for (const ticket of this._tickets.values()) {
      if (ticket.originalThreadId === threadId) return ticket;
    }
    return null;
  }
}
