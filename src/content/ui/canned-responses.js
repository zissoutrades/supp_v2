// Supp v2 — Canned Responses
// Canned response storage, compose dropdown, and management modal.
//
// Storage:
//   Personal CRs — chrome.storage.local['personalCannedResponses'] = CannedResponse[]
//   Team CRs     — Yjs cannedResponses Y.Map<id, CannedResponse>
//
// InboxSDK compose button opens a dropdown with fuzzy search.
// Management modal accessible via "Manage responses" link in the dropdown.

import { nanoid } from 'nanoid';

// Gray rounded-rect with three lines (list/template icon)
const ICON_CANNED = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="0.5" y="0.5" width="15" height="15" rx="2.5" fill="#5f6368"/><rect x="3" y="4" width="10" height="1.5" rx="0.75" fill="white"/><rect x="3" y="7.25" width="10" height="1.5" rx="0.75" fill="white"/><rect x="3" y="10.5" width="6.5" height="1.5" rx="0.75" fill="white"/></svg>')}`;

// ─── Storage helpers ──────────────────────────────────────────────────────────

const PERSONAL_STORAGE_KEY = 'personalCannedResponses';

/** @returns {Promise<CannedResponse[]>} */
export async function getPersonalResponses() {
  const result = await chrome.storage.local.get([PERSONAL_STORAGE_KEY]);
  return result[PERSONAL_STORAGE_KEY] || [];
}

/** @param {CannedResponse} cr */
export async function savePersonalResponse(cr) {
  const existing = await getPersonalResponses();
  const idx = existing.findIndex(r => r.id === cr.id);
  if (idx >= 0) {
    existing[idx] = cr;
  } else {
    existing.push(cr);
  }
  await chrome.storage.local.set({ [PERSONAL_STORAGE_KEY]: existing });
}

/** @param {string} id */
export async function deletePersonalResponse(id) {
  const existing = await getPersonalResponses();
  await chrome.storage.local.set({
    [PERSONAL_STORAGE_KEY]: existing.filter(r => r.id !== id),
  });
}

/** @param {import('yjs').Doc} ydoc */
export function getTeamResponses(ydoc) {
  return Array.from(ydoc.getMap('cannedResponses').entries()).map(([, v]) => v);
}

/** @param {import('yjs').Doc} ydoc @param {CannedResponse} cr */
export function saveTeamResponse(ydoc, cr) {
  ydoc.getMap('cannedResponses').set(cr.id, cr);
}

/** @param {import('yjs').Doc} ydoc @param {string} id */
export function deleteTeamResponse(ydoc, id) {
  ydoc.getMap('cannedResponses').delete(id);
}

/** @param {import('yjs').Doc} ydoc @returns {Promise<CannedResponse[]>} */
export async function getAllResponses(ydoc) {
  const [personal, team] = await Promise.all([
    getPersonalResponses(),
    Promise.resolve(getTeamResponses(ydoc)),
  ]);
  // Merge, sort by usageCount desc then lastUsedAt desc
  return [...personal, ...team].sort((a, b) => {
    if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
    return (b.lastUsedAt || 0) - (a.lastUsedAt || 0);
  });
}

/** Increment usageCount and lastUsedAt for a CR (personal or team). */
export async function incrementUsage(ydoc, id, scope) {
  if (scope === 'personal') {
    const existing = await getPersonalResponses();
    const cr = existing.find(r => r.id === id);
    if (cr) {
      cr.usageCount = (cr.usageCount || 0) + 1;
      cr.lastUsedAt = Date.now();
      await chrome.storage.local.set({ [PERSONAL_STORAGE_KEY]: existing });
    }
  } else {
    const map = ydoc.getMap('cannedResponses');
    const cr = map.get(id);
    if (cr) {
      map.set(id, { ...cr, usageCount: (cr.usageCount || 0) + 1, lastUsedAt: Date.now() });
    }
  }
}

