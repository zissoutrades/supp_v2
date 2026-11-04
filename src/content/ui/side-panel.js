// Supp v2 - Side Panel UI
// InboxSDK ContentPanelView — ticket metadata form with two-way Yjs binding.
// buildSidePanelElement() is shared between the production path (InboxSDK) and
// the test path (openSidePanelForTest via debug bridge).

import { MAX_TAGS_PER_TICKET } from '../../common/constants.js';
import { awareness } from '../yjs/doc.js';

const PANEL_ORIGIN = 'side-panel';

// ── Utility ───────────────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function getAllExistingTags(tickets) {
  const tagSet = new Set();
  tickets.forEach((ticket) => {
    ticket.tags?.forEach(tag => tagSet.add(tag));
  });
  return Array.from(tagSet).sort();
}

function updateTicket(ticketId, ydoc, patch) {
  const tickets = ydoc.getMap('tickets');
  ydoc.transact(() => {
    const current = tickets.get(ticketId);
    if (current) tickets.set(ticketId, { ...current, ...patch, lastModified: Date.now() });
  }, PANEL_ORIGIN);
}

// ── Status Selector ───────────────────────────────────────────────────────────

function buildStatusSelector(ticket, ticketId, ydoc) {
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-supp-status-selector', '');
  wrapper.style.cssText = 'display:flex;gap:6px;margin-bottom:12px';

  const statuses = [
    { value: 'open',    label: 'Open',    color: '#34a853' },
    { value: 'pending', label: 'Pending', color: '#fbbc04' },
    { value: 'solved',  label: 'Solved',  color: '#9aa0a6' },
  ];

  for (const { value, label, color } of statuses) {
    const btn = document.createElement('button');
    btn.setAttribute('data-supp-status-option', value);
    btn.textContent = label;
    const active = ticket.status === value;
    btn.style.cssText = [
      'flex:1', 'padding:6px 0', `border:1px solid ${color}`, 'border-radius:4px',
      `background:${active ? color : '#fff'}`, `color:${active ? '#fff' : color}`,
      'cursor:pointer', 'font-size:12px', 'font-weight:500',
    ].join(';');
    btn.addEventListener('click', () => updateTicket(ticketId, ydoc, { status: value }));
    wrapper.appendChild(btn);
  }
  return wrapper;
}

function refreshStatusSelector(statusSel, status) {
  const colors = { open: '#34a853', pending: '#fbbc04', solved: '#9aa0a6' };
  for (const [value, color] of Object.entries(colors)) {
    const btn = statusSel.querySelector(`[data-supp-status-option="${value}"]`);
    if (!btn) continue;
    const active = status === value;
    btn.style.background = active ? color : '#fff';
    btn.style.color      = active ? '#fff' : color;
  }
}

// ── Assignee Selector ────────────────────────────────────────────────────────

function buildAssigneeSelector(ticket, ticketId, ydoc) {
  const label = document.createElement('label');
  label.textContent = 'Assignee';
  label.style.cssText = 'font-size:11px;color:#5f6368;font-weight:500;display:block;margin-bottom:4px';

  const select = document.createElement('select');
  select.setAttribute('data-supp-assignee-selector', '');
  select.style.cssText = 'width:100%;padding:6px 8px;border:1px solid #dadce0;border-radius:4px;font-size:13px;color:#202124;background:#fff;cursor:pointer;margin-bottom:12px';

  const unassigned = document.createElement('option');
  unassigned.value = '';
  unassigned.textContent = 'Unassigned';
  unassigned.setAttribute('data-supp-assignee-option', '');
  select.appendChild(unassigned);

  // Deduplicate by email — prefer entries with a name field
  const byEmail = new Map();
  for (const agent of awareness.getStates().values()) {
    if (!agent.email) continue;
    const existing = byEmail.get(agent.email);
    if (!existing || (!existing.name && agent.name)) byEmail.set(agent.email, agent);
  }
  for (const agent of byEmail.values()) {
    const opt = document.createElement('option');
    opt.value = agent.email;
    opt.textContent = agent.name ? `${agent.name} (${agent.email})` : agent.email;
    opt.setAttribute('data-supp-assignee-option', agent.email);
    select.appendChild(opt);
  }
  select.value = ticket.assignee || '';

  select.addEventListener('change', () => {
    updateTicket(ticketId, ydoc, { assignee: select.value || null });
  });

  const wrapper = document.createElement('div');
  wrapper.appendChild(label);
  wrapper.appendChild(select);
  return wrapper;
}

