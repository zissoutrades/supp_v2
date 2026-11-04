// Supp v2 - Reply Interceptor
// Hooks InboxSDK compose presending to intercept replies to shadow emails.
// Writes intercepted replies to the Yjs replyQueue for leader dispatch.
// Active for ALL agents (not just the leader).

import { nanoid } from 'nanoid';
import { SHADOW_DOMAIN } from '../../common/constants.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isShadowEmail(email) {
  return typeof email === 'string' && email.includes('@' + SHADOW_DOMAIN);
}

function extractTicketId(shadowEmail) {
  // Shadow address format: "tkt-{ticketId}@{domain}"
  // ticketId itself starts with "tkt-", so local part = "tkt-tkt-xyz"
  // Strip the leading "tkt-" envelope prefix to recover the ticketId.
  const localPart = shadowEmail.split('@')[0]; // e.g. "tkt-tkt-x_SgbM8JqHwN"
  return localPart.startsWith('tkt-') ? localPart.slice(4) : localPart;
}

/**
 * Wait for a reply queue entry to be removed (dispatched) or marked 'sent'.
 * Observes the replyQueue Y.Array and resolves when the entry is gone.
 *
 * @param {import('yjs').Array} replyQueue
 * @param {string} replyId
 * @param {number} timeout - ms, default 30s
 */
function waitForReplyConfirmation(replyQueue, replyId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    let timeoutId;

    const check = () => {
      const arr = replyQueue.toArray();
      const entry = arr.find(e => e.id === replyId);
      // Resolved when entry is gone (removed after dispatch) or status='sent'
      if (!entry || entry.status === 'sent') {
        clearTimeout(timeoutId);
        replyQueue.unobserve(observer);
        resolve();
      }
    };

    // eslint-disable-next-line prefer-const
    let observer = check;

    timeoutId = setTimeout(() => {
      replyQueue.unobserve(observer);
      reject(new Error('Reply confirmation timeout'));
    }, timeout);

    // Check immediately in case it was already dispatched
    check();
    replyQueue.observe(observer);
  });
}

// ─── initReplyInterceptor ─────────────────────────────────────────────────────

/**
 * Register InboxSDK compose handler for reply interception.
 * Call once after InboxSDK loads.
 *
 * @param {object} sdk - InboxSDK instance
 * @param {import('yjs').Doc} ydoc
 */
export function initReplyInterceptor(sdk, ydoc) {
  const tickets = ydoc.getMap('tickets');
  const replyQueue = ydoc.getArray('replyQueue');

  sdk.Compose.registerComposeViewHandler((composeView) => {
    // Guard: presending can fire multiple times if the inline form stays open.
    // Once intercepted, cancel all subsequent presending events without re-queuing.
    let intercepted = false;

    composeView.on('presending', async (event) => {
      let toEmail;
      try {
        const recipients = composeView.getToRecipients();
        if (!recipients || !recipients.length) return;
        // InboxSDK may return strings or objects with emailAddress
        const first = recipients[0];
        toEmail = typeof first === 'string' ? first : first.emailAddress;
      } catch (err) {
        console.warn('[Supp] Reply interceptor: could not read recipients', err);
        return;
      }

      if (!isShadowEmail(toEmail)) {
        // Not a shadow email — let Gmail send normally
        return;
      }

      // This is a Supp ticket reply — intercept
      event.cancel();

      // If already intercepted (user clicked send again while form was still visible),
      // cancel the send and do nothing else — reply is already in the queue.
      if (intercepted) {
        console.log('[Supp] Reply interceptor: duplicate presending suppressed');
        return;
      }
      intercepted = true;

      try {
        const ticketId = extractTicketId(toEmail);
        const ticket = tickets.get(ticketId);

        if (!ticket) {
          sdk.ButterBar.showError({ text: 'Ticket not found', time: 5000 });
          return;
        }

        const html = composeView.getHTMLContent();
        const text = composeView.getTextContent();
        const replyId = nanoid();

        /** @type {import('../../../common/ticket-schema.js').ReplyQueueEntry} */
        const entry = {
          id: replyId,
          ticketId,
          agentEmail: sdk.User.getEmailAddress(),
          html,
          text,
          subject: ticket.subject,
          timestamp: Date.now(),
          status: 'pending',
        };

        // Dedup: if a pending/sending entry for this ticket already exists, skip.
        // InboxSDK may create a second ComposeView instance for the same reply form
        // (inline → floating conversion) when navigation fires before the form is closed.
        const alreadyQueued = replyQueue.toArray().find(
          e => e.ticketId === ticketId && (e.status === 'pending' || e.status === 'sending')
        );
        if (alreadyQueued) {
          console.log(`[Supp] Reply interceptor: duplicate suppressed for ${ticketId}`);
          return;
        }

        replyQueue.push([entry]);
        console.log(`[Supp] Reply queued: ${replyId} for ticket ${ticketId}`);

        // Discard the (now-empty) draft and navigate to inbox.
        // discard() handles inline reply forms; goto(INBOX) ensures thread list is shown.
        try { composeView.setBodyHTML(''); } catch {}
        try { composeView.discard(); } catch {}
        sdk.Router.goto(sdk.Router.NativeRouteIDs.INBOX);

        sdk.ButterBar.showMessage({ text: 'Sending reply to customer...', time: 10000 });

        try {
          await waitForReplyConfirmation(replyQueue, replyId);
          sdk.ButterBar.showMessage({ text: 'Reply sent!', time: 3000 });
        } catch {
          sdk.ButterBar.showError({
            text: 'Reply may not have sent — check ticket status',
            time: 8000,
          });
        }
      } catch (err) {
        console.error('[Supp] Reply interception error:', err);
        sdk.ButterBar.showError({ text: `Failed to send reply: ${err.message}`, time: 5000 });
      }
    });
  });

  console.log('[Supp] Reply interceptor initialized');
}