// ─── Variable substitution ────────────────────────────────────────────────────

const VARIABLE_MAP = {
  customer_name:  ticket => ticket?.customerName  || '',
  customer_email: ticket => ticket?.customerEmail || '',
  ticket_id:      ticket => ticket?.ticketId      || '',
  status:         ticket => ticket?.status        || '',
};

/**
 * Replace {{variable}} placeholders in a CR body.
 *
 * @param {string} body
 * @param {object|null} ticket  - TicketMetadata (may be null)
 * @param {string} agentName    - Current agent display name
 * @returns {string}
 */
export function substituteVariables(body, ticket, agentName) {
  return body.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (key === 'agent_name') return agentName || match;
    if (VARIABLE_MAP[key]) return VARIABLE_MAP[key](ticket);
    return match; // unknown variable — leave as-is
  });
}

// ─── Fuzzy search ─────────────────────────────────────────────────────────────

/**
 * Fuzzy filter + rank CRs by search query.
 * Returns top 10 matches, sorted: prefix match first, then substring, then by usageCount.
 *
 * @param {CannedResponse[]} crs
 * @param {string} query
 * @returns {CannedResponse[]}
 */
function fuzzyFilter(crs, query) {
  if (!query) return crs.slice(0, 10);
  const q = query.toLowerCase();

  const scored = crs.map(cr => {
    const title = (cr.title || '').toLowerCase();
    const body  = (cr.body  || '').slice(0, 100).toLowerCase();
    let score = 0;
    if (title.startsWith(q))          score = 3;
    else if (title.includes(q))        score = 2;
    else if (body.includes(q))         score = 1;
    return { cr, score };
  }).filter(x => x.score > 0);

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return (b.cr.usageCount || 0) - (a.cr.usageCount || 0);
  });

  return scored.slice(0, 10).map(x => x.cr);
}

