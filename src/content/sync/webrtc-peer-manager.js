// Supp v2 - WebRTC Peer Manager
// Creates and manages RTCPeerConnections for each remote agent.
// Uses FirebaseSignaling for SDP/ICE exchange (signaling only — Firebase goes idle once connected).
// Runs a minimal Yjs sync protocol over each data channel, then forwards incremental updates.

import * as Y from 'yjs';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

const RECONNECTION_DELAY_MS = 2000;
const DATA_CHANNEL_LABEL = 'yjs-sync';

export class WebRTCPeerManager {
  /**
   * @param {Y.Doc} ydoc
   * @param {FirebaseSignaling} signaling
   */
  constructor(ydoc, signaling) {
    this.ydoc = ydoc;
    this.signaling = signaling;
    this.peers = new Map();        // peerId → RTCPeerConnection
    this.channels = new Map();     // peerId → RTCDataChannel
    this.updateHandlers = new Map(); // peerId → Yjs update handler

    // Tracks peers for whom we are the initiator AND the offer is still in
    // flight (sent but connection state hasn't left 'new' yet). Cleared in
    // onconnectionstatechange when state leaves 'new', and in _removeConnection.
    this._initiating = new Set();

    // Tracks peers whose incoming offer we are currently processing.
    // Prevents a duplicate offer from tearing down an in-progress connection.
    this._handlingOffer = new Set();

    // Buffers ICE candidates that arrive before the RTCPeerConnection exists or
    // before setRemoteDescription has been called. With trickle ICE, the initiator's
    // candidates race ahead of the offer through Firebase. Without buffering they
    // are consumed from Firebase and lost. Flushed in _flushPendingCandidates()
    // immediately after setRemoteDescription.
    this._pendingCandidates = new Map(); // peerId → plain candidate object[]

    // Set to true by destroy() so pending reconnect timers abort cleanly.
    this._destroyed = false;

    this._setupSignalingHandlers();
  }

  _setupSignalingHandlers() {
    // Tie-breaker: only the peer with the lexicographically smaller ID initiates.
    // Applied in both onPeerJoined and connectToExistingPeers so exactly one side
    // sends the first offer per pair regardless of join order.
    this.signaling.onPeerJoined(async (remotePeerId) => {
      console.log(`[WebRTC] Peer joined: ${remotePeerId}`);
      if (this.signaling.peerId < remotePeerId) {
        await this._initiateConnection(remotePeerId);
      }
    });

    this.signaling.onPeerLeft((remotePeerId) => {
      console.log(`[WebRTC] Peer left: ${remotePeerId}`);
      // Connection state change will also fire; this handles the Firebase-side departure.
      this._removeConnection(remotePeerId);
    });

    // Handle incoming SDP offer
    this.signaling.onOffer(async (fromPeerId, offer) => {
      if (this._handlingOffer.has(fromPeerId)) {
        console.log(`[WebRTC] Dropping duplicate offer from ${fromPeerId}`);
        return;
      }
      this._handlingOffer.add(fromPeerId);
      try {
        console.log(`[WebRTC] Received offer from ${fromPeerId}`);
        const pc = await this._createConnection(fromPeerId, false);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        // Flush any candidates that arrived before the offer (trickle ICE race)
        await this._flushPendingCandidates(fromPeerId, pc);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await this.signaling.sendAnswer(fromPeerId, answer);
      } finally {
        this._handlingOffer.delete(fromPeerId);
      }
    });

    // Handle incoming SDP answer
    this.signaling.onAnswer(async (fromPeerId, answer) => {
      console.log(`[WebRTC] Received answer from ${fromPeerId}`);
      const pc = this.peers.get(fromPeerId);
      if (pc && pc.signalingState !== 'stable') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this._flushPendingCandidates(fromPeerId, pc);
      }
    });

