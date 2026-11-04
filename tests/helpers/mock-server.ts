/**
 * Gmail API Mock Server
 *
 * Replaces Mockoon. Handles all Gmail API endpoints the extension uses.
 * Also exposes test-control endpoints so Playwright helpers can inject
 * emails and read captured calls without an external admin API.
 *
 * Gmail base:   http://localhost:4001/gmail/v1
 * Upload base:  http://localhost:4001/upload/gmail/v1
 * Test control: http://localhost:4001/test/*
 */

import http from 'http';
import { IncomingMessage, ServerResponse } from 'http';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Email {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
}

interface CapturedCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
  timestamp: string;
}

// ── In-memory state ───────────────────────────────────────────────────────────

const state = {
  emails: new Map<string, Email>(),
  insertCalls: [] as CapturedCall[],   // POST /upload/.../messages (shadow inserts)
  sendCalls:   [] as CapturedCall[],   // POST .../messages/send (reply dispatch)
  historyId:   1000,                   // Monotonic counter — increments on each inject
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', chunk => { buf += chunk; });
    req.on('end', () => resolve(buf));
  });
}

function send(res: ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function buildGmailMessage(email: Email) {
  const date = email.date ?? new Date().toUTCString();
  return {
    id: email.id,
    threadId: email.threadId,
    labelIds: ['INBOX', 'UNREAD'],
    snippet: email.body.slice(0, 100),
    historyId: String(state.historyId),
    internalDate: String(Date.now()),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'From',       value: email.from },
        { name: 'To',         value: email.to },
        { name: 'Subject',    value: email.subject },
        { name: 'Date',       value: date },
        { name: 'Message-ID', value: `<${email.id}@test.com>` },
      ],
      body: {
        data: Buffer.from(email.body).toString('base64url'),
        size: email.body.length,
      },
    },
  };
}

// ── Request router ────────────────────────────────────────────────────────────

