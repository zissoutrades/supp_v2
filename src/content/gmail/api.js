// Supp v2 - Gmail REST API Wrapper
// Fetch-based wrapper for Gmail API calls from the content script.
// Uses build-time constants for base URLs so test builds redirect to Mockoon.

import { GMAIL_API_BASE, GMAIL_UPLOAD_BASE } from '../../common/constants.js';

export class GmailAPI {
  /**
   * @param {(force?: boolean) => Promise<string>} getTokenFn
   *   Function that returns a valid OAuth access token.
   *   Called with `true` to force a cache-busting refresh on 401.
   */
  constructor(getTokenFn) {
    this._getTokenFn = getTokenFn;
  }

  // ─── Internal request helper ──────────────────────────────────────────────

  async _request(method, url, body = undefined, contentType = undefined, attempt = 0) {
    const token = await this._getTokenFn(attempt > 0);
    const headers = { 'Authorization': `Bearer ${token}` };
    if (contentType) headers['Content-Type'] = contentType;

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? body : undefined,
    });

    if (res.status === 401 && attempt === 0) {
      return this._request(method, url, body, contentType, 1);
    }

    if (res.status === 429 && attempt < 3) {
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
      return this._request(method, url, body, contentType, attempt + 1);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gmail API ${res.status} ${method} ${url}: ${text}`);
    }

    return res.json();
  }

  // ─── API methods ──────────────────────────────────────────────────────────

  /** GET /users/me/profile → { emailAddress, historyId } */
  getProfile() {
    return this._request('GET', `${GMAIL_API_BASE}/users/me/profile`);
  }

  /**
   * GET /users/me/history
   * @param {string|number} startHistoryId
   * @param {{ labelId?: string }} options
   */
  getHistory(startHistoryId, options = {}) {
    const params = new URLSearchParams({
      startHistoryId: String(startHistoryId),
      historyTypes: 'messageAdded',
    });
    if (options.labelId) params.set('labelId', options.labelId);
    return this._request('GET', `${GMAIL_API_BASE}/users/me/history?${params}`);
  }

  /**
   * GET /users/me/messages/{id}
   * @param {string} messageId
   * @param {'full'|'raw'|'metadata'} format
   */
  getMessage(messageId, format = 'full') {
    return this._request('GET', `${GMAIL_API_BASE}/users/me/messages/${messageId}?format=${format}`);
  }

  /** GET /users/me/threads/{id} */
  getThread(threadId) {
    return this._request('GET', `${GMAIL_API_BASE}/users/me/threads/${threadId}`);
  }

  /**
   * POST /upload/…/messages?uploadType=multipart&internalDateSource=dateHeader
   * Inserts a raw RFC 2822 message with label metadata.
   *
   * @param {string} raw  - RFC 2822 formatted message string
   * @param {string[]} labelIds
   * @param {string} [threadId]
   * @returns {Promise<{id, threadId, labelIds}>}
   */
  async insertMessage(raw, labelIds, threadId) {
    const boundary = `supp_${Date.now().toString(36)}`;
    const metadata = { labelIds };
    if (threadId) metadata.threadId = threadId;

    const body = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      '',
      `--${boundary}`,
      'Content-Type: message/rfc822',
      '',
      raw,
      `--${boundary}--`,
    ].join('\r\n');

    const url = `${GMAIL_UPLOAD_BASE}/users/me/messages?uploadType=multipart&internalDateSource=dateHeader`;
    const token = await this._getTokenFn(false);

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });

    if (res.status === 401) {
      // Re-fetch with force=true and retry once
      const freshToken = await this._getTokenFn(true);
      const res2 = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${freshToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`,
        },
        body,
      });
      if (!res2.ok) {
        const text = await res2.text().catch(() => '');
        throw new Error(`Gmail API ${res2.status} insertMessage: ${text}`);
      }
      return res2.json();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Gmail API ${res.status} insertMessage: ${text}`);
    }
    return res.json();
  }

  /**
   * POST /users/me/messages/send
   * @param {string} raw  - RFC 2822 formatted message string (plain, not base64)
   * @param {string} [threadId]
   */
  sendMessage(raw, threadId) {
    // Gmail send requires raw to be base64url encoded
    const encoded = btoa(unescape(encodeURIComponent(raw)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const body = { raw: encoded };
    if (threadId) body.threadId = threadId;
    return this._request('POST', `${GMAIL_API_BASE}/users/me/messages/send`, JSON.stringify(body), 'application/json');
  }

  /** POST /users/me/labels */
  createLabel(name) {
    const body = JSON.stringify({
      name,
      labelListVisibility: 'labelShow',
      messageListVisibility: 'show',
    });
    return this._request('POST', `${GMAIL_API_BASE}/users/me/labels`, body, 'application/json');
  }

  /** GET /users/me/labels */
  getLabels() {
    return this._request('GET', `${GMAIL_API_BASE}/users/me/labels`);
  }

  /** POST /users/me/threads/{id}/modify */
  modifyThread(threadId, addLabelIds, removeLabelIds) {
    const body = JSON.stringify({ addLabelIds, removeLabelIds });
    return this._request('POST', `${GMAIL_API_BASE}/users/me/threads/${threadId}/modify`, body, 'application/json');
  }
}
