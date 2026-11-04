// Supp v2 — Firebase RTDB as parallel Yjs sync fallback channel.
// When WebRTC data channels are open, this module is idle (no Firebase writes).
// When WebRTC fails (CGNAT, Symmetric NAT), this carries Yjs updates automatically.

import { ref, set, push, onChildAdded, onChildChanged, remove, get } from 'firebase/database';
import * as Y from 'yjs';
import { encodeAwarenessUpdate, applyAwarenessUpdate } from 'y-protocols/awareness';

// Firebase RTDB max write size is 256KB. We chunk at 200KB to stay well under.
const FIREBASE_MAX_WRITE_BYTES = 200_000;

// How long before a Firebase outbox entry is considered stale (own outbox cleanup).
const ENTRY_TTL_MS = 30 * 60_000; // 30 min

// Awareness heartbeats fire every 5s but LEADER_TIMEOUT is 15s.
// Debounce Firebase awareness pushes to once per 12s — well under the timeout,
// but 2.5× fewer writes (and therefore 2.5× fewer reads on the other peer).
const AWARENESS_PUSH_MIN_INTERVAL = 12_000; // ms

// Cleanup own outbox every 30s.
const CLEANUP_INTERVAL_MS = 30_000;

export class FirebaseYjsSync {
  /**
   * @param {Y.Doc}   ydoc
   * @param {import('y-protocols/awareness').Awareness} awareness
   * @param {object}  db        — Firebase database instance (already initialized by FirebaseSignaling)
   * @param {string}  roomId
   * @param {string}  myPeerId
   * @param {Map}     channels  — peerId → RTCDataChannel (live reference from WebRTCPeerManager)
   */
  constructor(ydoc, awareness, db, roomId, myPeerId, channels) {
    this.ydoc = ydoc;
    this.awareness = awareness;
    this.db = db;
    this.roomId = roomId;
    this.myPeerId = myPeerId;
    this.channels = channels;
    this._cleanupFns = [];
    this._cleanupTimer = null;
    this._knownPeerOutboxes = new Set();
    this._pendingChunks = new Map(); // chunkId → { chunks: Uint8Array[], received, total }
    this._lastAwarenessPush = 0;    // timestamp of last Firebase awareness push
  }

