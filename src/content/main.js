// Supp v2 - Content Script Entry Point
// Boot sequence for the entire content script

import { nanoid } from 'nanoid';
import InboxSDK from '@inboxsdk/core';
import { ydoc, tickets, config, awareness, replyQueue, cannedResponses, tokenExchange, auditLog } from './yjs/doc.js';
import { initPersistence, onSnapshotApplied } from './yjs/persistence.js';
import { installDebugBridge } from './debug-bridge.js';
import { FirebaseSignaling } from './sync/firebase-signaling.js';
import { WebRTCPeerManager } from './sync/webrtc-peer-manager.js';
import { FirebaseYjsSync } from './sync/firebase-yjs-sync.js';
import { LeaderElection } from './leader/election.js';
import { tokenManager } from './tokens/token-manager.js';
import { TokenExchangeObserver } from './tokens/token-exchange-observer.js';
import { TokenDistributor } from './tokens/token-distributor.js';
import { GmailAPI } from './gmail/api.js';
import { EmailMonitor } from './gmail/monitor.js';
import { ShadowEmailService } from './gmail/shadow.js';
import { initReplyInterceptor } from './gmail/reply-interceptor.js';
import { initSidePanel, openSidePanelForTest } from './ui/side-panel.js';
import { initFilteredViews, getFilteredTickets } from './ui/filtered-views.js';
import { initThreadLabels } from './ui/thread-labels.js';
import { initComposeButtons } from './ui/compose-buttons.js';
import { initCannedResponses } from './ui/canned-responses.js';
import { ReplyDispatcher } from './gmail/reply-dispatcher.js';
import { joinTeam } from './onboarding/agent-join.js';
import { initializeTeam, sendInvitations } from './onboarding/team-setup.js';
import { scanForInviteEmail } from './onboarding/invite-scanner.js';
import { launchOAuthPkce } from './crypto/pkce.js';
import { setupFirebase } from './onboarding/firebase-auto-setup.js';

console.log('[Supp] Content script starting...');

export const suppContext = {
  sdk: null,
  ydoc,
  tickets,
  config,
  awareness,
  replyQueue,
  cannedResponses,
  tokenExchange,
  auditLog,
  provider: null,
  signaling: null,
  peerManager: null,
  leaderElection: null,
  tokenExchangeObserver: null,
  tokenDistributor: null,
  emailMonitor: null,
  shadowService: null,
  replyDispatcher: null,
  firebaseYjsSync: null,
  isLeader: false,
  agentEmail: null,
  peerId: null,
};

// ─── P2P sync ─────────────────────────────────────────────────────────────────

async function initP2PSync(teamConfig) {
  if (!teamConfig?.firebaseConfig || !teamConfig?.yjsRoomId) {
    console.log('[Supp] Firebase not configured — running in single-user mode');
    return;
  }
  try {
    suppContext.signaling = new FirebaseSignaling(
      teamConfig.firebaseConfig,
      teamConfig.yjsRoomId,
      suppContext.peerId
    );

    // Start FirebaseYjsSync immediately — it only needs signaling.db (set in constructor).
    // This runs regardless of whether signaling.join() succeeds, so Yjs sync works
    // even when WebRTC signaling times out (CGNAT, offline, etc.).
    suppContext.peerManager = new WebRTCPeerManager(ydoc, suppContext.signaling);
    suppContext.firebaseYjsSync = new FirebaseYjsSync(
      ydoc,
      awareness,
      suppContext.signaling.db,
      teamConfig.yjsRoomId,
      suppContext.peerId,
      suppContext.peerManager.channels
    );
    suppContext.firebaseYjsSync.start();

    // WebRTC signaling join — best-effort, wrapped in a timeout.
    // Firebase RTDB write operations can hang indefinitely when the database is
    // unreachable (CGNAT, offline). If join() doesn't complete within 10s,
    // boot continues with Firebase Yjs sync still active.
    try {
      await Promise.race([
        suppContext.signaling.join(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Firebase join timed out after 10s')), 10000)
        ),
      ]);
      await suppContext.peerManager.connectToExistingPeers();
      console.log(`[Supp] P2P sync initiated — ${suppContext.peerManager.peers.size} peer(s)`);
    } catch (signalingErr) {
      console.warn('[Supp] WebRTC signaling failed (Firebase Yjs sync still active):', signalingErr);
      console.log('[Supp] P2P sync initiated — 0 peer(s) (Firebase fallback active)');
    }
  } catch (err) {
    console.error('[Supp] P2P sync failed:', err);
  }
}

