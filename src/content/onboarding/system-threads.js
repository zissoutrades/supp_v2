// Supp v2 - Gmail system thread read/write
// All persistent team state is stored as emails in the shared inbox under
// the "Supp-System" label (hidden from inbox). This module handles all
// read/write operations for those system threads.

import { SUPP_SYSTEM_LABEL, SYSTEM_SUBJECTS } from '../../common/constants.js';
import { base64url, base64urlDecode } from '../crypto/storage-key.js';

// ─── Low-level Gmail API helper ───────────────────────────────────────────────

/**
 * Make an authenticated Gmail API call.
 * @param {string} accessToken
 * @param {string} path - path under /gmail/v1/users/me/
 * @param {object} [options] - fetch options
 */
async function gmailApi(accessToken, path, options = {}) {
  const base = typeof __GMAIL_API_BASE__ !== 'undefined'
    ? __GMAIL_API_BASE__
    : 'https://gmail.googleapis.com/gmail/v1';
  const resp = await fetch(`${base}/users/me/${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Gmail API ${resp.status}: ${body}`);
  }
  return resp.json();
}

/**
 * Make a multipart upload Gmail API call (for messages.insert).
 */
async function gmailUpload(accessToken, rawMessage, labelIds) {
  const base = typeof __GMAIL_UPLOAD_BASE__ !== 'undefined'
    ? __GMAIL_UPLOAD_BASE__
    : 'https://gmail.googleapis.com/upload/gmail/v1';

  const boundary = 'supp_boundary_' + Math.random().toString(36).slice(2);
  const metaPart = JSON.stringify({ labelIds, internalDate: String(Date.now()) });
  const body = [
    `--${boundary}`,
    'Content-Type: application/json',
    '',
    metaPart,
    `--${boundary}`,
    'Content-Type: message/rfc822',
    '',
    rawMessage,
    `--${boundary}--`
  ].join('\r\n');

  const resp = await fetch(
    `${base}/users/me/messages?uploadType=multipart&internalDateSource=dateHeader`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary="${boundary}"`
      },
      body
    }
  );
  if (!resp.ok) {
    const b = await resp.text().catch(() => '');
    throw new Error(`Gmail upload ${resp.status}: ${b}`);
  }
  return resp.json();
}

// ─── RFC 2822 helpers ─────────────────────────────────────────────────────────

/**
 * Build an RFC 2822 email string.
 */
function buildRfc2822({
  from, to, subject, msgType, teamId, bodyJson, timestamp = Date.now()
}) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `X-Supp-Version: 2`,
    `X-Supp-TeamId: ${teamId}`,
    `X-Supp-MsgType: ${msgType}`,
    `X-Supp-Timestamp: ${timestamp}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    JSON.stringify(bodyJson)
  ].join('\r\n');
}

/**
 * Build an RFC 2822 email where the body is already an encrypted blob
 * (for token packages where the whole JSON is RSA-encrypted).
 */
function buildRfc2822Encrypted({
  from, to, subject, msgType, teamId, encryptedBodyJson, forEmail, timestamp = Date.now()
}) {
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `X-Supp-Version: 2`,
    `X-Supp-TeamId: ${teamId}`,
    `X-Supp-MsgType: ${msgType}`,
    `X-Supp-For: ${forEmail}`,
    `X-Supp-Timestamp: ${timestamp}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=utf-8`,
    '',
    JSON.stringify(encryptedBodyJson)
  ].join('\r\n');
}

// ─── Label management ─────────────────────────────────────────────────────────

/**
 * Get or create the "Supp-System" label (hidden from label list).
 * @param {string} accessToken
 * @returns {Promise<string>} labelId
 */
export async function ensureSuppSystemLabel(accessToken) {
  const data = await gmailApi(accessToken, 'labels');
  const existing = (data.labels || []).find(l => l.name === SUPP_SYSTEM_LABEL);
  if (existing) return existing.id;

  const created = await gmailApi(accessToken, 'labels', {
    method: 'POST',
    body: JSON.stringify({
      name: SUPP_SYSTEM_LABEL,
      labelListVisibility: 'labelHide',
      messageListVisibility: 'hide'
    })
  });
  return created.id;
}

// ─── Insert / send system messages ───────────────────────────────────────────

/**
 * Insert a system message into the shared inbox (local to that mailbox).
 * Adds Supp-System label and removes from INBOX.
 *
 * @param {string} accessToken - shared inbox access token
 * @param {string} labelId - Supp-System label ID
 * @param {object} opts
 * @param {string} opts.from
 * @param {string} opts.to
 * @param {string} opts.subject
 * @param {string} opts.msgType
 * @param {string} opts.teamId
 * @param {object} opts.bodyJson
 */
