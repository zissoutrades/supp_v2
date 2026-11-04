// Supp v2 - tokenExchange Yjs map observer
// Watches for encrypted tokens addressed to this agent in the tokenExchange map,
// decrypts them, stores them, and deletes the consumed entry.
// On first connection, pushes own refresh token to all online peers.

import { hybridEncrypt, hybridDecrypt, importPublicKey } from '../crypto/rsa.js';
import { awareness } from '../yjs/doc.js';

export class TokenExchangeObserver {
  /**
   * @param {Y.Doc} ydoc
   * @param {object} tokenMgr - TokenManager instance
   * @param {string} myEmail
   */
  constructor(ydoc, tokenMgr, myEmail) {
    this.tokenExchange = ydoc.getMap('tokenExchange');
    this.tokenManager = tokenMgr;
    this.myEmail = myEmail;
    this._stopped = false;
    this._onTokenExchangeChange = () => this._processIncoming();
  }

  start() {
    this._stopped = false;
    this.tokenExchange.observe(this._onTokenExchangeChange);
    // Process any entries already in the map (e.g. from before we connected)
    this._processIncoming();
  }

  stop() {
    this._stopped = true;
    this.tokenExchange.unobserve(this._onTokenExchangeChange);
  }

  /**
   * Scan the tokenExchange map for entries addressed to us, decrypt, store, delete.
   */
  async _processIncoming() {
    if (this._stopped) return;

    for (const [key, entry] of this.tokenExchange.entries()) {
      if (this._stopped) return;
      if (entry.toEmail?.toLowerCase() !== this.myEmail.toLowerCase()) continue;

      try {
        const privateKey = await this.tokenManager.getPrivateKey();
        const refreshToken = await hybridDecrypt(entry, privateKey);
        await this.tokenManager.storeRefreshToken(entry.fromEmail, refreshToken);
        console.log('[Supp] TokenExchange: stored token from', entry.fromEmail);

        // Delete entry — the deletion propagates to all peers via CRDT
        this.tokenExchange.delete(key);
      } catch (err) {
        console.warn('[Supp] TokenExchange: failed to decrypt entry from', entry.fromEmail, err.message);
      }
    }
  }

  /**
   * Push this agent's own refresh token to all currently online peers.
   * Called once when the agent first connects to the Yjs mesh.
   */
  async pushOwnTokenToOnlinePeers() {
    if (this._stopped) return;

    const myRefreshToken = await this.tokenManager.getRefreshToken(this.myEmail);
    if (!myRefreshToken) return;

    const { publicKeyDirectory = {} } = await chrome.storage.local.get('publicKeyDirectory');
    const now = Date.now();
    const timeout = this.tokenManager.LEADER_TIMEOUT || 15000;

    const onlinePeers = [];
    for (const entry of awareness.getStates().values()) {
      if (!entry?.email || entry.email === this.myEmail) continue;
      if (now - entry.lastSeen > timeout) continue;
      if (publicKeyDirectory[entry.email]) {
        onlinePeers.push(entry.email);
      }
    }

    for (const peerEmail of onlinePeers) {
      if (this._stopped) return;
      try {
        const peerPublicKey = await importPublicKey(publicKeyDirectory[peerEmail]);
        const encrypted = await hybridEncrypt(myRefreshToken, peerPublicKey);
        const entryKey = `${this.myEmail}→${peerEmail}`;
        this.tokenExchange.set(entryKey, {
          ...encrypted,
          fromEmail: this.myEmail,
          toEmail: peerEmail,
          timestamp: now
        });
        console.log('[Supp] TokenExchange: pushed own token to', peerEmail);
      } catch (err) {
        console.warn('[Supp] TokenExchange: failed to push token to', peerEmail, err.message);
      }
    }
  }
}
