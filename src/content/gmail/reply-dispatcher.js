// Supp v2 - Reply Dispatcher
// Leader-only: observes replyQueue, sends replies to customers, inserts agent reply shadows.
// Runs inside becomeLeader callback and stops on stepDown.

import { buildShadowRfc2822 } from './shadow.js';
import { formatRfc2822Date, sleep } from '../../common/utils.js';
import { SUPP_LABEL_NAME } from '../../common/constants.js';
import { nanoid } from 'nanoid';
import { awareness } from '../yjs/doc.js';

// ─── RFC 2822 helper for outbound customer reply ───────────────────────────────

/**
 * Build a plain-text / HTML RFC 2822 reply from the shared inbox to the customer.
 */
function buildCustomerReplyRfc2822({ from, to, subject, text, html, inReplyTo, references }) {
  const messageId = `<reply.${nanoid(8)}.${Date.now()}@supp>`;

  const lines = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${formatRfc2822Date(new Date())}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }

  if (html) {
    const boundary = `reply_${Date.now().toString(36)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(text || '');
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(html);
    lines.push('');
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(text || '');
  }

  return lines.join('\r\n');
}

// ─── ReplyDispatcher ──────────────────────────────────────────────────────────

export class ReplyDispatcher {
  /**
   * @param {import('yjs').Doc} ydoc
   * @param {import('./api.js').GmailAPI} sharedInboxGmailApi - shared inbox API for sending
   * @param {import('./shadow.js').ShadowEmailService} shadowService - for agent-api access
   * @param {object} teamConfig
   */
  constructor(ydoc, sharedInboxGmailApi, shadowService, teamConfig) {
    this._ydoc = ydoc;
    this._tickets = ydoc.getMap('tickets');
    this._replyQueue = ydoc.getArray('replyQueue');
    this._sharedApi = sharedInboxGmailApi;
    this._shadowService = shadowService;
    this._teamConfig = teamConfig;
    this._sharedInboxEmail = teamConfig.sharedInboxEmail || teamConfig.mainAccount?.email;

    /** @type {Set<string>} reply IDs currently being dispatched */
    this._processing = new Set();
    /** @type {Map<string, number>} consecutive failure counts per replyId */
    this._failureCounts = new Map();
    this._observer = null;
  }

  start() {
    this._observer = () => this.processQueue();
    this._replyQueue.observe(this._observer);
    // Defensive poll — catches entries that arrive via Firebase Yjs sync when the
    // Yjs observer fires before the full update is integrated (race) or when the
    // observer is missed for any reason.
    this._pollTimer = setInterval(() => this.processQueue(), 5000);
    // Process any entries left from before this leader took over
    this.processQueue();
    console.log('[Supp] Reply dispatcher started');
  }

  stop() {
    if (this._observer) {
      this._replyQueue.unobserve(this._observer);
      this._observer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    console.log('[Supp] Reply dispatcher stopped');
  }

  processQueue() {
    const entries = this._replyQueue.toArray();
    if (entries.length > 0) {
      console.log(`[Supp] ReplyDispatcher: processQueue — ${entries.length} entries, ${entries.filter(e => e.status === 'pending').length} pending`);
    }
    for (const entry of entries) {
      if (entry.status === 'pending' && !this._processing.has(entry.id)) {
        this._processing.add(entry.id);
        this._dispatchReply(entry).catch(err => {
          console.error('[Supp] dispatchReply unhandled error:', err);
          this._processing.delete(entry.id);
        });
      }
    }
  }

  async _dispatchReply(entry) {
    console.log(`[Supp] ReplyDispatcher: dispatching ${entry.id} for ticket ${entry.ticketId}`);
    // Mark as sending
    this._updateEntryStatus(entry.id, 'sending');

    const ticket = this._tickets.get(entry.ticketId);
    if (!ticket) {
      console.warn('[Supp] ReplyDispatcher: ticket not found:', entry.ticketId);
      this._updateEntryStatus(entry.id, 'failed');
      this._processing.delete(entry.id);
      return;
    }

    // ── Step A: Send actual email to customer ─────────────────────────────────
    try {
      const replySubject = ticket.subject.startsWith('Re:')
        ? ticket.subject
        : `Re: ${ticket.subject}`;

      const raw = buildCustomerReplyRfc2822({
        from: this._sharedInboxEmail,
        to: ticket.customerEmail,
        subject: replySubject,
        text: entry.text,
        html: entry.html,
        inReplyTo: ticket.originalMessageId || null,
        references: ticket.originalMessageId || null,
      });

      await this._sharedApi.sendMessage(raw, ticket.originalThreadId);
      console.log(`[Supp] Reply sent to customer for ticket ${entry.ticketId}`);
    } catch (err) {
      console.error('[Supp] ReplyDispatcher: send to customer failed:', err);

      const fails = (this._failureCounts.get(entry.id) || 0) + 1;
      this._failureCounts.set(entry.id, fails);

      if (fails >= 3) {
        this._updateEntryStatus(entry.id, 'failed');
        this._processing.delete(entry.id);
        console.error(`[Supp] ReplyDispatcher: entry ${entry.id} permanently failed after 3 attempts`);
      } else {
        // Reset to pending for retry (observer will pick it up again)
        this._updateEntryStatus(entry.id, 'pending');
        this._processing.delete(entry.id);
      }
      return;
    }

    // ── Step B: Insert reply shadow into all agent Gmail accounts ─────────────
    // Collect agent emails from current awareness states (deduplicated by email)
    const agentEmails = [...new Set(
      [...awareness.getStates().values()]
        .filter(p => p?.email && p.email !== this._sharedInboxEmail)
        .map(p => p.email)
    )];

    for (const agentEmail of agentEmails) {
      try {
        const shadowThreadId = ticket.shadowThreads?.[agentEmail];
        const agentApi = this._shadowService._getAgentApi(agentEmail);

        // Resolve Supp label for this agent's inbox
        let suppLabelId = null;
        try {
          const { labels } = await agentApi.getLabels();
          const existing = labels.find(l => l.name === SUPP_LABEL_NAME);
          if (existing) {
            suppLabelId = existing.id;
          } else {
            const created = await agentApi.createLabel(SUPP_LABEL_NAME);
            suppLabelId = created.id;
          }
        } catch {
          // Label fetch failed — continue without Supp label
        }

        const labelIds = ['INBOX', 'UNREAD'];
        if (suppLabelId) labelIds.push(suppLabelId);

        const replySubject = ticket.subject.startsWith('Re:')
          ? ticket.subject
          : `Re: ${ticket.subject}`;

        const raw = buildShadowRfc2822({
          ticketId: ticket.ticketId,
          shadowEmail: ticket.shadowEmail,
          customerName: ticket.customerName || ticket.customerEmail,
          customerEmail: ticket.customerEmail,
          agentEmail,
          subject: replySubject,
          bodyText: entry.text,
          bodyHtml: entry.html,
          messageType: 'agent-reply',
          date: new Date(),
        });

        // 1 second between inserts — PoC 1 threading requirement
        await sleep(1000);
        await agentApi.insertMessage(raw, labelIds, shadowThreadId);
        console.log(`[Supp] Agent reply shadow inserted for ${agentEmail}`);
      } catch (err) {
        // Non-critical — customer already received the reply
        console.warn(`[Supp] ReplyDispatcher: shadow insert failed for ${agentEmail}:`, err.message);
      }
    }

    // ── Step C: Update ticket metadata ────────────────────────────────────────
    const updatedTicket = {
      ...ticket,
      lastReply: Date.now(),
      lastReplyBy: entry.agentEmail,
      lastModified: Date.now(),
      messageCount: (ticket.messageCount || 0) + 1,
    };
    if (entry.statusAfterSend) {
      updatedTicket.status = entry.statusAfterSend;
    }
    this._tickets.set(entry.ticketId, updatedTicket);

    // Remove entry from queue
    this._removeEntry(entry.id);
    this._processing.delete(entry.id);
    this._failureCounts.delete(entry.id);
  }

  // ─── Queue mutation helpers ─────────────────────────────────────────────────

  _updateEntryStatus(replyId, newStatus) {
    // toArray() and index search must both be inside the transaction to avoid
    // TOCTOU: a remote Yjs update arriving between toArray() and delete() would
    // make the stored index stale and corrupt a different queue entry.
    this._ydoc.transact(() => {
      const arr = this._replyQueue.toArray();
      const idx = arr.findIndex(e => e.id === replyId);
      if (idx === -1) return;
      const updated = { ...arr[idx], status: newStatus };
      this._replyQueue.delete(idx, 1);
      this._replyQueue.insert(idx, [updated]);
    });
  }

  _removeEntry(replyId) {
    this._ydoc.transact(() => {
      const arr = this._replyQueue.toArray();
      const idx = arr.findIndex(e => e.id === replyId);
      if (idx !== -1) {
        this._replyQueue.delete(idx, 1);
      }
    });
  }
}