export async function insertSystemMessage(accessToken, labelId, opts) {
  const raw = buildRfc2822(opts);
  await gmailUpload(accessToken, raw, [labelId]);
}

/**
 * Send a cross-account system email via gmail.users.messages.send.
 * Used for: invite emails, join requests, token packages.
 *
 * @param {string} accessToken
 * @param {object} opts
 */
export async function sendSystemEmail(accessToken, opts) {
  let raw;
  if (opts.encryptedBodyJson !== undefined) {
    raw = buildRfc2822Encrypted(opts);
  } else {
    raw = buildRfc2822(opts);
  }
  const encoded = base64url(new TextEncoder().encode(raw));
  await gmailApi(accessToken, 'messages/send', {
    method: 'POST',
    body: JSON.stringify({ raw: encoded })
  });
}

// ─── Search and read system threads ──────────────────────────────────────────

/**
 * Decode a message body (base64url-encoded JSON).
 * Handles both standard base64 and base64url variants.
 */
function decodeMessageBody(encodedBody) {
  const decoded = atob(encodedBody.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(decoded.length);
  for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

/**
 * Fetch and parse message headers + body.
 * @param {string} accessToken
 * @param {string} messageId
 * @returns {Promise<{ headers: object, body: any }>}
 */
async function fetchMessage(accessToken, messageId) {
  const msg = await gmailApi(accessToken, `messages/${messageId}?format=full`);
  const headers = {};
  for (const h of (msg.payload?.headers || [])) {
    headers[h.name.toLowerCase()] = h.value;
  }

  let body = null;
  try {
    const encoded = msg.payload?.body?.data || msg.payload?.parts?.[0]?.body?.data;
    if (encoded) body = decodeMessageBody(encoded);
  } catch {
    // body parse failed — return null
  }

  return { headers, body, id: msg.id, threadId: msg.threadId };
}

/**
 * Search for system messages by subject prefix in the given mailbox.
 * @param {string} accessToken
 * @param {string} subject - e.g. '[supp-config]'
 * @param {number} [maxResults=10]
 * @returns {Promise<Array<{ headers, body, id, threadId }>>}
 */
export async function searchSystemThread(accessToken, subject, maxResults = 10) {
  const query = `subject:"${subject}" label:${SUPP_SYSTEM_LABEL}`;
  const data = await gmailApi(
    accessToken,
    `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
  );
  const messages = data.messages || [];
  return Promise.all(messages.map(m => fetchMessage(accessToken, m.id)));
}

/**
 * Search for messages matching an arbitrary query (no label filter).
 * Used for invite scanning, token package polling, join request processing.
 */
export async function searchMessages(accessToken, query, maxResults = 20) {
  const data = await gmailApi(
    accessToken,
    `messages?q=${encodeURIComponent(query)}&maxResults=${maxResults}`
  );
  const messages = data.messages || [];
  return Promise.all(messages.map(m => fetchMessage(accessToken, m.id)));
}

// ─── Typed reads ──────────────────────────────────────────────────────────────

/**
 * Read the [supp-config] thread from the shared inbox.
 * @param {string} accessToken
 * @returns {Promise<object|null>} config body or null if not found
 */
export async function readConfigThread(accessToken) {
  const msgs = await searchSystemThread(accessToken, SYSTEM_SUBJECTS.CONFIG, 1);
  return msgs[0]?.body ?? null;
}

/**
 * Read all [supp-keyring] entries and return as a Map<email, JsonWebKey>.
 * @param {string} accessToken
 * @returns {Promise<Map<string, JsonWebKey>>}
 */
export async function readKeyring(accessToken) {
  const msgs = await searchSystemThread(accessToken, SYSTEM_SUBJECTS.KEYRING, 50);
  const map = new Map();
  for (const msg of msgs) {
    if (msg.body?.email && msg.body?.publicKey) {
      map.set(msg.body.email, msg.body.publicKey);
    }
  }
  return map;
}

/**
 * Read pending [supp-join-request] messages from the shared inbox.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function readJoinRequests(accessToken) {
  const msgs = await searchSystemThread(accessToken, SYSTEM_SUBJECTS.JOIN_REQUEST, 50);
  return msgs.filter(m => m.body?.agentEmail).map(m => ({ ...m.body, _messageId: m.id }));
}

/**
 * Read [supp-revocations] messages from the shared inbox.
 * @param {string} accessToken
 * @returns {Promise<Array>}
 */
export async function readRevocations(accessToken) {
  const msgs = await searchSystemThread(accessToken, SYSTEM_SUBJECTS.REVOCATIONS, 50);
  return msgs.filter(m => m.body?.revokedEmail).map(m => m.body);
}