// ─── Management modal ─────────────────────────────────────────────────────────

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function buildManagementModal(ydoc, agentEmail) {
  const modal = document.createElement('div');
  modal.setAttribute('data-supp-cr-modal', '');
  modal.style.cssText = `
    position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 10000;
    display: none;
  `;

  modal.innerHTML = `
    <div data-supp-cr-overlay style="
      position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
    "></div>
    <div style="
      position: absolute; top: 50%; left: 50%;
      transform: translate(-50%,-50%);
      background: #fff; border-radius: 8px;
      box-shadow: 0 4px 24px rgba(0,0,0,0.18);
      width: 620px; max-width: 92vw;
      max-height: 82vh; overflow: hidden;
      display: flex; flex-direction: column;
      font-family: Google Sans, Roboto, sans-serif;
    ">
      <!-- Header -->
      <div style="
        display: flex; justify-content: space-between; align-items: center;
        padding: 18px 24px; border-bottom: 1px solid #e0e0e0;
      ">
        <h2 style="margin:0; font-size:17px; font-weight:500; color:#202124;">
          Manage Canned Responses
        </h2>
        <button data-supp-cr-close style="
          background: none; border: none; font-size: 26px; line-height: 1;
          color: #5f6368; cursor: pointer; padding: 0;
          width: 32px; height: 32px; display: flex; align-items: center;
          justify-content: center; border-radius: 50%;
        ">&times;</button>
      </div>

      <!-- Tabs -->
      <div style="display:flex; border-bottom: 1px solid #e0e0e0; padding: 0 24px;">
        <button data-supp-cr-tab="personal" style="
          padding: 10px 16px; border: none; background: none; cursor: pointer;
          font-size: 13px; font-weight: 500; color: #1a73e8;
          border-bottom: 2px solid #1a73e8; margin-bottom: -1px;
        ">Personal</button>
        <button data-supp-cr-tab="team" style="
          padding: 10px 16px; border: none; background: none; cursor: pointer;
          font-size: 13px; font-weight: 500; color: #5f6368;
          border-bottom: 2px solid transparent; margin-bottom: -1px;
        ">Team</button>
      </div>

      <!-- Body -->
      <div style="padding: 20px 24px; overflow-y: auto; flex: 1;">
        <button data-supp-canned-new style="
          background: #1a73e8; color: #fff; border: none;
          padding: 8px 16px; border-radius: 4px; font-size: 13px;
          font-weight: 500; cursor: pointer; margin-bottom: 16px;
        ">+ New canned response</button>

        <div data-supp-cr-list></div>

        <!-- Add/Edit form (hidden initially) -->
        <div data-supp-cr-form style="display:none; margin-top: 16px; padding-top: 16px; border-top: 1px solid #e0e0e0;">
          <h3 data-supp-cr-form-title style="margin:0 0 14px; font-size:15px; font-weight:500; color:#202124;">
            New canned response
          </h3>
          <label style="font-size:12px; color:#5f6368; display:block; margin-bottom:4px;">Title</label>
          <input data-supp-canned-title type="text" placeholder="e.g. Refund policy"
            maxlength="80" style="
              width: 100%; padding: 8px 10px; border: 1px solid #dadce0;
              border-radius: 4px; font-size: 14px; color: #202124;
              box-sizing: border-box; margin-bottom: 12px;
          "/>
          <label style="font-size:12px; color:#5f6368; display:block; margin-bottom:4px;">
            Body <span style="color:#9aa0a6; font-weight:400;">({{customer_name}}, {{ticket_id}}, {{agent_name}}, {{status}} supported)</span>
          </label>
          <textarea data-supp-canned-body rows="7" placeholder="Enter your response template…" style="
            width: 100%; padding: 8px 10px; border: 1px solid #dadce0;
            border-radius: 4px; font-size: 14px; color: #202124;
            resize: vertical; box-sizing: border-box; margin-bottom: 16px;
            font-family: inherit;
          "></textarea>
          <div style="display:flex; gap: 8px;">
            <button data-supp-canned-save-personal style="
              background: #1a73e8; color: #fff; border: none;
              padding: 8px 16px; border-radius: 4px; font-size: 13px;
              font-weight: 500; cursor: pointer;
            ">Save as Personal</button>
            <button data-supp-canned-save-team style="
              background: #fff; color: #1a73e8; border: 1px solid #1a73e8;
              padding: 8px 16px; border-radius: 4px; font-size: 13px;
              font-weight: 500; cursor: pointer;
            ">Save as Team</button>
            <button data-supp-cr-form-cancel style="
              background: #fff; color: #5f6368; border: 1px solid #dadce0;
              padding: 8px 16px; border-radius: 4px; font-size: 13px;
              font-weight: 500; cursor: pointer; margin-left: auto;
            ">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  let activeTab    = 'personal';
  let editingId    = null;

  const overlay    = modal.querySelector('[data-supp-cr-overlay]');
  const closeBtn   = modal.querySelector('[data-supp-cr-close]');
  const personalTab = modal.querySelector('[data-supp-cr-tab="personal"]');
  const teamTab    = modal.querySelector('[data-supp-cr-tab="team"]');
  const listEl     = modal.querySelector('[data-supp-cr-list]');
  const formEl     = modal.querySelector('[data-supp-cr-form]');
  const formTitle  = modal.querySelector('[data-supp-cr-form-title]');
  const titleInput = modal.querySelector('[data-supp-canned-title]');
  const bodyInput  = modal.querySelector('[data-supp-canned-body]');
  const savePersonBtn = modal.querySelector('[data-supp-canned-save-personal]');
  const saveTeamBtn   = modal.querySelector('[data-supp-canned-save-team]');
  const formCancel = modal.querySelector('[data-supp-cr-form-cancel]');
  const newBtn     = modal.querySelector('[data-supp-canned-new]');

  function showTab(tab) {
    activeTab = tab;
    personalTab.style.color      = tab === 'personal' ? '#1a73e8' : '#5f6368';
    personalTab.style.borderBottomColor = tab === 'personal' ? '#1a73e8' : 'transparent';
    teamTab.style.color           = tab === 'team' ? '#1a73e8' : '#5f6368';
    teamTab.style.borderBottomColor = tab === 'team' ? '#1a73e8' : 'transparent';
    renderList();
  }

  async function renderList() {
    let crs;
    if (activeTab === 'personal') {
      crs = await getPersonalResponses();
    } else {
      crs = getTeamResponses(ydoc);
    }
    crs = crs.slice().sort((a, b) => (b.usageCount || 0) - (a.usageCount || 0));

    if (!crs.length) {
      listEl.innerHTML = `<p style="color:#5f6368; text-align:center; padding:20px;">
        No ${activeTab} canned responses yet.
      </p>`;
      return;
    }

    listEl.innerHTML = crs.map(cr => `
      <div data-supp-cr-item="${cr.id}" style="
        border: 1px solid #e0e0e0; border-radius: 6px;
        margin-bottom: 10px; padding: 10px 14px; background: #fff;
      ">
        <div style="display:flex; align-items:center; gap:10px;">
          <div style="flex:1; font-weight:500; font-size:13px; color:#202124;">
            ${escapeHtml(cr.title || '')}
          </div>
          <div style="font-size:11px; color:#9aa0a6;">
            Used ${cr.usageCount || 0}×
          </div>
          <button data-supp-cr-edit="${cr.id}" title="Edit" style="
            background:none; border:none; cursor:pointer; font-size:14px;
            padding:3px 6px; border-radius:4px; color:#5f6368;
          ">✎</button>
          <button data-supp-cr-delete="${cr.id}" title="Delete" style="
            background:none; border:none; cursor:pointer; font-size:14px;
            padding:3px 6px; border-radius:4px; color:#5f6368;
          ">&#128465;</button>
        </div>
        <div style="
          font-size:12px; color:#5f6368; margin-top:4px;
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
        ">${escapeHtml((cr.body || '').slice(0, 120))}</div>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-supp-cr-edit]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-supp-cr-edit');
        const crsAll = activeTab === 'personal'
          ? await getPersonalResponses()
          : getTeamResponses(ydoc);
        const cr = crsAll.find(r => r.id === id);
        if (cr) showForm(cr);
      });
    });

    listEl.querySelectorAll('[data-supp-cr-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-supp-cr-delete');
        if (!confirm('Delete this canned response?')) return;
        if (activeTab === 'personal') {
          await deletePersonalResponse(id);
        } else {
          deleteTeamResponse(ydoc, id);
        }
        renderList();
      });
    });
  }

  function showForm(cr = null) {
    editingId = cr ? cr.id : null;
    formTitle.textContent = cr ? 'Edit canned response' : 'New canned response';
    titleInput.value = cr ? (cr.title || '') : '';
    bodyInput.value  = cr ? (cr.body  || '') : '';
    formEl.style.display = 'block';
    titleInput.focus();
  }

  function hideForm() {
    formEl.style.display = 'none';
    editingId = null;
  }

  async function saveForm(scope) {
    const title = titleInput.value.trim();
    const body  = bodyInput.value.trim();
    if (!title) { titleInput.focus(); return; }
    if (!body)  { bodyInput.focus(); return; }

    const now = Date.now();
    let cr;
    if (editingId) {
      // Preserve existing usage stats
      const existing = scope === 'personal'
        ? (await getPersonalResponses()).find(r => r.id === editingId)
        : getTeamResponses(ydoc).find(r => r.id === editingId);
      cr = { ...(existing || {}), id: editingId, title, body, scope, lastModified: now };
    } else {
      cr = {
        id: 'cr-' + nanoid(),
        title,
        body,
        tags: [],
        scope,
        createdBy: agentEmail || '',
        createdAt: now,
        usageCount: 0,
        lastUsedAt: 0,
        lastModified: now,
      };
    }

    if (scope === 'personal') {
      await savePersonalResponse(cr);
    } else {
      saveTeamResponse(ydoc, cr);
    }
    hideForm();
    renderList();
  }

  // Event wiring
  overlay.addEventListener('click',      () => { modal.style.display = 'none'; });
  closeBtn.addEventListener('click',     () => { modal.style.display = 'none'; });
  personalTab.addEventListener('click',  () => showTab('personal'));
  teamTab.addEventListener('click',      () => showTab('team'));
  newBtn.addEventListener('click',       () => showForm());
  savePersonBtn.addEventListener('click',() => saveForm('personal'));
  saveTeamBtn.addEventListener('click',  () => saveForm('team'));
  formCancel.addEventListener('click',   () => hideForm());

  function open() {
    modal.style.display = 'block';
    showTab(activeTab);
  }

  return { open };
}

