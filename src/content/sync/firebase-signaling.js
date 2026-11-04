// Supp v2 - Firebase Signaling
// Handles WebRTC peer discovery and SDP/ICE exchange via Firebase Realtime Database
// Firebase is used ONLY during connection setup. Once WebRTC is live, this module is idle.

import { initializeApp } from 'firebase/app';
import { getDatabase, ref, set, onChildAdded, onChildRemoved, onDisconnect, remove, push, get } from 'firebase/database';
import { getAuth, signInAnonymously } from 'firebase/auth';

export class FirebaseSignaling {
  /**
   * @param {object} firebaseConfig  - Firebase config object from console
   * @param {string} roomId          - Unique room identifier (e.g. team slug + inbox address)
   * @param {string} peerId          - This agent's unique ID (nanoid, persisted in chrome.storage)
   */
  constructor(firebaseConfig, roomId, peerId) {
    this.roomId = roomId;
    this.peerId = peerId;
    this.db = null;
    this.auth = null;
    this.roomRef = null;
    this.myPeerRef = null;
    this.onOfferCallback = null;
    this.onAnswerCallback = null;
    this.onIceCandidateCallback = null;
    this.onPeerJoinedCallback = null;
    this.onPeerLeftCallback = null;
    this._app = initializeApp(firebaseConfig, `supp-${roomId}`);
    // Initialize db in constructor — getDatabase() is synchronous (no network call).
    // FirebaseYjsSync needs db immediately and must not wait for join() to complete.
    this.db = getDatabase(this._app);
    this._cleanupFns = [];
  }

  /**
   * Authenticate with Firebase.
   * Uses anonymous auth until sub-phase 04 onboarding wires up Google OAuth.
   */
  async authenticate() {
    this.auth = getAuth(this._app);
    try {
      await signInAnonymously(this.auth);
      console.log('[Firebase] Authenticated anonymously');
    } catch (err) {
      // Non-fatal: if anonymous auth is unavailable (e.g. admin-restricted-operation),
      // proceed unauthenticated. RTDB operations will succeed if security rules allow
      // unauthenticated access (".read": true / ".write": true).
      console.warn('[Firebase] Anonymous auth failed, proceeding unauthenticated:', err.code);
    }
  }

