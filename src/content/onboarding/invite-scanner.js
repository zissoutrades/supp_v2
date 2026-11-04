// Supp v2 - Invite scanner
// Scans the agent's own inbox for a Supp invitation email on startup.

import { searchMessages } from './system-threads.js';

/**
 * Scan the agent's inbox for a pending invitation email.
 *
 * @param {string} accessToken - agent's own access token
 * @param {string} myEmail - agent's own email (to verify inviteeEmail)
 * @returns {Promise<
 *   { status: 'invite_found', invitePayload: object, messageId: string } |
 *   { status: 'no_invite' }
 * >}
 */
export async function scanForInviteEmail(accessToken, myEmail) {
  let messages;
  try {
    messages = await searchMessages(
      accessToken,
      'subject:"invited to Supp" newer_than:90d',
      10
    );
  } catch (err) {
    console.warn('[Supp] Invite scan failed:', err.message);
    return { status: 'no_invite' };
  }

  // Sort newest first — guards against any API ordering variation
  messages.sort((a, b) => {
    return new Date(b.headers['date'] || 0) - new Date(a.headers['date'] || 0);
  });

  for (const msg of messages) {
    const msgType = msg.headers['x-supp-msgtype'];
    if (msgType !== 'invite') continue;

    const body = msg.body;
    if (!body?.teamId || !body?.inviteeEmail) continue;

    // Verify this invite is addressed to us
    if (body.inviteeEmail.toLowerCase() !== myEmail.toLowerCase()) continue;

    return { status: 'invite_found', invitePayload: body, messageId: msg.id };
  }

  return { status: 'no_invite' };
}
