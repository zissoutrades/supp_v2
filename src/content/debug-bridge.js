// Supp v2 - Debug Bridge
// Exposes Yjs internals to window.__suppDebug for Playwright tests and manual testing.
// ONLY installed in test builds (process.env.NODE_ENV === 'test').
// Tree-shaken from production builds.
//
// Architecture: content script (isolated world) listens for window.postMessage
// requests from the MAIN world and replies via window.postMessage.
// No script injection needed — both worlds share window.postMessage.
// Playwright uses page.addInitScript() to define window.__suppDebug before Gmail loads.
// Manual testing: paste the snippet from TESTING-P2P.md "Console Setup" step once.

import {
  getPersonalResponses,
  savePersonalResponse,
  substituteVariables as _substituteVariables,
} from './ui/canned-responses.js';

const MSG_REQ  = '__supp_debug_req';
const MSG_RES  = '__supp_debug_res';

function isolatedWaitForSync(provider, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    if (provider && provider.synced) { resolve(); return; }
    const timeout = setTimeout(() => reject(new Error('Sync timeout')), timeoutMs);
    if (provider) {
      provider.once('synced', () => { clearTimeout(timeout); resolve(); });
    } else {
      clearTimeout(timeout);
      reject(new Error('No provider available'));
    }
  });
}

/**
 * Install the debug bridge.
 *
 * Accepts suppContext by reference so that fields populated in later sub-phases
 * (leaderElection, agentEmail) are always read live, not captured at call time.
 *
 * @param {object} suppContext - the global context object from main.js
 */
