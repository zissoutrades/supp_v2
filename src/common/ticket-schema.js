// Supp v2 - Ticket Schema
// Functions for creating and validating TicketMetadata objects

import { MAX_TAGS_PER_TICKET } from './constants.js';

/**
 * Valid ticket status values
 */
export const VALID_STATUSES = ['open', 'pending', 'solved'];

/**
 * Create a default ticket object with optional overrides
 * @param {Partial<TicketMetadata>} overrides - Fields to override
 * @returns {TicketMetadata} Complete ticket metadata object
 */
export function createDefaultTicket(overrides = {}) {
  const now = Date.now();

  return {
    ticketId: '',
    originalThreadId: '',
    customerEmail: '',
    customerName: '',
    subject: '',
    status: 'open',
    assignee: null,
    tags: [],
    notes: '',
    customerId: '',
    shadowEmail: '',
    originalMessageId: '',
    shadowThreads: {},
    createdAt: now,
    lastModified: now,
    lastReply: null,
    lastReplyBy: null,
    messageCount: 0,
    excluded: false,
    ...overrides
  };
}

/**
 * Validate a ticket object
 * @param {any} ticket - Object to validate
 * @returns {{ valid: boolean, errors: string[] }} Validation result
 */
export function validateTicket(ticket) {
  const errors = [];

  // Check required fields exist
  const requiredFields = [
    'ticketId',
    'originalThreadId',
    'customerEmail',
    'subject',
    'status',
    'shadowEmail',
    'createdAt'
  ];

  for (const field of requiredFields) {
    if (ticket[field] === undefined || ticket[field] === null || ticket[field] === '') {
      // Allow empty string for some fields but not critical ones
      if (['ticketId', 'originalThreadId', 'status', 'shadowEmail'].includes(field)) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Validate status is one of the allowed values
  if (ticket.status && !VALID_STATUSES.includes(ticket.status)) {
    errors.push(`Invalid status: ${ticket.status}. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  // Validate tags is an array
  if (ticket.tags !== undefined && ticket.tags !== null) {
    if (!Array.isArray(ticket.tags)) {
      errors.push('tags must be an array');
    } else if (ticket.tags.length > MAX_TAGS_PER_TICKET) {
      errors.push(`Too many tags: ${ticket.tags.length}. Maximum is ${MAX_TAGS_PER_TICKET}`);
    }
  }

  // Validate shadowThreads is an object
  if (ticket.shadowThreads !== undefined && ticket.shadowThreads !== null) {
    if (typeof ticket.shadowThreads !== 'object' || Array.isArray(ticket.shadowThreads)) {
      errors.push('shadowThreads must be an object');
    }
  }

  // Validate boolean fields
  if (ticket.excluded !== undefined && typeof ticket.excluded !== 'boolean') {
    errors.push('excluded must be a boolean');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