// ─── Leader election ──────────────────────────────────────────────────────────

async function initLeaderElection(teamConfig, agentEmail) {
  const election = new LeaderElection(awareness, suppContext.peerId, agentEmail, teamConfig);
  const distributor = new TokenDistributor(teamConfig);
  suppContext.tokenDistributor = distributor;

  election.setTokenManager(tokenManager);
  // Re-announce presence after any BroadcastChannel STATE_SNAPSHOT is applied,
  // because the snapshot may contain an older stop() entry (lastSeen:0) with a
  // higher Lamport clock that overwrites our fresh announcePresence() write.
  onSnapshotApplied(() => election.announcePresence());
  election.setOnBecomeLeader(async () => {
    suppContext.isLeader = true;
    distributor.startPolling();

    // Start inbox monitoring
    const sharedInboxEmail = teamConfig.sharedInboxEmail || teamConfig.mainAccount?.email;
    if (sharedInboxEmail) {
      const sharedApi = new GmailAPI((force = false) => {
        if (force) tokenManager.clearAccessTokenCache(sharedInboxEmail);
        return tokenManager.getAccessToken(sharedInboxEmail);
      });
      const shadowService = new ShadowEmailService(ydoc, teamConfig, tokenManager);
      suppContext.shadowService = shadowService;
      distributor.setShadowService(shadowService);

      const monitor = new EmailMonitor(
        sharedApi,
        ydoc,
        (threadId) => shadowService.createTicketFromThread(threadId),
        (threadId, ticket) => shadowService.insertFollowUpShadow(threadId, ticket),
      );
      suppContext.emailMonitor = monitor;
      await monitor.start();
      console.log('[Supp] Inbox monitoring started');

      // Start reply dispatcher (leader only)
      const dispatcher = new ReplyDispatcher(ydoc, sharedApi, shadowService, teamConfig);
      suppContext.replyDispatcher = dispatcher;
      dispatcher.start();
    }
  });
  election.setOnStepDown(() => {
    suppContext.isLeader = false;
    distributor.stopPolling();

    if (suppContext.emailMonitor) {
      suppContext.emailMonitor.stop();
      suppContext.emailMonitor = null;
    }
    if (suppContext.replyDispatcher) {
      suppContext.replyDispatcher.stop();
      suppContext.replyDispatcher = null;
    }
    suppContext.shadowService = null;
    console.log('[Supp] Inbox monitoring stopped');
  });

  // Update tokenVersions in presence on election start
  const storedEmails = await tokenManager.listStoredEmails();
  election.setKnownTokenEmails(storedEmails);

  // When a new agent appears in awareness with missing shadows, catch them up (leader only)
  awareness.on('change', () => {
    if (!suppContext.isLeader || !suppContext.shadowService) return;
    for (const state of awareness.getStates().values()) {
      if (!state?.email || state.email === agentEmail) continue;
      const hasAnyShadow = Array.from(tickets.values()).some(
        t => t.shadowThreads?.[state.email]
      );
      if (!hasAnyShadow && tickets.size > 0) {
        suppContext.shadowService.catchUpAgent(state.email).catch(err => {
          console.error('[Supp] Catch-up failed for', state.email, err);
        });
      }
    }
  });

  election.start();
  suppContext.leaderElection = election;
  console.log('[Supp] Leader election initialized');
}

// ─── Token exchange observer ──────────────────────────────────────────────────

async function initTokenExchangeObserver(agentEmail) {
  const observer = new TokenExchangeObserver(ydoc, tokenManager, agentEmail);
  observer.start();
  suppContext.tokenExchangeObserver = observer;

  // Push own token to online peers on first connection
  await observer.pushOwnTokenToOnlinePeers();
}