  start() {
    console.log(`[FirebaseYjsSync] Starting — roomId=${this.roomId} myPeerId=${this.myPeerId}`);

    // Purge stale entries from ALL peers on startup to prevent the doc from growing
    // large due to accumulated presence heartbeats from previous sessions.
    this._cleanupStaleEntries().catch(() => {});

    // ── Awareness sync via dedicated Firebase path ──────────────────────────────
    // Each peer owns exactly one entry (overwritten via set(), not appended).
    // Awareness is ephemeral — not persisted to IndexedDB, no CRDT tombstones.
    const awarRef = ref(this.db, `rooms/${this.roomId}/awareness`);
    const myAwarRef = ref(this.db, `rooms/${this.roomId}/awareness/${this.myPeerId}`);

    // Push own awareness state when it changes, debounced to AWARENESS_PUSH_MIN_INTERVAL.
    // Every heartbeat (5s) would otherwise trigger a Firebase set() + onChildChanged read
    // on all peers — ~0.1 MB/min in idle sessions.
    const myClientId = this.awareness.clientID;
    const awarenessChangeHandler = ({ added, updated, removed }, origin) => {
      if (origin === 'firebase-awareness') return;
      if (removed.includes(myClientId)) {
        // We're leaving — clean up our Firebase entry immediately (no debounce)
        remove(myAwarRef).catch(() => {});
        this._lastAwarenessPush = 0;
        return;
      }
      if (![...added, ...updated].includes(myClientId)) return;
      const now = Date.now();
      if (now - this._lastAwarenessPush < AWARENESS_PUSH_MIN_INTERVAL) return;
      this._lastAwarenessPush = now;
      const update = encodeAwarenessUpdate(this.awareness, [myClientId]);
      set(myAwarRef, { data: Array.from(update), ts: now })
        .catch(e => console.warn('[FirebaseYjsSync] Awareness push failed:', e));
    };
    this.awareness.on('change', awarenessChangeHandler);
    this._cleanupFns.push(() => this.awareness.off('change', awarenessChangeHandler));

    // Receive peers' awareness states (initial load + updates)
    const applyAwarSnap = (snap) => {
      if (snap.key === this.myPeerId) return;
      const val = snap.val();
      if (!val?.data) return;
      try {
        applyAwarenessUpdate(this.awareness, new Uint8Array(val.data), 'firebase-awareness');
      } catch (e) {
        console.warn('[FirebaseYjsSync] Awareness apply failed:', e);
      }
    };
    const unsubAwarAdded   = onChildAdded(awarRef, applyAwarSnap);
    const unsubAwarChanged = onChildChanged(awarRef, applyAwarSnap);
    this._cleanupFns.push(unsubAwarAdded, unsubAwarChanged);

    // Push own current state immediately so peers see us on boot
    if (this.awareness.getLocalState()) {
      const initUpdate = encodeAwarenessUpdate(this.awareness, [myClientId]);
      set(myAwarRef, { data: Array.from(initUpdate), ts: Date.now() }).catch(() => {});
    }

    const syncRef = ref(this.db, `rooms/${this.roomId}/yjsSync`);

    // 1. Listen for Yjs updates from all peers via Firebase.
    //    Two-level listener: detect peer outboxes, then listen for updates within each.
    const unsubPeerDiscovery = onChildAdded(syncRef, (peerSnapshot) => {
      const fromPeerId = peerSnapshot.key;
      if (fromPeerId === this.myPeerId) return; // skip own outbox
      if (this._knownPeerOutboxes.has(fromPeerId)) return; // already listening
      this._knownPeerOutboxes.add(fromPeerId);

      // New peer appeared — push full Yjs state so they can catch up.
      // This mirrors the WebRTC full-state exchange on data-channel open.
      // Guard: skip if our doc is empty (< 50 bytes) — no point sending nothing.
      const fullState = Y.encodeStateAsUpdate(this.ydoc);
      if (fullState.byteLength > 50) {
        const myOutboxRef = ref(this.db, `rooms/${this.roomId}/yjsSync/${this.myPeerId}`);
        this._pushChunked(myOutboxRef, fullState)
          .then(() => console.log(`[FirebaseYjsSync] New peer ${fromPeerId} — pushed full state (${fullState.byteLength} bytes)`))
          .catch(e => console.warn('[FirebaseYjsSync] Full state push failed:', e));
      }

      const peerOutboxRef = ref(this.db, `rooms/${this.roomId}/yjsSync/${fromPeerId}`);
      const unsubUpdates = onChildAdded(peerOutboxRef, (updateSnapshot) => {
        this._receiveEntry(fromPeerId, updateSnapshot);
      });
      this._cleanupFns.push(unsubUpdates);
    });
    this._cleanupFns.push(unsubPeerDiscovery);

    // 2. When local Yjs doc changes, push to Firebase if WebRTC isn't fully connected.
    const updateHandler = (update, origin) => {
      if (origin === 'firebase-sync') return; // don't echo back Firebase-received updates
      if (typeof origin === 'string' && this.channels.has(origin)) return; // came from WebRTC
      this._maybeSendViaFirebase(update, origin);
    };
    this.ydoc.on('update', updateHandler);
    this._cleanupFns.push(() => this.ydoc.off('update', updateHandler));

    // 3. Periodic cleanup of own old entries
    this._cleanupTimer = setInterval(() => this._cleanupOwnEntries(), CLEANUP_INTERVAL_MS);

    console.log('[FirebaseYjsSync] Started — listening for updates on yjsSync/');
  }

  // ── Receive ──────────────────────────────────────────────────────────────────

