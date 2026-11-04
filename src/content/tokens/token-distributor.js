// Supp v2 - Token Distributor (leader-side)
// When the leader processes a join request, it builds a token package containing
// all team refresh tokens, encrypts it for the new agent, and sends it via email.
// It also distributes the new agent's token to all existing agents.

import { SYSTEM_SUBJECTS, INBOX_POLL_INTERVAL_MS } from '../../common/constants.js';
import { hybridEncrypt, importPublicKey } from '../crypto/rsa.js';
import { tokenManager } from './token-manager.js';
import { sendSystemEmail, ensureSuppSystemLabel, insertSystemMessage, searchMessages } from '../onboarding/system-threads.js';

export class TokenDistributor {
  /**
   * @param {object} teamConfig - from chrome.storage.local
   */
  constructor(teamConfig) {
    this.teamConfig = teamConfig;
    this._pollTimer = null;
    this._processed = new Set(); // message IDs already handled
    this._shadowService = null;
  }

  /** Wire up shadow service so we can catch up new agents immediately after join. */
  setShadowService(shadowService) {
    this._shadowService = shadowService;
  }

  /**
   * Start polling the shared inbox for join requests (leader-only).
   */
  startPolling() {
    if (this._pollTimer) return;
    console.log('[Supp] TokenDistributor: starting join-request polling');
    const poll = async () => {
      try { await this._checkForJoinRequests(); } catch (err) {
        console.warn('[Supp] TokenDistributor: poll error:', err.message);
      }
      this._pollTimer = setTimeout(poll, INBOX_POLL_INTERVAL_MS);
    };
    // Run immediately, then on interval
    poll();
  }

  /**
   * Stop polling (called when leader steps down).
   */
  stopPolling() {
    if (this._pollTimer) {
      clearTimeout(this._pollTimer);
      this._pollTimer = null;
    }
    console.log('[Supp] TokenDistributor: polling stopped');
  }

  /**
   * Scan the shared inbox for unprocessed [supp-join-request] emails.
   */
  async _checkForJoinRequests() {
    const { sharedInboxEmail, teamId } = this.teamConfig;
    const accessToken = await tokenManager.getAccessToken(sharedInboxEmail);
    const query = `subject:${SYSTEM_SUBJECTS.JOIN_REQUEST} newer_than:7d`;
    const messages = await searchMessages(accessToken, query, 20);

    for (const msg of messages) {
      if (this._processed.has(msg.id)) continue;
      if (msg.headers['x-supp-msgtype'] !== 'join-request') continue;
      if (msg.headers['x-supp-teamid'] !== teamId) continue;

      this._processed.add(msg.id);
      const joinRequest = msg.body;
      if (!joinRequest || typeof joinRequest !== 'object') {
        console.warn('[Supp] TokenDistributor: invalid join request body', typeof joinRequest);
        continue;
      }
      await this.processJoinRequest(joinRequest);
    }
  }

  /**
   * Process a join request: build token package, send to new agent, update keyring.
   *
   * @param {object} joinRequest - { agentEmail, agentName, publicKey, invitePayload, requestedAt }
   * @returns {Promise<void>}
   */
  async processJoinRequest(joinRequest) {
    const { teamId, sharedInboxEmail } = this.teamConfig;
    const { agentEmail, agentName, publicKey: agentPublicKeyJwk } = joinRequest;

    console.log('[Supp] TokenDistributor: processing join request from', agentEmail);

    // Validate teamId
    if (joinRequest.invitePayload?.teamId !== teamId) {
      console.warn('[Supp] TokenDistributor: rejecting join request — teamId mismatch');
      return;
    }

    // Duplicate guard
    const existingEmails = await tokenManager.listStoredEmails();
    if (existingEmails.includes(agentEmail)) {
      console.log('[Supp] TokenDistributor: agent already has tokens, skipping');
      return;
    }

    // Store agent's refresh token if they included it in the join request.
    // This allows the leader to insert shadow emails into the agent's inbox
    // immediately (catch-up) without waiting for P2P token exchange.
    if (joinRequest.agentRefreshToken) {
      await tokenManager.storeRefreshToken(agentEmail, joinRequest.agentRefreshToken);
      console.log('[Supp] TokenDistributor: stored refresh token for', agentEmail);
    }

    // Collect all team refresh tokens this leader holds
    const sharedInboxToken = await tokenManager.getRefreshToken(sharedInboxEmail);
    if (!sharedInboxToken) {
      console.error('[Supp] TokenDistributor: no shared inbox token — cannot build package');
      return;
    }

    const agentTokens = {};
    for (const email of existingEmails) {
      if (email === sharedInboxEmail) continue; // handled separately
      const token = await tokenManager.getRefreshToken(email);
      if (token) agentTokens[email] = token;
    }

    // Load public key directory for inclusion in package
    const { publicKeyDirectory = {} } = await chrome.storage.local.get('publicKeyDirectory');

    // Catch up the new agent with shadow copies of all existing tickets.
    if (this._shadowService) {
      try {
        await this._shadowService.catchUpAgent(agentEmail);
      } catch (err) {
        console.warn('[Supp] TokenDistributor: shadow catch-up failed for', agentEmail, err.message);
      }
    }

    // Build token package.
    // NOTE: yjsSnapshot intentionally excluded — including the full Yjs state as
    // an Array.from(Uint8Array) JSON array makes the encrypted email body too large
    // for Gmail's format=full inline body limit, causing body.data to be absent and
    // the agent to never find the token package. The agent bootstraps Yjs state via
    // Firebase Yjs sync (sub-phase 07b) after receiving credentials.
    const tokenPackage = {
      forEmail: agentEmail,
      sharedInboxToken,
      agentTokens,
      publicKeyDirectory,
      issuedAt: Date.now(),
      issuedBy: sharedInboxEmail
    };

    // Hybrid-encrypt for the new agent
    const agentPublicKey = await importPublicKey(agentPublicKeyJwk);
    const encryptedPackage = await hybridEncrypt(JSON.stringify(tokenPackage), agentPublicKey);

    // Send token package email from shared inbox to agent's personal inbox
    const sharedInboxAccessToken = await tokenManager.getAccessToken(sharedInboxEmail);
    await sendSystemEmail(sharedInboxAccessToken, {
      from: sharedInboxEmail,
      to: agentEmail,
      subject: SYSTEM_SUBJECTS.TOKEN_PACKAGE,
      msgType: 'token-package',
      teamId,
      encryptedBodyJson: encryptedPackage,
      forEmail: agentEmail
    });

    console.log('[Supp] TokenDistributor: token package sent to', agentEmail);

    // Add new agent's public key to [supp-keyring]
    const labelId = await ensureSuppSystemLabel(sharedInboxAccessToken);
    await insertSystemMessage(sharedInboxAccessToken, labelId, {
      from: sharedInboxEmail,
      to: sharedInboxEmail,
      subject: SYSTEM_SUBJECTS.KEYRING,
      msgType: 'keyring-entry',
      teamId,
      bodyJson: {
        email: agentEmail,
        publicKey: agentPublicKeyJwk,
        addedAt: Date.now(),
        addedBy: sharedInboxEmail
      }
    });

    // Update local public key directory with new agent
    publicKeyDirectory[agentEmail] = agentPublicKeyJwk;
    await chrome.storage.local.set({ publicKeyDirectory });

    console.log('[Supp] TokenDistributor: join request fully processed for', agentEmail);
  }
}