export function installDebugBridge(suppContext) {
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'test') {
    return;
  }

  const { ydoc } = suppContext;

  console.log('[Supp Debug] Installing debug bridge...');

  // ── postMessage relay (serves MAIN world: Playwright + DevTools console) ──
  window.addEventListener('message', async (e) => {
    if (!e.data || e.data.type !== MSG_REQ || e.source !== window) return;
    const { id, method, args = [] } = e.data;
    let result, error;
    try {
      switch (method) {
        case 'getTickets':         result = Array.from(ydoc.getMap('tickets').entries()); break;
        case 'getPresence':
          result = [...suppContext.awareness.getStates().values()]
            .filter(s => s?.agentId)
            .map(s => [s.agentId, s]);
          break;
        case 'getReplyQueue':      result = ydoc.getArray('replyQueue').toArray(); break;
        case 'getCannedResponses': result = Array.from(ydoc.getMap('cannedResponses').entries()); break;
        case 'getYjsSyncState':    result = suppContext.provider?.synced ? 'synced' : 'pending'; break;
        case 'isLeader':           result = suppContext.leaderElection ? suppContext.leaderElection.isLeader : false; break;
        case 'getAgentEmail':      result = suppContext.agentEmail; break;
        case 'setMapEntry':        ydoc.getMap(args[0]).set(args[1], args[2]); result = null; break;
        case 'getMapEntry':        result = ydoc.getMap(args[0]).get(args[1]); break;
        case 'pushArrayEntry':     ydoc.getArray(args[0]).push([args[1]]); result = null; break;
        case 'openSidePanel':
          if (suppContext.openSidePanel) { suppContext.openSidePanel(args[0]); result = null; }
          else { error = 'openSidePanel not available (InboxSDK build)'; }
          break;
        case 'waitForSync':        await isolatedWaitForSync(suppContext.provider, args[0]); result = null; break;
        case 'disconnectWebRTC':      suppContext.peerManager?.destroy(); result = null; break;
        case 'reconnectWebRTC':       await suppContext.peerManager?.connectToExistingPeers(); result = null; break;
        case 'disconnectWebRTCKeepFirebase':
          if (suppContext.peerManager) {
            for (const channel of suppContext.peerManager.channels.values()) { try { channel.close(); } catch(e) {} }
            suppContext.peerManager.channels.clear();
          }
          result = null; break;
        case 'getFirebaseYjsSyncState':
          result = {
            running: !!suppContext.firebaseYjsSync,
            knownPeers: suppContext.firebaseYjsSync ? [...suppContext.firebaseYjsSync._knownPeerOutboxes] : [],
          }; break;
        case 'getYjsDoc':          result = null; break;  // Y.Doc can't serialize; use setMapEntry/getMapEntry instead
        case 'injectAwareness': {
          // For tests: inject a fake peer awareness state without Firebase/WebRTC
          // args[0] = fakeClientId (number), args[1] = state object
          const fakeClientId = args[0];
          suppContext.awareness.states.set(fakeClientId, args[1]);
          suppContext.awareness.meta.set(fakeClientId, { clock: 1, lastUpdated: Date.now() });
          suppContext.awareness.emit('change', [{ added: [fakeClientId], updated: [], removed: [] }, 'test']);
          result = null;
          break;
        }
        case 'getFilteredView':
          result = suppContext.getFilteredTickets
            ? suppContext.getFilteredTickets(args[0])
            : []; break;
        case 'simulateLeaderCrash':   suppContext.leaderElection?.stop(); result = null; break;
        case 'triggerPoll':
          if (!suppContext.emailMonitor) { error = 'No emailMonitor — not leader or monitoring not started'; break; }
          await suppContext.emailMonitor.checkForNewMessages(); result = null; break;
        case 'getPersonalCannedResponses':
          result = await getPersonalResponses();
          break;
        case 'savePersonalCannedResponse':
          await savePersonalResponse(args[0]);
          result = null;
          break;
        case 'substituteVariables': {
          const ticketMap = ydoc.getMap('tickets');
          const ticket = args[1] ? ticketMap.get(args[1]) : null;
          result = _substituteVariables(args[0], ticket, args[2] || '');
          break;
        }
        default: error = `Unknown debug method: ${method}`;
      }
    } catch (err) {
      error = err.message;
    }
    window.postMessage({ type: MSG_RES, id, result, error }, '*');
  });

  // ── Isolated-world window.__suppDebug (direct Yjs access, no serialisation) ──
  window.__suppDebug = {
    getTickets()         { return Array.from(ydoc.getMap('tickets').entries()); },
    getPresence() {
      return [...suppContext.awareness.getStates().values()]
        .filter(s => s?.agentId)
        .map(s => [s.agentId, s]);
    },
    getReplyQueue()      { return ydoc.getArray('replyQueue').toArray(); },
    getCannedResponses() { return Array.from(ydoc.getMap('cannedResponses').entries()); },
    getYjsSyncState()    { return suppContext.provider?.synced ? 'synced' : 'pending'; },
    waitForSync(ms)      { return isolatedWaitForSync(suppContext.provider, ms); },
    isLeader()           { return suppContext.leaderElection ? suppContext.leaderElection.isLeader : false; },
    getAgentEmail()      { return suppContext.agentEmail; },
    getYjsDoc()          { return ydoc; },
    disconnectWebRTC() {
      if (suppContext.peerManager) { console.log('[Supp Debug] Disconnecting WebRTC'); suppContext.peerManager.destroy(); }
      else console.warn('[Supp Debug] No peer manager');
    },
    async reconnectWebRTC() {
      if (suppContext.peerManager) { console.log('[Supp Debug] Reconnecting WebRTC'); await suppContext.peerManager.connectToExistingPeers(); }
      else console.warn('[Supp Debug] No peer manager');
    },
    simulateLeaderCrash() {
      if (suppContext.leaderElection) {
        console.log('[Supp Debug] Simulating leader crash — stopping heartbeats');
        suppContext.leaderElection.stop();
      } else {
        console.warn('[Supp Debug] No leaderElection instance');
      }
    },
    triggerPoll() {
      if (!suppContext.emailMonitor) {
        console.warn('[Supp Debug] triggerPoll: no emailMonitor — not leader or monitoring not started');
        return Promise.resolve();
      }
      console.log('[Supp Debug] Triggering immediate inbox poll');
      return suppContext.emailMonitor.checkForNewMessages();
    },
    openSidePanel(ticketId) {
      if (suppContext.openSidePanel) return suppContext.openSidePanel(ticketId);
      console.warn('[Supp Debug] openSidePanel not available (InboxSDK build)');
    },
    getFirebaseYjsSyncState() {
      return {
        running: !!suppContext.firebaseYjsSync,
        knownPeers: suppContext.firebaseYjsSync ? [...suppContext.firebaseYjsSync._knownPeerOutboxes] : [],
      };
    },
    getFilteredView(routeId) {
      return suppContext.getFilteredTickets
        ? suppContext.getFilteredTickets(routeId)
        : [];
    },
    disconnectWebRTCKeepFirebase() {
      if (suppContext.peerManager) {
        console.log('[Supp Debug] Closing WebRTC channels (keeping Firebase listeners active)');
        for (const channel of suppContext.peerManager.channels.values()) {
          try { channel.close(); } catch (e) {}
        }
        suppContext.peerManager.channels.clear();
      } else {
        console.warn('[Supp Debug] No peer manager');
      }
    },
    getPersonalCannedResponses() { return getPersonalResponses(); },
    savePersonalCannedResponse(cr) { return savePersonalResponse(cr); },
    substituteVariables(body, ticketId, agentName) {
      const ticket = ticketId ? ydoc.getMap('tickets').get(ticketId) : null;
      return _substituteVariables(body, ticket, agentName || '');
    },
    injectAwareness(fakeClientId, state) {
      suppContext.awareness.states.set(fakeClientId, state);
      suppContext.awareness.meta.set(fakeClientId, { clock: 1, lastUpdated: Date.now() });
      suppContext.awareness.emit('change', [{ added: [fakeClientId], updated: [], removed: [] }, 'test']);
    },
    // getLicenseState() — added in sub-phase 10
  };

  console.log('[Supp Debug] Debug bridge installed');
}
