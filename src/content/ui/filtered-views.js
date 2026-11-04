// Supp v2 - Filtered Views
// Registers 6 custom list routes + nav items in Gmail sidebar.
// All ticket data is sourced directly from the Yjs `tickets` map.

import { FILTERED_VIEW_ROUTES, MAX_THREADS_PER_PAGE } from '../../common/constants.js';

// ── Query helpers ─────────────────────────────────────────────────────────────

/**
 * Return the thread ID visible to this user for a given ticket.
 * Agents see their shadow thread; the shared inbox sees the original thread.
 * If no shadow has been created for this agent yet, fall back to the original thread
 * so the count and view stay consistent.
 */
function visibleThreadId(ticket, agentEmail) {
  return ticket.shadowThreads?.[agentEmail] || ticket.originalThreadId || null;
}

function buildFilters(agentEmail) {
  return {
    [FILTERED_VIEW_ROUTES.ALL]:        (t) => !t.excluded,
    [FILTERED_VIEW_ROUTES.MINE]:       (t) => t.assignee === agentEmail && !t.excluded,
    [FILTERED_VIEW_ROUTES.OPEN]:       (t) => t.status === 'open' && !t.excluded,
    [FILTERED_VIEW_ROUTES.PENDING]:    (t) => t.status === 'pending' && !t.excluded,
    [FILTERED_VIEW_ROUTES.SOLVED]:     (t) => t.status === 'solved' && !t.excluded,
    [FILTERED_VIEW_ROUTES.UNASSIGNED]: (t) => t.assignee === null && !t.excluded,
  };
}

function queryTickets(tickets, filterFn) {
  const results = [];
  tickets.forEach((ticket) => {
    if (filterFn(ticket)) results.push(ticket);
  });
  // Stable sort: lastModified DESC, ticketId ASC as tiebreaker
  return results.sort((a, b) => {
    const diff = (b.lastModified || 0) - (a.lastModified || 0);
    return diff !== 0 ? diff : (a.ticketId < b.ticketId ? -1 : 1);
  });
}

/**
 * Returns filtered tickets for a given route ID.
 * Exported for use by the debug bridge in test builds.
 */
export function getFilteredTickets(ydoc, routeID, agentEmail) {
  const tickets = ydoc.getMap('tickets');
  const filters = buildFilters(agentEmail);
  const filterFn = filters[routeID];
  if (!filterFn) return [];
  return queryTickets(tickets, filterFn);
}

// ── Init ──────────────────────────────────────────────────────────────────────

/**
 * Register all 6 Supp custom list routes and add nav items to the Gmail sidebar.
 *
 * @param {object} sdk         InboxSDK instance
 * @param {Y.Doc}  ydoc        Shared Yjs document
 * @param {string} agentEmail  Email of the current agent (used for "My Tickets" filter)
 */
export function initFilteredViews(sdk, ydoc, agentEmail) {
  const tickets = ydoc.getMap('tickets');
  const filters = buildFilters(agentEmail);

  // ── Nav section ────────────────────────────────────────────────────────────
  const suppSection = sdk.NavMenu.addNavItem({
    name: 'Supp',
    iconUrl: chrome.runtime.getURL('icons/icon-16.png'),
    type: sdk.NavMenu.NavItemTypes.NAVIGATION,
  });

  const NAV_DEFS = [
    { name: 'All Tickets', routeID: FILTERED_VIEW_ROUTES.ALL },
    { name: 'My Tickets',  routeID: FILTERED_VIEW_ROUTES.MINE },
    { name: 'Open',        routeID: FILTERED_VIEW_ROUTES.OPEN },
    { name: 'Pending',     routeID: FILTERED_VIEW_ROUTES.PENDING },
    { name: 'Solved',      routeID: FILTERED_VIEW_ROUTES.SOLVED },
    { name: 'Unassigned',  routeID: FILTERED_VIEW_ROUTES.UNASSIGNED },
  ];

  const navItems = {};
  for (const { name, routeID } of NAV_DEFS) {
    navItems[routeID] = suppSection.addNavItem({
      name,
      routeID,
      type: sdk.NavMenu.NavItemTypes.NAVIGATION,
    });
  }

  // ── Badge counts — injected once element resolves, updated via Yjs observe ──
  // getElement() returns Promise<HTMLElement>, so we resolve it per nav item
  // and store the badge element for fast subsequent updates.
  const badges = {};

  for (const [routeID, navItem] of Object.entries(navItems)) {
    navItem.getElement().then((el) => {
      // Gmail's nav row (.TO) is not a flex container — use absolute positioning
      // so the badge sits on the right of the row without affecting layout
      const row = el.querySelector('.TO') || el.firstElementChild || el;
      row.style.position = 'relative';

      const badge = document.createElement('span');
      badge.setAttribute('data-supp-count', '');
      badge.style.cssText = [
        'position:absolute', 'right:8px', 'top:50%', 'transform:translateY(-50%)',
        'font-size:11px', 'font-weight:500', 'line-height:1',
        'background:#1a73e8', 'color:#fff',
        'border-radius:10px', 'padding:2px 6px',
        'pointer-events:none', 'display:none',
      ].join(';');
      row.appendChild(badge);
      badges[routeID] = badge;
      // Render initial count — only tickets with a visible thread for this user
      const count = queryTickets(tickets, filters[routeID])
        .filter(t => visibleThreadId(t, agentEmail)).length;
      badge.textContent = String(count);
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }).catch(() => { /* element never resolved — skip */ });
  }

  function updateCounts() {
    for (const [routeID, badge] of Object.entries(badges)) {
      const count = queryTickets(tickets, filters[routeID])
        .filter(t => visibleThreadId(t, agentEmail)).length;
      badge.textContent = String(count);
      badge.style.display = count > 0 ? 'inline-block' : 'none';
    }
  }

  tickets.observe(() => updateCounts());

  // ── Custom list route handlers ─────────────────────────────────────────────
  for (const routeID of Object.keys(filters)) {
    sdk.Router.handleCustomListRoute(routeID, (offset, max) => {
      // Only include tickets that have a thread visible to this user
      const filtered = queryTickets(tickets, filters[routeID])
        .filter(t => visibleThreadId(t, agentEmail));
      const total = filtered.length;
      const page = filtered.slice(offset, offset + (max || MAX_THREADS_PER_PAGE));
      const threads = page.map(t => visibleThreadId(t, agentEmail));
      return { threads, total };
    });
  }

  console.log('[Supp] Filtered views initialized');
}