// ── Tag Input ────────────────────────────────────────────────────────────────

function buildTagInput(ticket, ticketId, ydoc) {
  const tickets = ydoc.getMap('tickets');

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-supp-tag-wrapper', '');

  const label = document.createElement('label');
  label.textContent = 'Tags';
  label.style.cssText = 'font-size:11px;color:#5f6368;font-weight:500;display:block;margin-bottom:4px';
  wrapper.appendChild(label);

  const tagArea = document.createElement('div');
  tagArea.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;padding:6px;border:1px solid #dadce0;border-radius:4px;min-height:32px;margin-bottom:12px;position:relative;align-items:center';

  const input = document.createElement('input');
  input.setAttribute('data-supp-tag-input', '');
  input.placeholder = 'Add tag…';
  input.style.cssText = 'border:none;outline:none;font-size:12px;min-width:80px;flex:1;background:transparent';
  tagArea.appendChild(input);

  const suggestionsEl = document.createElement('div');
  suggestionsEl.style.cssText = 'position:absolute;left:0;right:0;top:100%;background:#fff;border:1px solid #dadce0;border-radius:4px;box-shadow:0 2px 8px rgba(0,0,0,0.1);z-index:100;display:none';
  tagArea.appendChild(suggestionsEl);

  let selectedIdx = -1;

  function renderTags(tags) {
    tagArea.querySelectorAll('[data-supp-tag]').forEach(el => el.remove());
    for (const tag of (tags || [])) {
      const badge = document.createElement('span');
      badge.setAttribute('data-supp-tag', tag);
      badge.style.cssText = 'display:inline-flex;align-items:center;gap:4px;padding:2px 8px;background:#e8f0fe;color:#1a73e8;border-radius:10px;font-size:12px';
      badge.textContent = tag;
      const x = document.createElement('span');
      x.textContent = '×';
      x.style.cssText = 'cursor:pointer;font-size:14px;line-height:1';
      x.addEventListener('click', () => {
        const current = tickets.get(ticketId);
        if (!current) return;
        updateTicket(ticketId, ydoc, { tags: current.tags.filter(t => t !== tag) });
      });
      badge.appendChild(x);
      tagArea.insertBefore(badge, input);
    }
  }

  function highlightSuggestion(idx) {
    selectedIdx = idx;
    suggestionsEl.querySelectorAll('div').forEach((el, i) => {
      el.style.background = i === idx ? '#f1f3f4' : '';
    });
  }

  function addTag(tag) {
    const trimmed = tag.trim();
    if (!trimmed) return;
    const current = tickets.get(ticketId);
    if (!current) return;
    if (current.tags?.includes(trimmed) || (current.tags?.length || 0) >= MAX_TAGS_PER_TICKET) {
      input.value = '';
      suggestionsEl.style.display = 'none';
      return;
    }
    updateTicket(ticketId, ydoc, { tags: [...(current.tags || []), trimmed] });
    input.value = '';
    suggestionsEl.style.display = 'none';
  }

  function showSuggestions(text) {
    const all = getAllExistingTags(tickets);
    const current = tickets.get(ticketId)?.tags || [];
    const filtered = all.filter(t => !current.includes(t) && t.toLowerCase().includes(text.toLowerCase()));
    suggestionsEl.innerHTML = '';
    selectedIdx = -1;
    if (!filtered.length || !text) { suggestionsEl.style.display = 'none'; return; }
    filtered.slice(0, 5).forEach((tag, i) => {
      const item = document.createElement('div');
      item.textContent = tag;
      item.style.cssText = 'padding:6px 10px;cursor:pointer;font-size:12px;color:#202124';
      item.addEventListener('mouseenter', () => highlightSuggestion(i));
      item.addEventListener('mousedown', (e) => { e.preventDefault(); addTag(tag); });
      suggestionsEl.appendChild(item);
    });
    suggestionsEl.style.display = 'block';
  }

  input.addEventListener('input', () => showSuggestions(input.value));
  input.addEventListener('keydown', (e) => {
    const items = suggestionsEl.querySelectorAll('div');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      highlightSuggestion(Math.min(selectedIdx + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      highlightSuggestion(Math.max(selectedIdx - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (selectedIdx >= 0 && items[selectedIdx]) {
        addTag(items[selectedIdx].textContent);
      } else {
        addTag(input.value);
      }
    } else if (e.key === ' ') {
      const trimmed = input.value.trim();
      if (trimmed) {
        e.preventDefault();
        addTag(trimmed);
      }
    } else if (e.key === 'Escape') {
      suggestionsEl.style.display = 'none';
    }
  });
  input.addEventListener('blur', () => {
    setTimeout(() => { suggestionsEl.style.display = 'none'; }, 150);
  });

  renderTags(ticket.tags);
  wrapper._renderTags = renderTags;
  wrapper.appendChild(tagArea);
  return wrapper;
}

// ── Text Fields ───────────────────────────────────────────────────────────────

function buildTextField(ticket, ticketId, ydoc, { field, labelText, placeholder, multiline, dataAttr }) {
  const label = document.createElement('label');
  label.textContent = labelText;
  label.style.cssText = 'font-size:11px;color:#5f6368;font-weight:500;display:block;margin-bottom:4px';

  const base = 'width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #dadce0;border-radius:4px;font-size:13px;color:#202124;font-family:inherit;margin-bottom:12px';

  let el;
  if (multiline) {
    el = document.createElement('textarea');
    el.rows = 3;
    el.style.cssText = base + ';resize:vertical';
  } else {
    el = document.createElement('input');
    el.type = 'text';
    el.style.cssText = base;
  }
  el.setAttribute(dataAttr, '');
  el.placeholder = placeholder || '';
  el.value = ticket[field] || '';

  el.addEventListener('blur', () => updateTicket(ticketId, ydoc, { [field]: el.value }));

  const wrapper = document.createElement('div');
  wrapper.appendChild(label);
  wrapper.appendChild(el);
  return wrapper;
}

// ── Info Section ─────────────────────────────────────────────────────────────

function buildInfoSection(ticket) {
  const section = document.createElement('div');
  section.style.cssText = 'border-top:1px solid #e8eaed;padding-top:10px;margin-top:4px;font-size:12px;color:#5f6368';

  const rows = [
    ['Customer', ticket.customerEmail || '—'],
    ['Created',  formatDate(ticket.createdAt)],
    ['Last reply', ticket.lastReply ? `${formatDate(ticket.lastReply)} by ${ticket.lastReplyBy || '?'}` : '—'],
    ['Messages', ticket.messageCount ?? '—'],
  ];

  for (const [key, val] of rows) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;margin-bottom:4px';
    const k = document.createElement('span');
    k.style.cssText = 'font-weight:500;min-width:70px';
    k.textContent = key;
    const v = document.createElement('span');
    v.textContent = String(val);
    row.appendChild(k);
    row.appendChild(v);
    section.appendChild(row);
  }
  return section;
}

// ── Panel Assembly ────────────────────────────────────────────────────────────

export function buildSidePanelElement(ticketId, ticket, ydoc) {
  const container = document.createElement('div');
  container.setAttribute('data-supp-side-panel', '');
  container.style.cssText = 'padding:12px;font-family:Google Sans,Roboto,sans-serif;font-size:13px;color:#202124;background:#fff';

  if (ticket.excluded) {
    const msg = document.createElement('p');
    msg.textContent = 'This thread has been excluded from Supp.';
    msg.style.cssText = 'color:#5f6368;font-size:13px;margin:0 0 12px';
    const btn = document.createElement('button');
    btn.textContent = 'Re-include';
    btn.style.cssText = 'padding:6px 14px;background:#1a73e8;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:13px';
    btn.addEventListener('click', () => updateTicket(ticketId, ydoc, { excluded: false }));
    container.appendChild(msg);
    container.appendChild(btn);
    return container;
  }

  container.appendChild(buildStatusSelector(ticket, ticketId, ydoc));
  container.appendChild(buildAssigneeSelector(ticket, ticketId, ydoc));
  container.appendChild(buildTagInput(ticket, ticketId, ydoc));
  container.appendChild(buildTextField(ticket, ticketId, ydoc, {
    field: 'customerId', labelText: 'Customer ID',
    placeholder: 'Customer or user ID', dataAttr: 'data-supp-customer-id',
  }));
  container.appendChild(buildTextField(ticket, ticketId, ydoc, {
    field: 'notes', labelText: 'Internal notes',
    placeholder: 'Internal notes (not sent to customer)',
    multiline: true, dataAttr: 'data-supp-notes',
  }));
  container.appendChild(buildInfoSection(ticket));

  return container;
}

// ── Yjs Observer ──────────────────────────────────────────────────────────────

function setupYjsObserver(el, ticketId, ydoc) {
  const tickets = ydoc.getMap('tickets');

  function observer() {
    const updated = tickets.get(ticketId);
    if (!updated) return;

    const statusSel = el.querySelector('[data-supp-status-selector]');
    if (statusSel) refreshStatusSelector(statusSel, updated.status);

    const assigneeSel = el.querySelector('[data-supp-assignee-selector]');
    if (assigneeSel && document.activeElement !== assigneeSel) {
      assigneeSel.value = updated.assignee || '';
    }

    const tagWrapper = el.querySelector('[data-supp-tag-wrapper]');
    if (tagWrapper?._renderTags) tagWrapper._renderTags(updated.tags);

    const customerEl = el.querySelector('[data-supp-customer-id]');
    if (customerEl && document.activeElement !== customerEl) customerEl.value = updated.customerId || '';

    const notesEl = el.querySelector('[data-supp-notes]');
    if (notesEl && document.activeElement !== notesEl) notesEl.value = updated.notes || '';
  }

  tickets.observe(observer);
  return observer;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Register InboxSDK thread view handler (production path).
 * Called from main.js when InboxSDK is loaded.
 */
export function initSidePanel(sdk, ydoc) {
  const tickets = ydoc.getMap('tickets');

  function findTicketForThread(threadId) {
    for (const [id, ticket] of tickets.entries()) {
      if (
        ticket.originalThreadId === threadId ||
        Object.values(ticket.shadowThreads || {}).includes(threadId)
      ) {
        return { matchTicketId: id, matchTicket: ticket };
      }
    }
    return null;
  }

  sdk.Conversations.registerThreadViewHandler(async (threadView) => {
    const threadId = await threadView.getThreadIDAsync();
    if (!threadId) return;

    let destroyed = false;
    threadView.on('destroy', () => { destroyed = true; });

    function attachPanel(matchTicketId, matchTicket) {
      const el       = buildSidePanelElement(matchTicketId, matchTicket, ydoc);
      const observer = setupYjsObserver(el, matchTicketId, ydoc);

      threadView.addSidebarContentPanel({
        title:   'Supp Ticket',
        iconUrl: chrome.runtime.getURL('icons/icon-16.png'),
        el,
      });

      threadView.on('destroy', () => tickets.unobserve(observer));
    }

    // Try immediate lookup first
    const immediate = findTicketForThread(threadId);
    if (immediate) {
      attachPanel(immediate.matchTicketId, immediate.matchTicket);
      return;
    }

    // Not found yet — Yjs sync may still be in flight.
    // Wait up to 5s for a matching ticket to arrive via observer.
    let waitObserver = null;
    const timeout = setTimeout(() => {
      if (waitObserver) tickets.unobserve(waitObserver);
    }, 5000);

    waitObserver = () => {
      if (destroyed) {
        clearTimeout(timeout);
        tickets.unobserve(waitObserver);
        return;
      }
      const match = findTicketForThread(threadId);
      if (!match) return;
      clearTimeout(timeout);
      tickets.unobserve(waitObserver);
      attachPanel(match.matchTicketId, match.matchTicket);
    };

    tickets.observe(waitObserver);
  });
}

/**
 * Mount the side panel directly onto the page (test / debug path).
 * Called by the debug bridge via openSidePanel(ticketId).
 */
export function openSidePanelForTest(ticketId, ydoc) {
  const tickets = ydoc.getMap('tickets');
  const ticket  = tickets.get(ticketId);
  if (!ticket) {
    console.warn('[Supp Debug] openSidePanel: no ticket found for', ticketId);
    return;
  }

  // Remove any previously mounted test panel
  document.querySelector('[data-supp-panel-test-wrapper]')?.remove();

  const el       = buildSidePanelElement(ticketId, ticket, ydoc);
  const observer = setupYjsObserver(el, ticketId, ydoc);

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-supp-panel-test-wrapper', '');
  wrapper.style.cssText = [
    'position:fixed', 'top:10px', 'right:10px', 'width:300px',
    'max-height:90vh', 'overflow-y:auto', 'z-index:99999',
    'background:#fff', 'border:1px solid #dadce0', 'border-radius:8px',
    'box-shadow:0 2px 8px rgba(0,0,0,0.15)',
  ].join(';');
  wrapper.appendChild(el);
  document.body.appendChild(wrapper);

  return () => {
    tickets.unobserve(observer);
    wrapper.remove();
  };
}
