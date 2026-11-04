// Supp v2 - Utility Functions

import { nanoid } from 'nanoid';

/**
 * Generate a random ID using nanoid
 * @param {number} [size=10] - Length of the ID
 * @returns {string} Random ID
 */
export function generateId(size = 10) {
  return nanoid(size);
}

/**
 * Generate a ticket ID with "tkt-" prefix
 * @returns {string} Ticket ID (e.g., "tkt-a1b2c3d4e5f6")
 */
export function generateTicketId() {
  return `tkt-${nanoid(12)}`;
}

/**
 * Encode a string to base64url format (RFC 4648)
 * Used for Gmail API raw message format
 * @param {string} str - String to encode
 * @returns {string} Base64url encoded string
 */
export function base64UrlEncode(str) {
  const base64 = btoa(unescape(encodeURIComponent(str)));
  return base64
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Format a Date object as RFC 2822 date string
 * Used for email Date header
 * @param {Date} date - Date to format
 * @returns {string} RFC 2822 formatted date (e.g., "Mon, 03 Mar 2026 10:00:00 +0000")
 */
export function formatRfc2822Date(date) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const dayName = days[date.getUTCDay()];
  const day = String(date.getUTCDate()).padStart(2, '0');
  const month = months[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');

  return `${dayName}, ${day} ${month} ${year} ${hours}:${minutes}:${seconds} +0000`;
}

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