// ─── Onboarding UI ────────────────────────────────────────────────────────────

function createOverlay() {
  const overlay = document.createElement('div');
  overlay.setAttribute('data-supp-onboarding', '');
  Object.assign(overlay.style, {
    position: 'fixed', top: '0', left: '0', width: '100%', height: '100%',
    background: 'rgba(0,0,0,0.55)', zIndex: '999999',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontFamily: 'Google Sans, Roboto, sans-serif'
  });
  const card = document.createElement('div');
  Object.assign(card.style, {
    background: '#fff', borderRadius: '12px', padding: '36px 40px',
    maxWidth: '520px', width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
    boxSizing: 'border-box'
  });
  overlay.appendChild(card);
  document.body.appendChild(overlay);
  return { overlay, card };
}

async function runOnboardingUI(scanResult) {
  const { overlay, card } = createOverlay();

  return new Promise((resolve) => {
    function setHtml(html) { card.innerHTML = html; }

    function showError(msg) {
      const el = card.querySelector('[data-supp-ob-error]');
      if (el) { el.textContent = msg; el.style.display = 'block'; }
    }

    function showLoading(label) {
      setHtml(`<h2 style="margin:0 0 16px;font-size:20px;color:#1a73e8">Supp</h2>
               <p style="color:#555;margin:0">${label}</p>`);
    }

    function showDone(msg) {
      setHtml(`<h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">✅ Supp</h2>
               <p style="color:#333;margin:0 0 20px">${msg}</p>
               <button data-supp-ob-done style="padding:10px 24px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px">Continue</button>`);
      card.querySelector('[data-supp-ob-done]').addEventListener('click', () => {
        overlay.remove(); resolve();
      });
    }

    // ── Join flow (invite found) ──────────────────────────────────────────────
    if (scanResult.status === 'invite_found') {
      const payload = scanResult.invitePayload;
      setHtml(`
        <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Join Team</h2>
        <p style="color:#555;margin:0 0 20px;font-size:14px">
          You've been invited to join the Supp team for
          <strong>${payload.sharedInboxEmail || 'your team'}</strong>.
        </p>
        <button data-supp-ob-join style="display:block;width:100%;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:10px">
          Join Team
        </button>
        <button data-supp-ob-decline style="display:block;width:100%;padding:12px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">
          Not now
        </button>
        <div data-supp-ob-error style="display:none;color:#d93025;font-size:13px;margin-top:8px"></div>
      `);

      card.querySelector('[data-supp-ob-join]').addEventListener('click', async () => {
        showLoading('Joining team…');
        try {
          await joinTeam(payload, (msg) => showLoading(msg));
          showDone('You\'ve joined the team! Supp is now active.');
        } catch (err) {
          setHtml(`
            <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Join Team</h2>
            <p style="color:#555;margin:0 0 20px;font-size:14px">You've been invited to join the Supp team for <strong>${payload.sharedInboxEmail || 'your team'}</strong>.</p>
            <button data-supp-ob-join style="display:block;width:100%;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:10px">Join Team</button>
            <button data-supp-ob-decline style="display:block;width:100%;padding:12px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">Not now</button>
            <div data-supp-ob-error style="color:#d93025;font-size:13px;margin-top:8px">${err.message}</div>
          `);
          card.querySelector('[data-supp-ob-join]').addEventListener('click', () => location.reload());
          card.querySelector('[data-supp-ob-decline]').addEventListener('click', () => { overlay.remove(); resolve(); });
        }
      });
      card.querySelector('[data-supp-ob-decline]').addEventListener('click', () => { overlay.remove(); resolve(); });
      return;
    }

    // ── No team / no invite — show setup or join options ─────────────────────
    function showWelcome() {
      setHtml(`
        <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Welcome to Supp</h2>
        <p style="color:#555;margin:0 0 20px;font-size:14px">
          No team was found. Set up a new team, check your inbox for an invitation, or paste an invitation code.
        </p>
        <button data-supp-ob-setup style="display:block;width:100%;padding:12px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:10px">
          Set Up New Team
        </button>
        <button data-supp-ob-scan style="display:block;width:100%;padding:12px;background:#e8f0fe;color:#1a73e8;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-bottom:10px">
          Check for Team Invitation
        </button>
        <button data-supp-ob-paste style="display:block;width:100%;padding:12px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">
          Join with Invitation Code
        </button>
      `);
      card.querySelector('[data-supp-ob-setup]').addEventListener('click', showOwnerSetup);
      card.querySelector('[data-supp-ob-paste]').addEventListener('click', showPasteInvite);
      card.querySelector('[data-supp-ob-scan]').addEventListener('click', async () => {
        showLoading('Signing in to check for invitations…');
        try {
          // Full PKCE flow — same as team setup, works with Web application client
          const auth = await launchOAuthPkce();
          const accessToken = auth.accessToken;
          const agentEmail = auth.email;
          if (!agentEmail) throw new Error('Could not determine your Gmail address');

          showLoading('Scanning inbox for invitations…');
          const result = await scanForInviteEmail(accessToken, agentEmail);
          if (result.status === 'invite_found') {
            // Re-enter the onboarding UI with the found invite.
            // IMPORTANT: resolve() must come AFTER the nested UI completes,
            // otherwise handleOnboarding re-reads storage before joinTeam stores teamConfig.
            overlay.remove();
            await runOnboardingUI(result);
            resolve();
          } else {
            showWelcome();
            const errEl = document.createElement('p');
            errEl.style.cssText = 'color:#888;font-size:13px;margin-top:12px;text-align:center';
            errEl.textContent = 'No invitation found. Ask your team owner to resend the invite.';
            card.appendChild(errEl);
          }
        } catch (err) {
          showWelcome();
          const errEl = document.createElement('p');
          errEl.style.cssText = 'color:#d93025;font-size:13px;margin-top:12px;text-align:center';
          errEl.textContent = err.message;
          card.appendChild(errEl);
        }
      });
    }

    // ── Manual invite paste ───────────────────────────────────────────────────
    function showPasteInvite() {
      setHtml(`
        <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Join with Invitation Code</h2>
        <p style="color:#555;margin:0 0 8px;font-size:13px">Paste the invite payload from your invitation email:</p>
        <textarea data-supp-ob-payload rows="5"
          style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:6px;font-size:12px;font-family:monospace;resize:vertical;margin-bottom:12px"
          placeholder='{"teamId":"...","sharedInboxEmail":"...",...}'></textarea>
        <button data-supp-ob-join-paste style="padding:10px 24px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-right:8px">Join</button>
        <button data-supp-ob-back style="padding:10px 24px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">Back</button>
        <div data-supp-ob-error style="display:none;color:#d93025;font-size:13px;margin-top:8px"></div>
      `);
      card.querySelector('[data-supp-ob-back]').addEventListener('click', showWelcome);
      card.querySelector('[data-supp-ob-join-paste]').addEventListener('click', async () => {
        const raw = card.querySelector('[data-supp-ob-payload]').value.trim();
        let payload;
        try { payload = JSON.parse(raw); } catch { showError('Invalid JSON — paste the full invite payload'); return; }
        showLoading('Joining team…');
        try {
          await joinTeam(payload, (msg) => showLoading(msg));
          showDone('You\'ve joined the team!');
        } catch (err) {
          showPasteInvite();
          showError(err.message);
        }
      });
    }

    // ── Owner setup: step 1 ───────────────────────────────────────────────────
    function showOwnerSetup() {
      setHtml(`
        <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Set Up New Team</h2>
        <p style="color:#555;margin:0 0 8px;font-size:13px">Shared inbox email (e.g. support@yourcompany.com):</p>
        <input data-supp-ob-inbox type="email" placeholder="support@yourcompany.com"
          style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:6px;font-size:14px;margin-bottom:16px">
        <p style="color:#555;margin:0 0 8px;font-size:13px">Agent emails to invite (one per line):</p>
        <textarea data-supp-ob-agents rows="3"
          style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:6px;font-size:13px;font-family:monospace;resize:vertical;margin-bottom:12px"
          placeholder="agent1@yourcompany.com&#10;agent2@yourcompany.com"></textarea>
        <button data-supp-ob-next style="padding:10px 24px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-right:8px">Continue</button>
        <button data-supp-ob-back style="padding:10px 24px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">Back</button>
        <div data-supp-ob-error style="display:none;color:#d93025;font-size:13px;margin-top:8px"></div>
      `);
      card.querySelector('[data-supp-ob-back]').addEventListener('click', showWelcome);
      card.querySelector('[data-supp-ob-next]').addEventListener('click', () => {
        const inbox = card.querySelector('[data-supp-ob-inbox]').value.trim();
        if (!inbox) { showError('Please enter the shared inbox email'); return; }
        const agentText = card.querySelector('[data-supp-ob-agents]').value.trim();
        const agents = agentText ? agentText.split(/[\n,]+/).map(e => e.trim()).filter(Boolean) : [];
        showFirebaseSetup(inbox, agents);
      });
    }

    // ── Owner setup: Firebase step ────────────────────────────────────────────
    function showFirebaseSetup(sharedInboxEmail, agentEmails) {
      setHtml(`
        <h2 style="margin:0 0 12px;font-size:20px;color:#1a73e8">Firebase Setup</h2>
        <p style="color:#555;margin:0 0 4px;font-size:13px">Paste your Firebase service account JSON for real-time sync:</p>
        <p style="color:#888;font-size:11px;margin:0 0 8px">
          Firebase Console → ⚙️ Project settings → Service accounts → Generate new private key
        </p>
        <textarea data-supp-ob-sa rows="5"
          style="width:100%;box-sizing:border-box;padding:10px;border:1px solid #dadce0;border-radius:6px;font-size:11px;font-family:monospace;resize:vertical;margin-bottom:12px"
          placeholder='{"type":"service_account","project_id":"...",...}'></textarea>
        <button data-supp-ob-create style="padding:10px 24px;background:#1a73e8;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;margin-right:8px">Create Team</button>
        <button data-supp-ob-skip style="padding:10px 24px;background:#f1f3f4;color:#333;border:none;border-radius:6px;cursor:pointer;font-size:14px">Skip Firebase</button>
        <div data-supp-ob-error style="display:none;color:#d93025;font-size:13px;margin-top:8px"></div>
      `);

      async function runSetup(serviceAccountJson) {
        showLoading('Starting setup — you\'ll be asked to sign in twice (your account, then the shared inbox)…');
        try {
          const { teamConfig, needsManualRules, needsManualApiKey } = await initializeTeam({
            sharedInboxEmail,
            serviceAccountJson,
            agentEmails,
            onProgress: (msg) => showLoading(msg)
          });

          let detail = `Team created for <strong>${sharedInboxEmail}</strong>`;
          if (agentEmails.length) detail += `<br>Invitations sent to ${agentEmails.length} agent(s)`;
          if (needsManualRules) detail += '<br>⚠️ Set Firebase rules manually (regional database)';
          if (needsManualApiKey) detail += '<br>⚠️ Firebase API key missing — check Firebase Console';

          showDone(detail);
        } catch (err) {
          showFirebaseSetup(sharedInboxEmail, agentEmails);
          showError(err.message);
        }
      }

      card.querySelector('[data-supp-ob-create]').addEventListener('click', () => {
        const sa = card.querySelector('[data-supp-ob-sa]').value.trim();
        if (!sa) { showError('Please paste the service account JSON'); return; }
        runSetup(sa);
      });
      card.querySelector('[data-supp-ob-skip]').addEventListener('click', () => runSetup(null));
    }

    showWelcome();
  });
}

