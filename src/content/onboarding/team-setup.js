// Supp v2 - Team Owner Setup Flow (Gmail thread config store)
// Creates [supp-config] + [supp-keyring] threads in the shared inbox,
// sends invitation emails to agents, and stores team config locally.

import { nanoid } from 'nanoid';
import { SHADOW_DOMAIN, SYSTEM_SUBJECTS, SUPP_SYSTEM_LABEL } from '../../common/constants.js';
import { launchOAuthPkce } from '../crypto/pkce.js';
import { importPublicKey } from '../crypto/rsa.js';
import { tokenManager } from '../tokens/token-manager.js';
import {
  ensureSuppSystemLabel,
  insertSystemMessage,
  sendSystemEmail
} from './system-threads.js';
import { setupFirebase } from './firebase-auto-setup.js';

/**
 * Full team owner setup flow.
 * Follows supp-v2-onboarding-keys-tokens.md section 7.2.
 *
 * @param {object} opts
 * @param {string} opts.sharedInboxEmail
 * @param {string} opts.serviceAccountJson - Firebase service account JSON (can be null to skip)
 * @param {string[]} opts.agentEmails - emails to invite
 * @param {function} opts.onProgress - called with status strings during setup
 * @returns {Promise<{ teamConfig: object, needsManualRules: boolean, needsManualApiKey: boolean }>}
 */