  /**
   * Join the signaling room.
   * Announces this peer as online and sets up listeners for peer presence,
   * offers, answers, and ICE candidates.
   */
  async join() {
    await this.authenticate();
    this.roomRef = ref(this.db, `rooms/${this.roomId}`);
    this.myPeerRef = ref(this.db, `rooms/${this.roomId}/peers/${this.peerId}`);

    // Purge any stale signals left over from a previous crashed session.
    // onChildAdded fires for ALL existing children when first attached, so without
    // this, old offers/answers/candidates would replay and corrupt the new session.
    await remove(ref(this.db, `rooms/${this.roomId}/signals/${this.peerId}`));

    // Announce presence
    await set(this.myPeerRef, {
      peerId: this.peerId,
      joinedAt: Date.now(),
    });

    // Server-side cleanup: if this client disconnects unexpectedly, Firebase
    // removes the peer entry automatically. This is the reliable cleanup path —
    // the explicit remove() in leave() is best-effort only.
    onDisconnect(this.myPeerRef).remove();

    // Listen for other peers joining
    const peersRef = ref(this.db, `rooms/${this.roomId}/peers`);
    const unsubPeersAdded = onChildAdded(peersRef, (snapshot) => {
      const peer = snapshot.val();
      if (peer && peer.peerId !== this.peerId) {
        this.onPeerJoinedCallback?.(peer.peerId);
      }
    });
    this._cleanupFns.push(unsubPeersAdded);

    // Listen for other peers leaving (Firebase onDisconnect or explicit leave())
    const unsubPeersRemoved = onChildRemoved(peersRef, (snapshot) => {
      const peer = snapshot.val();
      if (peer && peer.peerId !== this.peerId) {
        this.onPeerLeftCallback?.(peer.peerId);
      }
    });
    this._cleanupFns.push(unsubPeersRemoved);

    // Listen for offers addressed to this peer
    const offersRef = ref(this.db, `rooms/${this.roomId}/signals/${this.peerId}/offers`);
    const unsubOffers = onChildAdded(offersRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        this.onOfferCallback?.(data.fromPeerId, data.offer);
        remove(snapshot.ref); // consume: signals are one-shot, delete after delivery
      }
    });
    this._cleanupFns.push(unsubOffers);

    // Listen for answers addressed to this peer
    const answersRef = ref(this.db, `rooms/${this.roomId}/signals/${this.peerId}/answers`);
    const unsubAnswers = onChildAdded(answersRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        this.onAnswerCallback?.(data.fromPeerId, data.answer);
        remove(snapshot.ref);
      }
    });
    this._cleanupFns.push(unsubAnswers);

    // Listen for ICE candidates addressed to this peer
    const iceCandidatesRef = ref(this.db, `rooms/${this.roomId}/signals/${this.peerId}/candidates`);
    const unsubCandidates = onChildAdded(iceCandidatesRef, (snapshot) => {
      const data = snapshot.val();
      if (data) {
        this.onIceCandidateCallback?.(data.fromPeerId, data.candidate);
        remove(snapshot.ref);
      }
    });
    this._cleanupFns.push(unsubCandidates);
  }

  /**
   * Get a list of currently online peers in the room (excluding self).
   */
  async getOnlinePeers() {
    const peersRef = ref(this.db, `rooms/${this.roomId}/peers`);
    const snapshot = await get(peersRef);
    const peers = [];
    snapshot.forEach((child) => {
      const peer = child.val();
      if (peer.peerId !== this.peerId) {
        peers.push(peer.peerId);
      }
    });
    return peers;
  }

  /** Send an SDP offer to a specific remote peer */
  async sendOffer(toPeerId, offer) {
    const targetRef = ref(this.db, `rooms/${this.roomId}/signals/${toPeerId}/offers`);
    await push(targetRef, { fromPeerId: this.peerId, offer });
  }

  /** Send an SDP answer to a specific remote peer */
  async sendAnswer(toPeerId, answer) {
    const targetRef = ref(this.db, `rooms/${this.roomId}/signals/${toPeerId}/answers`);
    await push(targetRef, { fromPeerId: this.peerId, answer });
  }

  /**
   * Send an ICE candidate to a specific remote peer.
   *
   * RTCIceCandidate is a WebIDL object — its properties (candidate, sdpMid,
   * sdpMLineIndex, usernameFragment) are prototype accessor getters, NOT own
   * enumerable properties. Firebase's serializer only traverses own properties,
   * so passing the object directly stores {}. Extract into a plain object first.
   */
  async sendIceCandidate(toPeerId, candidate) {
    const targetRef = ref(this.db, `rooms/${this.roomId}/signals/${toPeerId}/candidates`);
    await push(targetRef, {
      fromPeerId: this.peerId,
      candidate: {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
        usernameFragment: candidate.usernameFragment,
      },
    });
  }

  // Event handler setters
  onOffer(fn)        { this.onOfferCallback = fn; }
  onAnswer(fn)       { this.onAnswerCallback = fn; }
  onIceCandidate(fn) { this.onIceCandidateCallback = fn; }
  onPeerJoined(fn)   { this.onPeerJoinedCallback = fn; }
  onPeerLeft(fn)     { this.onPeerLeftCallback = fn; }

  /** Clean up all Firebase listeners and remove peer entry. Best-effort — server-side
   *  onDisconnect is the reliable cleanup path for unexpected disconnects. */
  async leave() {
    this._cleanupFns.forEach(fn => fn());
    if (this.myPeerRef) await remove(this.myPeerRef);
  }
}