// ─── Onboarding gate ──────────────────────────────────────────────────────────

/**
 * Check if onboarding is needed. If so, scan for invite then show UI.
 * Returns the teamConfig if ready to boot normally, or null if onboarding
 * is still pending (user dismissed without completing).
 */
async function handleOnboarding() {
  const storage = await chrome.storage.local.get(['teamConfig', 'myEmail']);

  if (storage.teamConfig) {
    return storage.teamConfig;
  }

  console.log('[Supp] No team config — checking for invite…');

  // Try to get an access token to scan the inbox. If OAuth not yet done, scanForInviteEmail
  // will fail gracefully and we show the welcome UI.
  let scanResult = { status: 'no_invite' };
  try {
    const accessToken = await tokenManager.getAccessToken(storage.myEmail).catch(() => null);
    if (accessToken && storage.myEmail) {
      scanResult = await scanForInviteEmail(accessToken, storage.myEmail);
    }
  } catch {
    // No token yet — show welcome UI
  }

  await runOnboardingUI(scanResult);

  // Re-read after onboarding completes
  const updated = await chrome.storage.local.get(['teamConfig']);
  return updated.teamConfig || null;
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  try {
    // Step 0: Init TokenManager (derives storage key)
    await tokenManager.init();

    // Step 1: Check onboarding / team config
    console.log('[Supp] Step 0: Checking onboarding state...');
    const teamConfig = await handleOnboarding();

    console.log('[Supp] Step 1: Initializing persistence...');
    suppContext.provider = await initPersistence();

    console.log('[Supp] Step 2: Loading InboxSDK...');
    if (typeof __SKIP_INBOXSDK__ === 'undefined' || !__SKIP_INBOXSDK__) {
      suppContext.sdk = await InboxSDK.load(2, 'sdk_testo_c0b333c1f2');
      initReplyInterceptor(suppContext.sdk, ydoc);
      initSidePanel(suppContext.sdk, ydoc);
    } else {
      console.log('[Supp] InboxSDK skipped (test build)');
      suppContext.openSidePanel = (ticketId) => openSidePanelForTest(ticketId, ydoc);
    }

    // Stable peer ID
    const peerStorage = await chrome.storage.local.get(['peerId', 'myEmail']);
    if (!peerStorage.peerId) {
      suppContext.peerId = nanoid();
      await chrome.storage.local.set({ peerId: suppContext.peerId });
    } else {
      suppContext.peerId = peerStorage.peerId;
    }
    suppContext.agentEmail = peerStorage.myEmail || null;

    // Always register the popup state listener, even in single-user mode
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.type === 'GET_STATE') {
        sendResponse({ ticketCount: tickets.size, agentCount: awareness.getStates().size, isLeader: suppContext.isLeader });
      }
    });

    if (!teamConfig) {
      console.log('[Supp] No team config after onboarding — running in single-user mode');
      installDebugBridge(suppContext);
      return;
    }

    console.log('[Supp] Step 3: Initializing P2P sync...');
    await initP2PSync(teamConfig);

    console.log('[Supp] Step 4: Initializing leader election...');
    if (suppContext.agentEmail) {
      await initLeaderElection(teamConfig, suppContext.agentEmail);
    }

    console.log('[Supp] Step 5: Initializing token exchange observer...');
    if (suppContext.agentEmail) {
      await initTokenExchangeObserver(suppContext.agentEmail);
    }

    // Step 6: Filtered views + thread labels + compose UI (InboxSDK build only)
    if (suppContext.sdk && suppContext.agentEmail) {
      initFilteredViews(suppContext.sdk, ydoc, suppContext.agentEmail);
      initThreadLabels(suppContext.sdk, ydoc, suppContext.agentEmail);
      initComposeButtons(suppContext.sdk, ydoc);
      initCannedResponses(suppContext.sdk, ydoc, suppContext.agentEmail);
    }

    // Expose getFilteredTickets via suppContext for debug bridge
    suppContext.getFilteredTickets = (routeID) =>
      getFilteredTickets(ydoc, routeID, suppContext.agentEmail);

    console.log('[Supp] Boot complete', {
      ticketCount: tickets.size,
      agentCount: awareness.getStates().size,
      isLeader: suppContext.isLeader
    });

    installDebugBridge(suppContext);

  } catch (error) {
    console.error('[Supp] Boot sequence failed:', error);
  }
}

boot();

window.addEventListener('beforeunload', () => {
  suppContext.firebaseYjsSync?.stop();
  suppContext.peerManager?.destroy();
  suppContext.signaling?.leave();
  suppContext.tokenExchangeObserver?.stop();
  suppContext.leaderElection?.stop();
  suppContext.tokenDistributor?.stopPolling();
});
