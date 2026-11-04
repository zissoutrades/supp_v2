// Supp v2 - Yjs Document
// Single Y.Doc instance shared across all content script modules
// IMPORTANT: This is the only place where Y.Doc is instantiated

import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';

console.log('[Supp Yjs] Creating Yjs document...');

/**
 * The single Yjs document instance for this agent
 * All modules import this same instance
 */
export const ydoc = new Y.Doc();

/**
 * Shared maps and arrays
 * These are the CRDT data structures that sync across all agents
 */

// Ticket metadata - keyed by ticket ID (tkt-{nanoid})
export const tickets = ydoc.getMap('tickets');

// Team configuration - shadow domain, intervals, etc.
export const config = ydoc.getMap('config');

// Agent presence — ephemeral, high-frequency state (not persisted to IndexedDB,
// not included in Yjs state vectors, no CRDT tombstone accumulation).
export const awareness = new Awareness(ydoc);

// Team-shared canned response library
export const cannedResponses = ydoc.getMap('cannedResponses');

// Outbound reply queue - pending replies to be sent by the leader
export const replyQueue = ydoc.getArray('replyQueue');

// In-session encrypted token transfers between online peers
// key: "<fromEmail>→<toEmail>", value: { encryptedKey, iv, ciphertext, fromEmail, toEmail, timestamp }
// Entries deleted by recipient immediately after decryption (self-cleaning)
export const tokenExchange = ydoc.getMap('tokenExchange');

// Append-only event log
export const auditLog = ydoc.getArray('auditLog');

console.log('[Supp Yjs] Yjs document created with shared maps:', {
  tickets: tickets.size,
  config: config.size,
  cannedResponses: cannedResponses.size,
  replyQueue: replyQueue.length
});