    // Handle incoming ICE candidate
    this.signaling.onIceCandidate(async (fromPeerId, candidate) => {
      // Skip end-of-candidates markers (both fields null)
      if (!candidate || (candidate.sdpMid === null && candidate.sdpMLineIndex === null)) return;
      console.log(`[WebRTC] Received ICE candidate from ${fromPeerId}: ${candidate.candidate?.substring(0, 80)}`);
      const pc = this.peers.get(fromPeerId);
      if (pc && pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.log(`[WebRTC] ICE candidate error for ${fromPeerId}:`, e.message);
        }
      } else {
        // PC not yet created, or remote description not yet set — buffer until flush
        if (!this._pendingCandidates.has(fromPeerId)) {
          this._pendingCandidates.set(fromPeerId, []);
        }
        this._pendingCandidates.get(fromPeerId).push(candidate);
        console.log(`[WebRTC] Buffered ICE candidate from ${fromPeerId} (${pc ? 'no remote desc yet' : 'no PC yet'}), total: ${this._pendingCandidates.get(fromPeerId).length}`);
      }
    });
  }

  /** Initiate a connection as the offering side, guarding against concurrent calls. */
  async _initiateConnection(remotePeerId) {
    if (this._initiating.has(remotePeerId)) return;
    const existing = this.peers.get(remotePeerId);
    if (existing) {
      if (existing.connectionState === 'connected' || existing.connectionState === 'connecting') return;
      // SDP done but ICE hasn't started yet: both descriptions set means connection is valid
      if (existing.localDescription && existing.remoteDescription) return;
    }
    this._initiating.add(remotePeerId);
    await this._createConnection(remotePeerId, true);
    // _initiating is cleared in onconnectionstatechange when state leaves 'new'
  }

  async _createConnection(remotePeerId, isInitiator) {
    // Reuse any healthy or in-progress connection
    if (this.peers.has(remotePeerId)) {
      const existing = this.peers.get(remotePeerId);
      if (
        existing.connectionState === 'connected' ||
        existing.connectionState === 'connecting' ||
        (existing.localDescription && existing.remoteDescription) ||
        this._initiating.has(remotePeerId) ||
        this._handlingOffer.has(remotePeerId)
      ) {
        console.log(`[WebRTC] Reusing existing connection to ${remotePeerId} (state: ${existing.connectionState})`);
        return existing;
      }
      console.log(`[WebRTC] Removing stale connection to ${remotePeerId} (state: ${existing.connectionState})`);
      this._removeConnection(remotePeerId);
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peers.set(remotePeerId, pc);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        console.log(`[WebRTC] Sending ICE candidate to ${remotePeerId}: ${candidate.type} ${candidate.protocol} ${candidate.address}:${candidate.port}`);
        this.signaling.sendIceCandidate(remotePeerId, candidate);
      } else {
        console.log(`[WebRTC] ICE gathering complete for ${remotePeerId}`);
      }
    };

    pc.onicegatheringstatechange = () => {
      console.log(`[WebRTC] ICE gathering state for ${remotePeerId}: ${pc.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`[WebRTC] ICE connection state for ${remotePeerId}: ${pc.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      console.log(`[WebRTC] Connection to ${remotePeerId}: ${state}`);
      if (state !== 'new') {
        this._initiating.delete(remotePeerId);
      }
      if (state === 'connected') {
        console.log(`[WebRTC] Successfully connected to ${remotePeerId}`);
      } else if (state === 'disconnected' || state === 'failed') {
        this._handleDisconnection(remotePeerId);
      }
    };

    if (isInitiator) {
      const channel = pc.createDataChannel(DATA_CHANNEL_LABEL, { ordered: true });
      this._setupDataChannel(remotePeerId, channel);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.signaling.sendOffer(remotePeerId, offer);
    } else {
      pc.ondatachannel = ({ channel }) => {
        this._setupDataChannel(remotePeerId, channel);
      };
    }

    return pc;
  }

  _setupDataChannel(remotePeerId, channel) {
    this.channels.set(remotePeerId, channel);

    channel.onopen = () => {
      console.log(`[WebRTC] Data channel open with ${remotePeerId}, syncing Yjs state`);
      // Yjs sync protocol — step 1: send our state vector so the remote knows what to send us.
      // Both sides do this on open, so both get the full diff from each other.
      // See onmessage handler below for steps 2 and 3.
      const sv = Y.encodeStateVector(this.ydoc);
      channel.send(JSON.stringify({ type: 'sync-step1', sv: Array.from(sv) }));
    };

    channel.onmessage = ({ data }) => {
      try {
        const msg = JSON.parse(data);

        if (msg.type === 'sync-step1') {
          // Step 2: remote sent us their state vector. Reply with what they're missing.
          // Do NOT send our own step-1 again here — both sides already do that on open,
          // so re-sending would create an infinite echo loop.
          const theirSV = new Uint8Array(msg.sv);
          const diff = Y.encodeStateAsUpdate(this.ydoc, theirSV);
          channel.send(JSON.stringify({ type: 'sync-step2', update: Array.from(diff) }));
        }

        if (msg.type === 'sync-step2') {
          // Step 3: apply the diff the remote sent us
          Y.applyUpdate(this.ydoc, new Uint8Array(msg.update), remotePeerId);
        }

        if (msg.type === 'update') {
          // Incremental update from the remote agent after initial sync
          Y.applyUpdate(this.ydoc, new Uint8Array(msg.update), remotePeerId);
        }
      } catch (error) {
        console.error(`[WebRTC] Error handling message from ${remotePeerId}:`, error);
      }
    };

    channel.onclose = () => {
      console.log(`[WebRTC] Data channel closed with ${remotePeerId}`);
    };

    channel.onerror = (error) => {
      console.error(`[WebRTC] Data channel error with ${remotePeerId}:`, error);
    };

    // Forward local Yjs updates to this peer
    const updateHandler = (update, origin) => {
      if (origin === remotePeerId) return; // don't echo back updates we received from this peer
      if (channel.readyState === 'open') {
        try {
          channel.send(JSON.stringify({ type: 'update', update: Array.from(update) }));
        } catch (error) {
          console.error(`[WebRTC] Error sending update to ${remotePeerId}:`, error);
        }
      }
    };
    this.ydoc.on('update', updateHandler);
    this.updateHandlers.set(remotePeerId, updateHandler);
  }

  async _flushPendingCandidates(peerId, pc) {
    const pending = this._pendingCandidates.get(peerId);
    if (!pending || pending.length === 0) return;
    this._pendingCandidates.delete(peerId);
    console.log(`[WebRTC] Flushing ${pending.length} buffered ICE candidate(s) for ${peerId}`);
    for (const candidate of pending) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.log(`[WebRTC] Buffered ICE candidate error for ${peerId}:`, e.message);
      }
    }
  }

  _handleDisconnection(remotePeerId) {
    console.log(`[WebRTC] Peer ${remotePeerId} disconnected, attempting reconnection in ${RECONNECTION_DELAY_MS}ms`);
    this._removeConnection(remotePeerId);

    setTimeout(async () => {
      if (this._destroyed) return; // manager was torn down while timer was pending
      try {
        const onlinePeers = await this.signaling.getOnlinePeers();
        if (onlinePeers.includes(remotePeerId)) {
          console.log(`[WebRTC] Reconnecting to ${remotePeerId}`);
          await this._initiateConnection(remotePeerId);
        } else {
          console.log(`[WebRTC] Peer ${remotePeerId} no longer in room, skipping reconnection`);
        }
      } catch (error) {
        console.error(`[WebRTC] Error during reconnection to ${remotePeerId}:`, error);
      }
    }, RECONNECTION_DELAY_MS);
  }

  _removeConnection(remotePeerId) {
    this._initiating.delete(remotePeerId);
    this._handlingOffer.delete(remotePeerId);
    this._pendingCandidates.delete(remotePeerId);

    const pc = this.peers.get(remotePeerId);
    if (pc) pc.close();
    this.peers.delete(remotePeerId);

    const channel = this.channels.get(remotePeerId);
    if (channel) {
      try { channel.close(); } catch (e) { /* already closed */ }
    }
    this.channels.delete(remotePeerId);

    const handler = this.updateHandlers.get(remotePeerId);
    if (handler) {
      this.ydoc.off('update', handler);
      this.updateHandlers.delete(remotePeerId);
    }
  }

  /** Connect to all currently online peers in the room. */
  async connectToExistingPeers() {
    const onlinePeers = await this.signaling.getOnlinePeers();
    console.log(`[WebRTC] Found ${onlinePeers.length} existing peer(s)`);
    for (const peerId of onlinePeers) {
      if (this.signaling.peerId < peerId) {
        await this._initiateConnection(peerId);
      }
    }
  }

  /** Close all peer connections and stop all reconnection attempts. */
  destroy() {
    console.log('[WebRTC] Destroying all peer connections');
    this._destroyed = true;
    this.peers.forEach((pc, peerId) => this._removeConnection(peerId));
  }
}
