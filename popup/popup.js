// Supp v2 - Popup Script
// Shows extension status and statistics

const statusEl = document.getElementById('status');
const statsEl = document.getElementById('stats');
const ticketCountEl = document.getElementById('ticket-count');
const agentCountEl = document.getElementById('agent-count');
const leaderStatusEl = document.getElementById('leader-status');
const versionEl = document.getElementById('version');

// Set version from manifest
const manifest = chrome.runtime.getManifest();
versionEl.textContent = manifest.version;

/**
 * Query content script for current state
 */
async function updateStatus() {
  try {
    // Find Gmail tabs
    const tabs = await chrome.tabs.query({ url: 'https://mail.google.com/*' });

    if (tabs.length === 0) {
      // No Gmail tab open
      statusEl.className = 'status error';
      statusEl.textContent = 'No Gmail tab open';
      statsEl.style.display = 'none';
      return;
    }

    // Query the first Gmail tab for state
    const response = await chrome.tabs.sendMessage(tabs[0].id, {
      type: 'GET_STATE'
    });

    // Update UI with state
    statusEl.className = 'status connected';
    statusEl.textContent = 'Connected';
    statsEl.style.display = 'block';

    ticketCountEl.textContent = response.ticketCount || 0;
    agentCountEl.textContent = response.agentCount || 0;
    leaderStatusEl.textContent = response.isLeader ? 'Yes' : 'No';

  } catch (error) {
    console.error('[Supp Popup] Failed to get state:', error);
    statusEl.className = 'status error';
    // "Receiving end does not exist" means the content script hasn't finished
    // loading yet, or the Gmail tab hasn't been opened — show a friendlier message.
    const isNotReady = error.message?.includes('Receiving end does not exist');
    statusEl.textContent = isNotReady ? 'Loading… (open Gmail to activate)' : 'Error: ' + error.message;
    statsEl.style.display = 'none';
  }
}

// Update status on popup open
updateStatus();

// Refresh every 2 seconds while popup is open
setInterval(updateStatus, 2000);
