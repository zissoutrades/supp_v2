// Supp v2 - Thread Row Labels
// Registers a global thread row handler that injects status/assignee/tag
// labels onto Gmail thread rows that correspond to Supp tickets.

import { MAX_TAGS_IN_ROW } from '../../common/constants.js';
import { awareness } from '../yjs/doc.js';

// ── Label styles ──────────────────────────────────────────────────────────────

const STATUS_COLORS = {
  open:    { fg: '#1b7e2c', bg: '#e6f4ea' },
  pending: { fg: '#b06000', bg: '#fef7e0' },
  solved:  { fg: '#5f6368', bg: '#f1f3f4' },
};

// ── Agent display name helper ─────────────────────────────────────────────────

function getAgentDisplayName(agentEmail, presence) {
  for (const entry of presence) {
    if (entry.email === agentEmail && entry.name) return entry.name;
  }
  // Fallback: use the part before @
  return agentEmail.split('@')[0];
}

// ── Thread lookup ─────────────────────────────────────────────────────────────

/**
 * Find a ticket whose shadow thread for this agent matches the given thread ID.
 */
function findTicketByThreadId(tickets, agentEmail, threadId) {
  for (const ticket of tickets.values()) {
    if (ticket.shadowThreads?.[agentEmail] === threadId) return ticket;
    // Also match the original thread so labels appear in the shared inbox
    if (ticket.originalThreadId === threadId) return ticket;
  }
  return null;
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Register the global thread row view handler that adds Supp labels.
 *
 * @param {object} sdk         InboxSDK instance
 * @param {Y.Doc}  ydoc        Shared Yjs document
 * @param {string} agentEmail  Email of the current agent
 */
export function initThreadLabels(sdk, ydoc, agentEmail) {
  const tickets = ydoc.getMap('tickets');

  sdk.Lists.registerThreadRowViewHandler((threadRowView) => {
    // getThreadIDIfStable() returns null when the ID is not yet available
    const threadId = threadRowView.getThreadIDIfStable();
    if (!threadId) return;

    const ticket = findTicketByThreadId(tickets, agentEmail, threadId);
    if (!ticket) return;

    // ── Status badge ─────────────────────────────────────────────────────────
    const statusColors = STATUS_COLORS[ticket.status] || STATUS_COLORS.open;
    threadRowView.addLabel({
      title: ticket.status.toUpperCase(),
      foregroundColor: statusColors.fg,
      backgroundColor: statusColors.bg,
      iconHtml: `<span data-supp-status="${ticket.status}" data-supp-ticket style="display:none"></span>`,
    });

    // ── Assignee badge ────────────────────────────────────────────────────────
    if (ticket.assignee) {
      const displayName = getAgentDisplayName(ticket.assignee, awareness.getStates().values());
      threadRowView.addLabel({
        title: displayName,
        foregroundColor: '#1a73e8',
        backgroundColor: '#e8f0fe',
      });
    }

    // ── Tag badges (up to MAX_TAGS_IN_ROW) ────────────────────────────────────
    const tags = ticket.tags || [];
    tags.slice(0, MAX_TAGS_IN_ROW).forEach(tag => {
      threadRowView.addLabel({
        title: tag,
        foregroundColor: '#5f6368',
        backgroundColor: '#f1f3f4',
        iconHtml: `<span data-supp-tag="${tag}" style="display:none"></span>`,
      });
    });
  });

  console.log('[Supp] Thread labels initialized');
}