export async function initializeTeam({ sharedInboxEmail, serviceAccountJson, agentEmails, onProgress }) {
  const progress = onProgress || (() => {});

  // Step 1: Authenticate owner's personal account
  progress('Authenticating your personal Gmail account…');
  const ownerAuth = await launchOAuthPkce();
  const ownerEmail = ownerAuth.email;
  if (!ownerEmail) throw new Error('Could not determine your Gmail address from OAuth response');

  await tokenManager.storeRefreshToken(ownerEmail, ownerAuth.refreshToken);
  const ownerPublicKeyJwk = await tokenManager.generateAndStoreKeypair();

  progress(`Authenticated as ${ownerEmail}`);

  // Step 2: Authenticate shared inbox account
  // If the owner is the same account as the shared inbox, reuse the owner tokens
  // instead of launching a second OAuth popup (Chrome rejects the same-account flow).
  let confirmedSharedEmail;
  let sharedInboxAccessToken;

  if (ownerEmail.toLowerCase() === sharedInboxEmail.toLowerCase()) {
    confirmedSharedEmail = ownerEmail;
    sharedInboxAccessToken = ownerAuth.accessToken;
    progress('Shared inbox is the same account — reusing credentials');
  } else {
    progress(`Authenticating shared inbox (${sharedInboxEmail})…`);
    // Brief pause to let Chrome clean up the first OAuth popup window
    await new Promise(r => setTimeout(r, 500));
    const sharedAuth = await launchOAuthPkce(sharedInboxEmail);
    confirmedSharedEmail = sharedAuth.email || sharedInboxEmail;
    await tokenManager.storeRefreshToken(confirmedSharedEmail, sharedAuth.refreshToken);
    sharedInboxAccessToken = sharedAuth.accessToken;
    progress('Shared inbox authenticated');
  }

  // Step 3: Generate team parameters
  const teamId = crypto.randomUUID();
  const yjsRoomId = crypto.randomUUID();

  // Step 4: Firebase setup (optional)
  let firebaseConfig = null;
  let needsManualRules = false;
  let needsManualApiKey = false;

  if (serviceAccountJson) {
    progress('Configuring Firebase…');
    const fbResult = await setupFirebase(serviceAccountJson);
    firebaseConfig = fbResult.firebaseConfig;
    needsManualRules = fbResult.needsManualRules;
    needsManualApiKey = fbResult.needsManualApiKey;
  }

  // Step 5: Write [supp-config] thread in shared inbox
  progress('Writing team config to shared inbox…');
  const labelId = await ensureSuppSystemLabel(sharedInboxAccessToken);

  const configBody = {
    version: 2,
    teamId,
    yjsRoomId,
    shadowDomain: SHADOW_DOMAIN,
    sharedInboxEmail: confirmedSharedEmail,
    firebaseConfig,
    createdAt: Date.now(),
    ownerEmail
  };

  await insertSystemMessage(sharedInboxAccessToken, labelId, {
    from: confirmedSharedEmail,
    to: confirmedSharedEmail,
    subject: SYSTEM_SUBJECTS.CONFIG,
    msgType: 'config',
    teamId,
    bodyJson: configBody
  });

  // Step 6: Publish public keys to [supp-keyring]
  progress('Publishing public keys…');

  // Generate a separate RSA keypair for the shared inbox account
  const sharedInboxKeypair = await (async () => {
    const { generateRsaKeypair, exportPublicKey } = await import('../crypto/rsa.js');
    const kp = await generateRsaKeypair();
    return {
      publicKeyJwk: await exportPublicKey(kp.publicKey),
      privateKey: kp.privateKey
    };
  })();

  // Store shared inbox's public key in our local directory
  const { publicKeyDirectory = {} } = await chrome.storage.local.get('publicKeyDirectory');
  publicKeyDirectory[confirmedSharedEmail] = sharedInboxKeypair.publicKeyJwk;
  publicKeyDirectory[ownerEmail] = ownerPublicKeyJwk;
  await chrome.storage.local.set({ publicKeyDirectory });

  await insertSystemMessage(sharedInboxAccessToken, labelId, {
    from: confirmedSharedEmail,
    to: confirmedSharedEmail,
    subject: SYSTEM_SUBJECTS.KEYRING,
    msgType: 'keyring-entry',
    teamId,
    bodyJson: {
      email: confirmedSharedEmail,
      publicKey: sharedInboxKeypair.publicKeyJwk,
      addedAt: Date.now(),
      addedBy: confirmedSharedEmail
    }
  });

  await insertSystemMessage(sharedInboxAccessToken, labelId, {
    from: confirmedSharedEmail,
    to: confirmedSharedEmail,
    subject: SYSTEM_SUBJECTS.KEYRING,
    msgType: 'keyring-entry',
    teamId,
    bodyJson: {
      email: ownerEmail,
      publicKey: ownerPublicKeyJwk,
      addedAt: Date.now(),
      addedBy: confirmedSharedEmail
    }
  });

  // Step 7: Store team config locally
  const teamConfig = {
    teamId,
    yjsRoomId,
    shadowDomain: SHADOW_DOMAIN,
    firebaseConfig,
    sharedInboxEmail: confirmedSharedEmail
  };

  await chrome.storage.local.set({
    teamConfig,
    myEmail: ownerEmail,
    myRole: ownerEmail.toLowerCase() === confirmedSharedEmail.toLowerCase() ? 'shared-inbox' : 'agent',
    myAgentId: nanoid()
  });

  // Step 8: Send invitation emails
  if (agentEmails?.length) {
    progress(`Sending invitations to ${agentEmails.length} agent(s)…`);
    await sendInvitations(agentEmails, teamConfig, sharedInboxAccessToken);
  }

  progress('Setup complete!');

  return { teamConfig, needsManualRules, needsManualApiKey };
}

/**
 * Send invitation emails to a list of agent email addresses.
 * Invitations are sent from the shared inbox via messages.send.
 *
 * @param {string[]} agentEmails
 * @param {object} teamConfig
 * @param {string} sharedInboxAccessToken
 */
export async function sendInvitations(agentEmails, teamConfig, sharedInboxAccessToken) {
  const { sharedInboxEmail, teamId } = teamConfig;

  for (const agentEmail of agentEmails) {
    const invitePayload = {
      teamId,
      yjsRoomId: teamConfig.yjsRoomId,
      firebaseConfig: teamConfig.firebaseConfig,
      shadowDomain: teamConfig.shadowDomain,
      sharedInboxEmail,
      inviteeEmail: agentEmail,
      nonce: nanoid()
    };

    await sendSystemEmail(sharedInboxAccessToken, {
      from: sharedInboxEmail,
      to: agentEmail,
      subject: `You've been invited to Supp — [team: ${sharedInboxEmail}]`,
      msgType: 'invite',
      teamId,
      bodyJson: invitePayload
    });

    console.log('[Supp] Invitation sent to', agentEmail);
  }
}
