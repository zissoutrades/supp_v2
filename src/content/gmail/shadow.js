// Supp v2 - Shadow Email Service
// Creates shadow copies of customer emails in each agent's Gmail inbox.
// RFC 2822 message builder + Gmail API insertion.

import { nanoid } from 'nanoid';
import { GmailAPI } from './api.js';
import { createDefaultTicket } from '../../common/ticket-schema.js';
import { generateTicketId, formatRfc2822Date, sleep } from '../../common/utils.js';
import { SHADOW_DOMAIN, SUPP_LABEL_NAME, LEADER_TIMEOUT_MS } from '../../common/constants.js';
import { awareness } from '../yjs/doc.js';

// ─── RFC 2822 message builder ─────────────────────────────────────────────────

/**
 * Build a raw RFC 2822 message string for a shadow email.
 *
 * @param {{
 *   ticketId: string,
 *   shadowEmail: string,
 *   customerName: string,
 *   customerEmail: string,
 *   agentEmail: string,
 *   subject: string,
 *   bodyText: string,
 *   bodyHtml?: string,
 *   messageType: 'initial'|'customer-reply'|'agent-reply',
 *   inReplyTo?: string,
 *   references?: string,
 *   date?: Date,
 * }} options
 * @returns {string}
 */
export function buildShadowRfc2822(options) {
  const {
    ticketId,
    shadowEmail,
    customerName,
    customerEmail,
    agentEmail,
    subject,
    bodyText,
    bodyHtml,
    messageType,
    inReplyTo,
    references,
    date = new Date(),
  } = options;

  const messageId = `<${ticketId}.${Date.now()}.${nanoid(8)}@${SHADOW_DOMAIN}>`;
  const displayName = customerName || customerEmail;

  // RFC 2047 encode subject if it contains non-ASCII characters
  const encodedSubject = /[^\x00-\x7F]/.test(subject)
    ? `=?UTF-8?B?${btoa(unescape(encodeURIComponent(subject)))}?=`
    : subject;

  const lines = [
    `From: "${displayName}" <${shadowEmail}>`,
    `Reply-To: ${shadowEmail}`,
    `To: ${agentEmail}`,
    `Subject: ${encodedSubject}`,
    `Date: ${formatRfc2822Date(date)}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `X-Supp-Ticket-ID: ${ticketId}`,
    `X-Supp-Customer-Email: ${customerEmail}`,
    `X-Supp-Message-Type: ${messageType}`,
  ];

  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`);
    lines.push(`References: ${references || inReplyTo}`);
  }

  if (bodyHtml) {
    const boundary = `alt_${Date.now().toString(36)}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(bodyText || '');
    lines.push('');
    lines.push(`--${boundary}`);
    lines.push('Content-Type: text/html; charset=UTF-8');
    lines.push('');
    lines.push(bodyHtml);
    lines.push('');
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8');
    lines.push('');
    lines.push(bodyText || '');
  }

  return lines.join('\r\n');
}

// ─── Message parsing helpers ──────────────────────────────────────────────────

function parseFromHeader(fromValue) {
  // Handles: "Name <email>", "email", '"Name" <email>'
  const match = fromValue.match(/^"?([^"<]+)"?\s*<([^>]+)>$/);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { name: fromValue.trim(), email: fromValue.trim() };
}

function getHeader(headers, name) {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}

function decodeBase64Body(data) {
  try {
    // base64url → base64
    const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return '';
  }
}

/**
 * Extract body text from a Gmail message payload.
 * Handles simple text/plain, text/html, and multipart bodies.
 */
function extractBody(payload) {
  if (!payload) return { text: '', html: '' };

  // Simple body
  if (payload.body?.data) {
    const text = decodeBase64Body(payload.body.data);
    if (payload.mimeType === 'text/html') return { text: '', html: text };
    return { text, html: '' };
  }

  // Multipart — search parts for text/plain and text/html
  if (payload.parts) {
    let text = '';
    let html = '';
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        text = decodeBase64Body(part.body.data);
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        html = decodeBase64Body(part.body.data);
      } else if (part.mimeType?.startsWith('multipart/') && part.parts) {
        // Recurse one level for nested multipart
        const nested = extractBody(part);
        if (!text && nested.text) text = nested.text;
        if (!html && nested.html) html = nested.html;
      }
    }
    return { text, html };
  }

  return { text: '', html: '' };
}

// ─── ShadowEmailService ───────────────────────────────────────────────────────

export class ShadowEmailService {
  /**
   * @param {import('yjs').Doc} ydoc
   * @param {object} teamConfig
   * @param {import('../tokens/token-manager.js').TokenManager} tokenManager
   */
  constructor(ydoc, teamConfig, tokenManager) {
    this._ydoc = ydoc;
    this._tickets = ydoc.getMap('tickets');
    this._teamConfig = teamConfig;
    this._tokenManager = tokenManager;
    this._suppLabelCache = new Map(); // email → labelId
    this._sharedInboxEmail = teamConfig.sharedInboxEmail || teamConfig.mainAccount?.email;

    // GmailAPI for the shared inbox (monitoring + labeling originals)
    this._sharedApi = new GmailAPI((force = false) => {
      if (force) tokenManager.clearAccessTokenCache(this._sharedInboxEmail);
      return tokenManager.getAccessToken(this._sharedInboxEmail);
    });
  }

  _getAgentApi(agentEmail) {
    return new GmailAPI((force = false) => {
      if (force) this._tokenManager.clearAccessTokenCache(agentEmail);
      return this._tokenManager.getAccessToken(agentEmail);
    });
  }

  /** Return all currently-online agent emails (excluding the shared inbox). */
  _getOnlineAgentEmails() {
    const now = Date.now();
    const emails = [];
    for (const entry of awareness.getStates().values()) {
      if (!entry?.email) continue;
      if (entry.email === this._sharedInboxEmail) continue;
      if (now - entry.lastSeen < LEADER_TIMEOUT_MS) {
        emails.push(entry.email);
      }
    }
    return emails;
  }

  /**
   * Get or create the "Supp" label in a Gmail account.
   * Cached per agent email to avoid repeated API calls.
   */
  async _ensureSuppLabel(api, email) {
    if (this._suppLabelCache.has(email)) {
      return this._suppLabelCache.get(email);
    }

    try {
      const { labels } = await api.getLabels();
      const existing = labels.find(l => l.name === SUPP_LABEL_NAME);
      if (existing) {
        this._suppLabelCache.set(email, existing.id);
        return existing.id;
      }
    } catch (err) {
      console.warn('[Supp] ShadowEmailService: failed to list labels', err.message);
    }

    try {
      const created = await api.createLabel(SUPP_LABEL_NAME);
      this._suppLabelCache.set(email, created.id);
      return created.id;
    } catch (err) {
      console.warn('[Supp] ShadowEmailService: failed to create Supp label', err.message);
      return null;
    }
  }

  /**
   * Main entry: called when a new customer email arrives in the shared inbox.
   * Creates a ticket in Yjs, labels the original, inserts shadows for all online agents.
   */
  async createTicketFromThread(threadId) {
    let thread;
    try {
      thread = await this._sharedApi.getThread(threadId);
    } catch (err) {
      console.error('[Supp] ShadowEmailService: failed to fetch thread', threadId, err);
      return null;
    }

    if (!thread.messages || thread.messages.length === 0) {
      console.warn('[Supp] ShadowEmailService: thread has no messages', threadId);
      return null;
    }

    const firstMessage = thread.messages[0];
    const headers = firstMessage.payload?.headers || [];
    const fromHeader = getHeader(headers, 'From');
    const { name: customerName, email: customerEmail } = parseFromHeader(fromHeader);
    const subject = getHeader(headers, 'Subject') || '(no subject)';
    const originalMessageId = getHeader(headers, 'Message-ID');
    const { text: bodyText, html: bodyHtml } = extractBody(firstMessage.payload);

    const ticketId = generateTicketId();
    const shadowEmail = `tkt-${ticketId}@${SHADOW_DOMAIN}`;
    const now = Date.now();

    // Create ticket in Yjs
    const ticket = createDefaultTicket({
      ticketId,
      originalThreadId: threadId,
      customerEmail,
      customerName,
      subject,
      shadowEmail,
      originalMessageId,
      createdAt: now,
      lastModified: now,
      messageCount: thread.messages.length,
      shadowThreads: {},
    });
    this._tickets.set(ticketId, ticket);

    console.log(`[Supp] Ticket created: ${ticketId} for thread ${threadId}`);

    // Label the original in shared inbox: add Supp label, remove from INBOX
    try {
      const suppLabelId = await this._ensureSuppLabel(this._sharedApi, this._sharedInboxEmail);
      const addLabels = suppLabelId ? [suppLabelId] : [];
      await this._sharedApi.modifyThread(threadId, addLabels, ['INBOX']);
    } catch (err) {
      console.warn('[Supp] ShadowEmailService: failed to label original thread', err.message);
    }

    // Insert shadows for all online agents
    const agentEmails = this._getOnlineAgentEmails();
    for (const agentEmail of agentEmails) {
      try {
        await this._insertShadowForAgent(ticketId, agentEmail, firstMessage, {
          customerName, customerEmail, subject, bodyText, bodyHtml,
          shadowEmail, originalMessageId,
        });
      } catch (err) {
        console.error(`[Supp] ShadowEmailService: failed to insert shadow for ${agentEmail}`, err);
      }
    }

    return ticket;
  }

  /**
   * Insert a shadow email for a single agent.
   */
  async _insertShadowForAgent(ticketId, agentEmail, _originalMessage, {
    customerName, customerEmail, subject, bodyText, bodyHtml,
    shadowEmail, originalMessageId,
  }) {
    const agentApi = this._getAgentApi(agentEmail);
    const suppLabelId = await this._ensureSuppLabel(agentApi, agentEmail);
    const labelIds = ['INBOX', 'UNREAD'];
    if (suppLabelId) labelIds.push(suppLabelId);

    const raw = buildShadowRfc2822({
      ticketId,
      shadowEmail,
      customerName,
      customerEmail,
      agentEmail,
      subject,
      bodyText,
      bodyHtml,
      messageType: 'initial',
      date: new Date(),
    });

    const result = await agentApi.insertMessage(raw, labelIds);
    console.log(`[Supp] Shadow inserted for ${agentEmail}: threadId=${result.threadId}`);

    // Update shadowThreads in Yjs
    const existing = this._tickets.get(ticketId);
    if (existing) {
      this._tickets.set(ticketId, {
        ...existing,
        shadowThreads: { ...existing.shadowThreads, [agentEmail]: result.threadId },
        lastModified: Date.now(),
      });
    }

    return result;
  }

  /**
   * Insert a follow-up shadow (customer reply) for all online agents.
   */
  async insertFollowUpShadow(threadId, ticket) {
    let thread;
    try {
      thread = await this._sharedApi.getThread(threadId);
    } catch (err) {
      console.error('[Supp] ShadowEmailService: failed to fetch thread for reply', err);
      return;
    }

    if (!thread.messages || thread.messages.length === 0) return;

    // Get the latest message
    const latestMessage = thread.messages[thread.messages.length - 1];
    const headers = latestMessage.payload?.headers || [];
    const subject = getHeader(headers, 'Subject') || ticket.subject;
    const originalMessageId = getHeader(headers, 'Message-ID');
    const { text: bodyText, html: bodyHtml } = extractBody(latestMessage.payload);

    const agentEmails = this._getOnlineAgentEmails();
    for (const agentEmail of agentEmails) {
      try {
        const shadowThreadId = ticket.shadowThreads?.[agentEmail];
        const agentApi = this._getAgentApi(agentEmail);
        const suppLabelId = await this._ensureSuppLabel(agentApi, agentEmail);
        const labelIds = ['INBOX', 'UNREAD'];
        if (suppLabelId) labelIds.push(suppLabelId);

        const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
        const raw = buildShadowRfc2822({
          ticketId: ticket.ticketId,
          shadowEmail: ticket.shadowEmail,
          customerName: ticket.customerName,
          customerEmail: ticket.customerEmail,
          agentEmail,
          subject: replySubject,
          bodyText,
          bodyHtml,
          messageType: 'customer-reply',
          date: new Date(),
        });

        // Wait 1s between root and reply to avoid Gmail race condition
        await sleep(1000);
        const result = await agentApi.insertMessage(raw, labelIds, shadowThreadId);
        console.log(`[Supp] Follow-up shadow inserted for ${agentEmail}`);

        // Update shadowThreads if not yet set (should already be set)
        if (!shadowThreadId) {
          const existing = this._tickets.get(ticket.ticketId);
          if (existing) {
            this._tickets.set(ticket.ticketId, {
              ...existing,
              shadowThreads: { ...existing.shadowThreads, [agentEmail]: result.threadId },
              lastModified: Date.now(),
            });
          }
        }
      } catch (err) {
        console.error(`[Supp] ShadowEmailService: follow-up shadow failed for ${agentEmail}`, err);
      }
    }
  }

  /**
   * Catch up a newly joined (or reconnected) agent with all existing tickets.
   * Inserts shadows for any ticket where this agent is missing a shadow thread.
   */
  async catchUpAgent(agentEmail) {
    const tickets = Array.from(this._tickets.entries());
    const missing = tickets.filter(([, t]) => !t.shadowThreads?.[agentEmail] && !t.excluded);

    if (missing.length === 0) {
      console.log(`[Supp] Catch-up: ${agentEmail} is already up to date`);
      return;
    }

    console.log(`[Supp] Catch-up: inserting ${missing.length} shadows for ${agentEmail}`);

    // Process in batches of 10 to respect rate limits
    const BATCH_SIZE = 10;
    let completed = 0;

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      for (const [ticketId, ticket] of batch) {
        try {
          let thread;
          try {
            thread = await this._sharedApi.getThread(ticket.originalThreadId);
          } catch (err) {
            console.warn(`[Supp] Catch-up: failed to fetch thread ${ticket.originalThreadId}`, err.message);
            // 404 means the thread was deleted — mark it excluded so it's
            // skipped on future catch-ups and doesn't pollute the count.
            if (err.message?.includes('404')) {
              this._tickets.set(ticketId, { ...ticket, excluded: true });
            }
            continue;
          }

          if (!thread.messages?.length) continue;

          const firstMessage = thread.messages[0];
          const headers = firstMessage.payload?.headers || [];
          const { text: bodyText, html: bodyHtml } = extractBody(firstMessage.payload);

          await this._insertShadowForAgent(ticketId, agentEmail, firstMessage, {
            customerName: ticket.customerName,
            customerEmail: ticket.customerEmail,
            subject: ticket.subject,
            bodyText,
            bodyHtml,
            shadowEmail: ticket.shadowEmail,
            originalMessageId: getHeader(headers, 'Message-ID'),
          });

          completed++;
          console.log(`[Supp] Catch-up: ${completed}/${missing.length} tickets for ${agentEmail}`);
        } catch (err) {
          console.error(`[Supp] Catch-up: failed for ticket ${ticketId}`, err);
        }
      }

      // Brief pause between batches
      if (i + BATCH_SIZE < missing.length) await sleep(500);
    }

    console.log(`[Supp] Catch-up complete: ${completed}/${missing.length} for ${agentEmail}`);
  }
}