// ─── Compose dropdown ─────────────────────────────────────────────────────────

function buildDropdownEl(ydoc, agentEmail, composeView, tickets, modal) {
  const container = document.createElement('div');
  container.style.cssText = `
    width: 280px; background: #fff;
    border-radius: 4px; overflow: hidden;
    font-family: Google Sans, Roboto, sans-serif;
  `;

  container.innerHTML = `
    <div style="padding: 8px 10px; border-bottom: 1px solid #e0e0e0;">
      <input type="text" placeholder="Search canned responses…" style="
        width: 100%; padding: 6px 10px; border: 1px solid #dadce0;
        border-radius: 4px; font-size: 13px; color: #202124;
        box-sizing: border-box; outline: none;
      " />
    </div>
    <div data-supp-cr-results style="
      max-height: 260px; overflow-y: auto;
    "></div>
    <div style="
      padding: 8px 12px; border-top: 1px solid #e0e0e0;
      font-size: 12px; color: #1a73e8; cursor: pointer;
    " data-supp-cr-manage>Manage responses…</div>
  `;

  const searchInput = container.querySelector('input');
  const resultsEl   = container.querySelector('[data-supp-cr-results]');
  const manageLink  = container.querySelector('[data-supp-cr-manage]');

  let debounceTimer;
  let selectedIndex = -1;
  let currentCRs    = [];

  async function renderResults(query = '') {
    const all = await getAllResponses(ydoc);
    currentCRs = fuzzyFilter(all, query);
    selectedIndex = -1;

    if (!currentCRs.length) {
      resultsEl.innerHTML = `<div style="
        padding: 20px; text-align: center;
        font-size: 13px; color: #5f6368;
      ">No canned responses found</div>`;
      return;
    }

    resultsEl.innerHTML = currentCRs.map((cr, i) => `
      <div data-supp-canned-insert="${cr.id}" data-cr-index="${i}" style="
        padding: 8px 12px; cursor: pointer; font-size: 13px; color: #202124;
        border-bottom: 1px solid #f1f3f4;
        display: flex; flex-direction: column; gap: 2px;
      ">
        <div style="
          font-weight: 500; display: flex;
          justify-content: space-between; align-items: center;
        ">
          <span>${escapeHtml(cr.title || '')}</span>
          <span style="
            font-size: 10px; font-weight: 400; padding: 1px 5px;
            border-radius: 10px; background: ${cr.scope === 'team' ? '#e8f0fe' : '#f1f3f4'};
            color: ${cr.scope === 'team' ? '#1a73e8' : '#5f6368'};
          ">${cr.scope === 'team' ? 'Team' : 'Personal'}</span>
        </div>
        <div style="
          font-size: 11px; color: #5f6368;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        ">${escapeHtml((cr.body || '').slice(0, 80))}</div>
      </div>
    `).join('');

    resultsEl.querySelectorAll('[data-supp-canned-insert]').forEach(item => {
      item.addEventListener('mouseenter', () => {
        const idx = parseInt(item.getAttribute('data-cr-index'), 10);
        setSelected(idx);
      });
      item.addEventListener('click', () => {
        const id = item.getAttribute('data-supp-canned-insert');
        insertCR(id);
      });
    });
  }

  function setSelected(idx) {
    selectedIndex = idx;
    resultsEl.querySelectorAll('[data-supp-canned-insert]').forEach((el, i) => {
      el.style.background = i === idx ? '#f1f3f4' : '';
    });
  }

  async function insertCR(crId) {
    const all = await getAllResponses(ydoc);
    const cr = all.find(r => r.id === crId);
    if (!cr) return;

    // Find ticket for variable substitution
    let ticket = null;
    try {
      const recipients = composeView.getToRecipients();
      if (recipients && recipients.length) {
        const first = recipients[0];
        const email = typeof first === 'string' ? first : first.emailAddress;
        if (email && email.includes('.suppapp.com')) {
          const localPart = email.split('@')[0];
          const ticketId = localPart.startsWith('tkt-') ? localPart.slice(4) : localPart;
          ticket = tickets.get(ticketId) || null;
        }
      }
    } catch {}

    const agentName = agentEmail || '';
    const body = substituteVariables(cr.body || '', ticket, agentName);

    // Insert into compose body
    try {
      const existing = composeView.getHTMLContent() || '';
      // Append CR body after existing content
      const htmlBody = body.replace(/\n/g, '<br>');
      composeView.setBodyHTML(existing + (existing ? '<br>' : '') + htmlBody);
    } catch (err) {
      console.warn('[Supp] CR insert failed:', err);
    }

    // Auto-apply tags if the CR has them and we found a ticket
    if (cr.tags && cr.tags.length && ticket) {
      try {
        const ticketMap = ydoc.getMap('tickets');
        const current = ticketMap.get(ticket.ticketId);
        if (current) {
          const merged = [...new Set([...(current.tags || []), ...cr.tags])];
          ticketMap.set(ticket.ticketId, { ...current, tags: merged, lastModified: Date.now() });
        }
      } catch {}
    }

    // Increment usage
    await incrementUsage(ydoc, crId, cr.scope);
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => renderResults(searchInput.value.trim()), 100);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelected(Math.min(selectedIndex + 1, currentCRs.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelected(Math.max(selectedIndex - 1, 0));
    } else if (e.key === 'Enter' && selectedIndex >= 0 && currentCRs[selectedIndex]) {
      insertCR(currentCRs[selectedIndex].id);
    }
  });

  manageLink.addEventListener('click', () => {
    modal.open();
  });

  // Initial render on first open
  renderResults('');
  setTimeout(() => searchInput.focus(), 50);

  return container;
}

// ─── initCannedResponses ──────────────────────────────────────────────────────

/**
 * Register compose view handler for the canned responses button.
 *
 * @param {object} sdk          - InboxSDK instance
 * @param {import('yjs').Doc} ydoc
 * @param {string} agentEmail
 */
export function initCannedResponses(sdk, ydoc, agentEmail) {
  const tickets = ydoc.getMap('tickets');
  // Build management modal once (lazily on first use)
  let modalInstance = null;
  function getModal() {
    if (!modalInstance) {
      modalInstance = buildManagementModal(ydoc, agentEmail);
    }
    return modalInstance;
  }

  sdk.Compose.registerComposeViewHandler((composeView) => {
    composeView.addButton({
      title: 'Canned Responses',
      iconUrl: ICON_CANNED,
      type: 'MODIFIER',
      hasDropdown: true,
      onClick: (event) => {
        if (event.dropdown) {
          const dropdownEl = buildDropdownEl(
            ydoc, agentEmail, composeView, tickets, getModal()
          );
          event.dropdown.el.appendChild(dropdownEl);
        }
      },
    });
  });

  console.log('[Supp] Canned responses initialized');
}