async function handle(req: IncomingMessage, res: ServerResponse) {
  const method = req.method?.toUpperCase() ?? 'GET';
  const url    = new URL(req.url ?? '/', 'http://localhost');
  const p      = url.pathname;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
    return res.end();
  }

  // ── Health / root ──────────────────────────────────────────────────────────
  if (p === '/' || p === '') return send(res, 200, { ok: true, server: 'gmail-mock' });

  // ── Test control endpoints ─────────────────────────────────────────────────

  // POST /test/inject — add an email to the mock inbox
  if (method === 'POST' && p === '/test/inject') {
    const body  = await readBody(req);
    const email = JSON.parse(body) as Email;
    state.emails.set(email.id, email);
    state.historyId += 1;
    console.log(`[MockServer] Injected email ${email.id} (historyId now ${state.historyId})`);
    return send(res, 200, { ok: true, historyId: state.historyId });
  }

  // POST /test/reset — clear all state
  if (method === 'POST' && p === '/test/reset') {
    state.emails.clear();
    state.insertCalls = [];
    state.sendCalls   = [];
    state.historyId   = 1000;
    console.log('[MockServer] State reset');
    return send(res, 200, { ok: true });
  }

  // GET /test/inserts — return captured shadow insert calls
  if (method === 'GET' && p === '/test/inserts') {
    return send(res, 200, state.insertCalls);
  }

  // GET /test/sends — return captured send-to-customer calls
  if (method === 'GET' && p === '/test/sends') {
    return send(res, 200, state.sendCalls);
  }

  // ── Gmail API: User profile ────────────────────────────────────────────────
  // GET /gmail/v1/users/me/profile
  if (method === 'GET' && p === '/gmail/v1/users/me/profile') {
    return send(res, 200, {
      emailAddress: 'test@example.com',
      messagesTotal: state.emails.size,
      threadsTotal:  state.emails.size,
      historyId:     String(state.historyId),
    });
  }

  // ── Gmail API: History ────────────────────────────────────────────────────
  // GET /gmail/v1/users/me/history?startHistoryId=X&...
  if (method === 'GET' && p === '/gmail/v1/users/me/history') {
    const startId = parseInt(url.searchParams.get('startHistoryId') ?? '0', 10);
    // Return history entries for all emails injected after startId
    const entries = Array.from(state.emails.values())
      .filter(() => state.historyId > startId)   // simple: return all if anything changed
      .map(email => ({
        id:            String(state.historyId),
        messages:      [{ id: email.id, threadId: email.threadId, labelIds: ['INBOX', 'UNREAD'] }],
        messagesAdded: [{ message: { id: email.id, threadId: email.threadId, labelIds: ['INBOX', 'UNREAD'] } }],
      }));
    return send(res, 200, { history: entries, historyId: String(state.historyId) });
  }

  // ── Gmail API: Labels ──────────────────────────────────────────────────────
  // GET /gmail/v1/users/me/labels
  if (method === 'GET' && p === '/gmail/v1/users/me/labels') {
    return send(res, 200, {
      labels: [
        { id: 'INBOX', name: 'INBOX', type: 'system' },
        { id: 'UNREAD', name: 'UNREAD', type: 'system' },
        { id: 'SENT', name: 'SENT', type: 'system' },
      ],
    });
  }

  // POST /gmail/v1/users/me/labels
  if (method === 'POST' && p === '/gmail/v1/users/me/labels') {
    const body = JSON.parse(await readBody(req));
    return send(res, 200, { id: `label-${Date.now()}`, name: body.name, type: 'user' });
  }

  // ── Gmail API: Messages ────────────────────────────────────────────────────
  // GET /gmail/v1/users/me/messages/:id
  const msgMatch = p.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
  if (method === 'GET' && msgMatch) {
    const email = state.emails.get(msgMatch[1]);
    if (!email) return send(res, 404, { error: { code: 404, message: 'Not Found' } });
    return send(res, 200, buildGmailMessage(email));
  }

  // POST /gmail/v1/users/me/messages/send
  if (method === 'POST' && p === '/gmail/v1/users/me/messages/send') {
    const body = await readBody(req);
    state.sendCalls.push({
      method: 'POST', path: p,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body, timestamp: new Date().toISOString(),
    });
    const id = `sent-${Date.now()}`;
    return send(res, 200, { id, threadId: `thread-${id}`, labelIds: ['SENT'] });
  }

  // POST /gmail/v1/users/me/messages/modify (label modification)
  if (method === 'POST' && p.endsWith('/modify') && p.includes('/messages/')) {
    return send(res, 200, { id: 'ok', labelIds: ['INBOX'] });
  }

  // ── Gmail API: Threads ────────────────────────────────────────────────────
  // GET /gmail/v1/users/me/threads/:id
  const thdMatch = p.match(/^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/);
  if (method === 'GET' && thdMatch) {
    const threadId = thdMatch[1];
    const msgs = Array.from(state.emails.values()).filter(e => e.threadId === threadId);
    if (!msgs.length) return send(res, 404, { error: { code: 404, message: 'Not Found' } });
    return send(res, 200, {
      id:        threadId,
      historyId: String(state.historyId),
      messages:  msgs.map(buildGmailMessage),
    });
  }

  // POST /gmail/v1/users/me/threads/:id/modify
  if (method === 'POST' && p.endsWith('/modify') && p.includes('/threads/')) {
    return send(res, 200, { id: p.split('/')[8], historyId: String(state.historyId) });
  }

  // ── Gmail Upload API: Insert (shadow emails) ──────────────────────────────
  // POST /upload/gmail/v1/users/me/messages?uploadType=multipart
  if (method === 'POST' && p === '/upload/gmail/v1/users/me/messages') {
    const body = await readBody(req);
    state.insertCalls.push({
      method: 'POST', path: p,
      headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
      body, timestamp: new Date().toISOString(),
    });
    const id = `inserted-${Date.now()}`;
    console.log(`[MockServer] Shadow insert captured (total: ${state.insertCalls.length})`);
    return send(res, 200, { id, threadId: `shadow-thread-${id}`, labelIds: ['INBOX', 'UNREAD'] });
  }

  // ── Fallback ──────────────────────────────────────────────────────────────
  console.warn(`[MockServer] Unhandled ${method} ${p}`);
  return send(res, 404, { error: { code: 404, message: `Cannot ${method} ${p}` } });
}

// ── Start server ──────────────────────────────────────────────────────────────

const PORT = 4001;
const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('[MockServer] Error:', err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: String(err) }));
  });
});

server.listen(PORT, () => {
  console.log(`[MockServer] Gmail mock listening on port ${PORT}`);
});

process.on('SIGTERM', () => server.close());
process.on('SIGINT',  () => server.close());
