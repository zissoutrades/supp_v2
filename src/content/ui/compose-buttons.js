// Supp v2 — Compose Toolbar Buttons
// Adds Send+Solved, Send+Open, and Not a ticket buttons to Supp shadow-email compose views.
// These buttons bypass the normal presending flow: they queue the reply directly in
// replyQueue (same as reply-interceptor) but also update the ticket status atomically.

import { nanoid } from 'nanoid';
import { SHADOW_DOMAIN } from '../../common/constants.js';

// ─── Icons ────────────────────────────────────────────────────────────────────

function svgIcon(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// Green circle + checkmark
const ICON_SOLVED = svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="#2e7d32"/><path d="M4.5 8.5l2.5 2.5 5-5.5" stroke="white" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>');
// Blue circle + open arrows (cycle)
const ICON_OPEN = svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="#1a73e8"/><path d="M5 8a3 3 0 1 1 3 3" stroke="white" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M5 6.5V8H6.5" stroke="white" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>');
// Red circle + X
const ICON_NOT_TICKET = svgIcon('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7.5" fill="#c62828"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" stroke-width="1.8" stroke-linecap="round"/></svg>');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isShadowEmail(email) {
  return typeof email === 'string' && email.includes('@' + SHADOW_DOMAIN);
}

function extractTicketId(shadowEmail) {
  // Shadow address format: "tkt-{ticketId}@{domain}"
  // ticketId itself starts with "tkt-", so local part = "tkt-tkt-xyz"
  const localPart = shadowEmail.split('@')[0];
  return localPart.startsWith('tkt-') ? localPart.slice(4) : localPart;
}

function getShadowRecipient(composeView) {
  try {
    const recipients = composeView.getToRecipients();
    if (!recipients || !recipients.length) return null;
    const first = recipients[0];
    const email = typeof first === 'string' ? first : first.emailAddress;
    return isShadowEmail(email) ? email : null;
  } catch {
    return null;
  }
}

async function sendWithStatus(sdk, composeView, ydoc, ticketId, newStatus) {
  const tickets = ydoc.getMap('tickets');
  const replyQueue = ydoc.getArray('replyQueue');
  const ticket = tickets.get(ticketId);

  if (!ticket) {
    sdk.ButterBar.showError({ text: 'Ticket not found', time: 5000 });
    return;
  }

  // Dedup: skip if a pending/sending entry already exists for this ticket
  const alreadyQueued = replyQueue.toArray().find(
    e => e.ticketId === ticketId && (e.status === 'pending' || e.status === 'sending')
  );
  if (alreadyQueued) {
    console.log(`[Supp] Compose button: duplicate suppressed for ${ticketId}`);
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
    statusAfterSend: newStatus,
  };

  replyQueue.push([entry]);

  // Update ticket status atomically with the reply queue push
  tickets.set(ticketId, { ...ticket, status: newStatus, lastModified: Date.now() });

  // Discard draft and navigate away (same pattern as reply-interceptor)
  try { composeView.setBodyHTML(''); } catch {}
  try { composeView.discard(); } catch {}
  sdk.Router.goto(sdk.Router.NativeRouteIDs.INBOX);

  sdk.ButterBar.showMessage({ text: `Reply sent, ticket marked as ${newStatus}`, time: 5000 });
}

async function excludeTicket(sdk, ydoc, ticketId) {
  const tickets = ydoc.getMap('tickets');
  const ticket = tickets.get(ticketId);
  if (!ticket) return;
  tickets.set(ticketId, { ...ticket, excluded: true, lastModified: Date.now() });
  sdk.ButterBar.showMessage({ text: 'Thread removed from Supp tracking', time: 3000 });
}

// ─── initComposeButtons ───────────────────────────────────────────────────────

/**
 * Register compose view handler for Supp toolbar buttons.
 * Only adds buttons when the compose is a reply to a shadow email.
 *
 * @param {object} sdk   - InboxSDK instance
 * @param {import('yjs').Doc} ydoc
 */
export function initComposeButtons(sdk, ydoc) {
  sdk.Compose.registerComposeViewHandler((composeView) => {
    let buttonsAdded = false;

    function tryAddButtons() {
      if (buttonsAdded) return;

      const shadowEmail = getShadowRecipient(composeView);
      if (!shadowEmail) return;

      buttonsAdded = true;
      const ticketId = extractTicketId(shadowEmail);

      composeView.addButton({
        title: 'Send + Solved',
        iconUrl: ICON_SOLVED,
        section: 'SEND_ACTIONS',
        type: 'MODIFIER',
        onClick: async () => {
          await sendWithStatus(sdk, composeView, ydoc, ticketId, 'solved');
        },
      });

      composeView.addButton({
        title: 'Send + Open',
        iconUrl: ICON_OPEN,
        section: 'SEND_ACTIONS',
        type: 'MODIFIER',
        onClick: async () => {
          await sendWithStatus(sdk, composeView, ydoc, ticketId, 'open');
        },
      });

      composeView.addButton({
        title: 'Not a ticket',
        iconUrl: ICON_NOT_TICKET,
        section: 'SEND_ACTIONS',
        type: 'MODIFIER',
        onClick: async () => {
          await excludeTicket(sdk, ydoc, ticketId);
          try { composeView.close(); } catch {}
        },
      });
    }

    // Check immediately (works for reply composes where To: is pre-filled)
    // and after a short delay to handle any async compose initialisation.
    tryAddButtons();
    setTimeout(tryAddButtons, 200);

    // Also re-check when recipients change (e.g. user changes the To: field)
    try {
      composeView.on('recipientsChanged', () => {
        // Do NOT reset buttonsAdded — InboxSDK fires this event multiple times
        // during compose view initialization, which would cause duplicate button adds.
        // tryAddButtons() already guards via buttonsAdded, so re-adding is safe to skip.
        tryAddButtons();
      });
    } catch {}
  });

  console.log('[Supp] Compose buttons initialized');
}
