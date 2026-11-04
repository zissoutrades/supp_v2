// Supp v2 - IndexedDB Persistence
// Persists Yjs document to IndexedDB.
// y-indexeddb v9 does NOT include BroadcastChannel sync, so we add it manually:
// all Yjs updates are forwarded to other same-browser tabs via BroadcastChannel,
// and on init we request a full state snapshot from any already-open tab.

import * as Y from 'yjs';
import { IndexeddbPersistence } from 'y-indexeddb';
import { ydoc } from './doc.js';
import { YJS_DB_NAME } from '../../common/constants.js';

/**
 * IndexedDB persistence provider instance
 * Created once during extension boot
 */
let provider = null;

/**
 * Set up BroadcastChannel-based cross-tab Yjs sync.
 * Must be called after IndexeddbPersistence has loaded (i.e. after 'synced' fires)
 * so that our state snapshot is complete before we respond to REQUEST_STATE.
 */
function initBroadcastSync() {
  const bc = new BroadcastChannel(YJS_DB_NAME);

  bc.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'UPDATE') {
      // Incremental update from another tab — apply with 'broadcast' origin
      // to prevent echoing it back
      Y.applyUpdate(ydoc, new Uint8Array(msg.data), 'broadcast');
    } else if (msg.type === 'REQUEST_STATE') {
      // A newly-opened tab wants our full state
      bc.postMessage({
        type: 'STATE_SNAPSHOT',
        data: Array.from(Y.encodeStateAsUpdate(ydoc)),
      });
    } else if (msg.type === 'STATE_SNAPSHOT') {
      // Full state from another tab — merge into our doc
      Y.applyUpdate(ydoc, new Uint8Array(msg.data), 'broadcast');
      // Notify leader election so it can re-announce presence if its entry was overwritten
      _onSnapshotApplied?.();
    }
  };

  // Forward all local Yjs updates to other tabs, except those we received
  // from the broadcast channel itself (origin === 'broadcast').
  ydoc.on('update', (update, origin) => {
    if (origin !== 'broadcast') {
      bc.postMessage({ type: 'UPDATE', data: Array.from(update) });
    }
  });

  // Ask any already-open tabs for their current state so we bootstrap
  // any updates that happened after our IDB snapshot was written.
  bc.postMessage({ type: 'REQUEST_STATE' });
}

/** Optional callback invoked after any STATE_SNAPSHOT is applied from BroadcastChannel. */
let _onSnapshotApplied = null;

/**
 * Register a callback to be called after a BroadcastChannel STATE_SNAPSHOT is applied.
 * Used by the leader election to re-announce its presence if a snapshot overwrote its entry.
 */
export function onSnapshotApplied(fn) {
  _onSnapshotApplied = fn;
}

/**
 * Initialize IndexedDB persistence for the Yjs document, then start
 * BroadcastChannel sync so all same-browser tabs stay in lock-step.
 *
 * @returns {Promise<IndexeddbPersistence>} Resolves when local data is loaded
 */
export function initPersistence() {
  return new Promise((resolve, reject) => {
    console.log('[Supp Persistence] Initializing IndexedDB persistence...');

    try {
      provider = new IndexeddbPersistence(YJS_DB_NAME, ydoc);

      // Wait for initial sync to complete (local data loaded into Yjs doc)
      provider.on('synced', () => {
        console.log('[Supp] Local data loaded from IndexedDB');
        console.log('[Supp Persistence] Current state:', {
          tickets: ydoc.getMap('tickets').size,
          config: ydoc.getMap('config').size,
          awareness: 'ephemeral (not stored in IDB)',
          cannedResponses: ydoc.getMap('cannedResponses').size,
          replyQueue: ydoc.getArray('replyQueue').length
        });

        // Start cross-tab sync AFTER IDB is loaded so our state is complete
        // before we respond to any REQUEST_STATE from other tabs.
        initBroadcastSync();

        resolve(provider);
      });

      // Handle persistence errors
      provider.on('error', (error) => {
        console.error('[Supp Persistence] IndexedDB error:', error);
      });

    } catch (error) {
      console.error('[Supp Persistence] Failed to initialize:', error);
      reject(error);
    }
  });
}

/**
 * Get the persistence provider instance
 * @returns {IndexeddbPersistence|null}
 */
export function getProvider() {
  return provider;
}

/**
 * Check if persistence is synced
 * @returns {boolean}
 */
export function isSynced() {
  return provider?.synced ?? false;
}
