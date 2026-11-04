// Supp v2 - Agent Join Flow (Gmail-based, PKCE OAuth)
// Handles invite detection → join request → token package receipt → going live.

import * as Y from 'yjs';
import { nanoid } from 'nanoid';
import { SYSTEM_SUBJECTS } from '../../common/constants.js';
import { launchOAuthPkce } from '../crypto/pkce.js';
import { hybridDecrypt, importPublicKey } from '../crypto/rsa.js';
import { tokenManager } from '../tokens/token-manager.js';
import { ydoc } from '../yjs/doc.js';
import { sendSystemEmail, searchMessages } from './system-threads.js';
import { scanForInviteEmail } from './invite-scanner.js';

const TOKEN_PACKAGE_POLL_INTERVAL_MS = 30000;
const TOKEN_PACKAGE_POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Complete the agent join flow using a decoded invite payload.
 * Follows supp-v2-onboarding-keys-tokens.md section 8.2.
 *
 * @param {object} invitePayload - decoded from invitation email body
 * @param {function} [onProgress] - called with status strings
 * @returns {Promise<{ teamConfig: object }>}
 */
export async function joinTeam(invitePayload, onProgress) {
  const progress = onProgress || (() => {});

  const { teamId, yjsRoomId, firebaseConfig, shadowDomain, sharedInboxEmail } = invitePayload;

  // Step 1: Authenticate agent's Gmail account via PKCE
  progress('Authenticating your Gmail account…');
  const auth = await launchOAuthPkce();
  const agentEmail = auth.email;
  if (!agentEmail) throw new Error('Could not determine your Gmail address from OAuth response');

  await tokenManager.storeRefreshToken(agentEmail, auth.refreshToken);
  const publicKeyJwk = await tokenManager.generateAndStoreKeypair();
  progress(`Authenticated as ${agentEmail}`);

  // Verify this invite was meant for us
  if (invitePayload.inviteeEmail &&
      invitePayload.inviteeEmail.toLowerCase() !== agentEmail.toLowerCase()) {
    throw new Error(
      `This invitation was sent to ${invitePayload.inviteeEmail}, ` +
      `but you signed in as ${agentEmail}. Please sign in with the correct account.`
    );
  }

  // Step 2: Get agent name from profile
  let agentName = agentEmail;
  try {
    const profileResp = await fetch(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { headers: { 'Authorization': `Bearer ${auth.accessToken}` } }
    );
    const profile = await profileResp.json();
    agentName = profile.name || agentEmail;
  } catch {
    // non-fatal
  }

  // Step 3: Send [supp-join-request] to shared inbox.
  // Include the refresh token so the leader can immediately insert shadow emails
  // into this agent's inbox (catch-up) without waiting for P2P token exchange.
  progress('Sending join request to team…');
  await sendSystemEmail(auth.accessToken, {
    from: agentEmail,
    to: sharedInboxEmail,
    subject: SYSTEM_SUBJECTS.JOIN_REQUEST,
    msgType: 'join-request',
    teamId,
    bodyJson: {
      agentEmail,
      agentName,
      publicKey: publicKeyJwk,
      agentRefreshToken: auth.refreshToken,
      invitePayload,
      requestedAt: Date.now()
    }
  });

  // Step 4: Poll own inbox for [supp-token-package]
  progress('Waiting for team leader to send credentials (this may take up to 30 seconds)…');

  let tokenPackage = null;
  const deadline = Date.now() + TOKEN_PACKAGE_POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    tokenPackage = await pollForTokenPackage(auth.accessToken, agentEmail, sharedInboxEmail, teamId);
    if (tokenPackage) break;
    await new Promise(r => setTimeout(r, TOKEN_PACKAGE_POLL_INTERVAL_MS));
    progress('Still waiting for credentials…');
  }

  if (!tokenPackage) {
    throw new Error(
      'Timed out waiting for credentials from team leader. ' +
      'Ask a team member to open Gmail so the leader can process your request, then try joining again.'
    );
  }

  // Step 5: Decrypt token package with own private key
  progress('Decrypting credentials…');
  const privateKey = await tokenManager.getPrivateKey();
  const packageJson = await hybridDecrypt(tokenPackage.encryptedPackage, privateKey);
  const pkg = JSON.parse(packageJson);

  // Step 6: Store all received refresh tokens
  if (pkg.sharedInboxToken) {
    await tokenManager.storeRefreshToken(sharedInboxEmail, pkg.sharedInboxToken);
  }
  for (const [email, token] of Object.entries(pkg.agentTokens || {})) {
    await tokenManager.storeRefreshToken(email, token);
  }

  // Step 6.5: Apply Yjs snapshot to bootstrap this agent's local doc.
  // This gives them all existing tickets immediately without needing Firebase.
  if (pkg.yjsSnapshot) {
    try {
      Y.applyUpdate(ydoc, new Uint8Array(pkg.yjsSnapshot), 'token-package');
      console.log('[Supp] Yjs snapshot applied —', ydoc.getMap('tickets').size, 'tickets bootstrapped');
    } catch (err) {
      console.warn('[Supp] Yjs snapshot apply failed:', err.message);
    }
  }

  // Step 7: Cache public key directory
  if (pkg.publicKeyDirectory) {
    const { publicKeyDirectory = {} } = await chrome.storage.local.get('publicKeyDirectory');
    Object.assign(publicKeyDirectory, pkg.publicKeyDirectory);
    await chrome.storage.local.set({ publicKeyDirectory });
  }

  // Step 8: Store team config locally
  const teamConfig = {
    teamId,
    yjsRoomId,
    shadowDomain: shadowDomain || 'tkt.suppapp.com',
    firebaseConfig,
    sharedInboxEmail
  };

  const agentId = nanoid();
  await chrome.storage.local.set({
    teamConfig,
    myEmail: agentEmail,
    myRole: 'agent',
    myAgentId: agentId
  });

  progress('Joined team successfully!');
  return { teamConfig };
}

/**
 * Poll own inbox once for a [supp-token-package] from the shared inbox.
 * Returns the parsed (still-encrypted) token package, or null if not found.
 *
 * @param {string} accessToken - agent's own access token
 * @param {string} agentEmail
 * @param {string} sharedInboxEmail
 * @param {string} teamId
 * @returns {Promise<object|null>}
 */
async function pollForTokenPackage(accessToken, agentEmail, sharedInboxEmail, teamId) {
  try {
    const query = `from:${sharedInboxEmail} subject:${SYSTEM_SUBJECTS.TOKEN_PACKAGE} newer_than:1d`;
    const messages = await searchMessages(accessToken, query, 5);

    for (const msg of messages) {
      if (msg.headers['x-supp-msgtype'] !== 'token-package') continue;
      if (msg.headers['x-supp-teamid'] !== teamId) continue;
      if (msg.headers['x-supp-for']?.toLowerCase() !== agentEmail.toLowerCase()) continue;
      if (!msg.body) continue;

      return { encryptedPackage: msg.body, messageId: msg.id };
    }
  } catch (err) {
    console.warn('[Supp] Token package poll error:', err.message);
  }
  return null;
}