  _receiveEntry(fromPeerId, updateSnapshot) {
    const entry = updateSnapshot.val();
    if (!entry?.data) return;

    try {
      if (entry.totalChunks && entry.totalChunks > 1) {
        // Chunked update — buffer until all pieces arrive.
        const { chunkId, chunkIndex, totalChunks } = entry;
        if (!this._pendingChunks.has(chunkId)) {
          this._pendingChunks.set(chunkId, {
            chunks: new Array(totalChunks).fill(null),
            received: 0,
            total: totalChunks,
          });
        }
        const group = this._pendingChunks.get(chunkId);
        if (group.chunks[chunkIndex] === null) {
          group.chunks[chunkIndex] = new Uint8Array(entry.data);
          group.received++;
        }
        if (group.received < group.total) return; // still waiting for more chunks

        // All chunks received — reassemble and apply.
        const totalLen = group.chunks.reduce((s, c) => s + c.byteLength, 0);
        const combined = new Uint8Array(totalLen);
        let offset = 0;
        for (const chunk of group.chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
        this._pendingChunks.delete(chunkId);
        console.log(`[FirebaseYjsSync] Applying chunked update from ${fromPeerId} (${totalLen} bytes, ${totalChunks} chunks)`);
        Y.applyUpdate(this.ydoc, combined, 'firebase-sync');
      } else {
        // Single update.
        const update = new Uint8Array(entry.data);
        console.log(`[FirebaseYjsSync] Applying update from ${fromPeerId} (${update.byteLength} bytes)`);
        Y.applyUpdate(this.ydoc, update, 'firebase-sync');
      }
    } catch (e) {
      console.warn('[FirebaseYjsSync] Failed to apply update:', e);
    }
  }

  // ── Send ─────────────────────────────────────────────────────────────────────

  /**
   * Push a Yjs update to Firebase if any peer lacks an open WebRTC channel.
   * Presence updates no longer flow through here — they use the dedicated
   * awareness Firebase path (rooms/{roomId}/awareness/) instead.
   */
  _maybeSendViaFirebase(update, origin) {
    const allPeersConnected = this.channels.size > 0 &&
      [...this.channels.values()].every(ch => ch.readyState === 'open');
    if (allPeersConnected) return;

    const now = Date.now();
    const myOutboxRef = ref(this.db, `rooms/${this.roomId}/yjsSync/${this.myPeerId}`);
    console.log(`[FirebaseYjsSync] Pushing update to Firebase (${update.byteLength} bytes, channels: ${this.channels.size})`);
    push(myOutboxRef, { data: Array.from(update), ts: now })
      .catch(e => console.warn('[FirebaseYjsSync] Push failed:', e));
  }

  /**
   * Push potentially-large data, splitting into ≤FIREBASE_MAX_WRITE_BYTES chunks.
   */
  async _pushChunked(outboxRef, data) {
    if (data.byteLength <= FIREBASE_MAX_WRITE_BYTES) {
      return push(outboxRef, { data: Array.from(data), ts: Date.now() });
    }

    // Generate a stable chunk group ID (reuse Math.random — nanoid not imported here)
    const chunkId = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
    const totalChunks = Math.ceil(data.byteLength / FIREBASE_MAX_WRITE_BYTES);
    const ts = Date.now();
    const pushes = [];
    for (let i = 0; i < totalChunks; i++) {
      const slice = data.slice(i * FIREBASE_MAX_WRITE_BYTES, (i + 1) * FIREBASE_MAX_WRITE_BYTES);
      pushes.push(
        push(outboxRef, { data: Array.from(slice), chunkId, chunkIndex: i, totalChunks, ts })
      );
    }
    return Promise.all(pushes);
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────────

  /** On startup: delete own outbox entries older than ENTRY_TTL_MS.
   *  Only reads own outbox — never does a full-tree get() which would download
   *  the entire yjsSync subtree and cause massive Firebase bandwidth usage. */
  async _cleanupStaleEntries() {
    const myOutboxRef = ref(this.db, `rooms/${this.roomId}/yjsSync/${this.myPeerId}`);
    try {
      const snapshot = await get(myOutboxRef);
      if (!snapshot.exists()) return;
      const threshold = Date.now() - ENTRY_TTL_MS;
      const deletions = [];
      snapshot.forEach((child) => {
        const entry = child.val();
        if (entry?.ts && entry.ts < threshold) {
          deletions.push(remove(child.ref));
        }
      });
      if (deletions.length > 0) {
        await Promise.all(deletions);
        console.log(`[FirebaseYjsSync] Startup cleanup: removed ${deletions.length} stale own entries`);
      }
    } catch (e) {
      console.warn('[FirebaseYjsSync] Startup cleanup failed:', e);
    }
  }

  /** Periodic: delete own outbox entries older than ENTRY_TTL_MS. */
  async _cleanupOwnEntries() {
    const myOutboxRef = ref(this.db, `rooms/${this.roomId}/yjsSync/${this.myPeerId}`);
    try {
      const snapshot = await get(myOutboxRef);
      if (!snapshot.exists()) return;
      const threshold = Date.now() - ENTRY_TTL_MS;
      const deletions = [];
      snapshot.forEach((child) => {
        const entry = child.val();
        if (entry?.ts && entry.ts < threshold) {
          deletions.push(remove(child.ref));
        }
      });
      if (deletions.length > 0) {
        await Promise.all(deletions);
        console.log(`[FirebaseYjsSync] Cleaned up ${deletions.length} old entries`);
      }
    } catch (e) {
      console.warn('[FirebaseYjsSync] Cleanup failed:', e);
    }
  }

  stop() {
    this._cleanupFns.forEach((fn) => { if (typeof fn === 'function') fn(); });
    this._cleanupFns = [];
    this._knownPeerOutboxes.clear();
    this._pendingChunks.clear();
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    console.log('[FirebaseYjsSync] Stopped');
  }
}
