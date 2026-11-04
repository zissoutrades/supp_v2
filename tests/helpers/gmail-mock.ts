// Gmail Mock Client - Mockoon Admin API wrapper
// Allows tests to inject emails and assert on API calls made by the extension.

export interface MockMessage {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
}

interface InsertCall {
  headers: Record<string, string>;
  body: string;
  timestamp: string;
}

const MOCK_BASE = 'http://localhost:4001';

export class GmailMockClient {
  private messages: Map<string, MockMessage> = new Map();

  /** Inject a new customer email into the shared inbox mock */
  async injectEmail(msg: MockMessage): Promise<MockMessage> {
    this.messages.set(msg.id, msg);
    const res = await fetch(`${MOCK_BASE}/test/inject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
    if (!res.ok) console.warn(`[GmailMock] inject failed ${res.status}`);
    return msg;
  }

  /** Reset all mock state to empty */
  async reset(): Promise<void> {
    this.messages.clear();
    const res = await fetch(`${MOCK_BASE}/test/reset`, { method: 'POST' });
    if (!res.ok) console.warn(`[GmailMock] reset failed ${res.status}`);
  }

  /**
   * Get all POST requests made to the shadow email insert endpoint.
   * Reads from Mockoon's transaction log API.
   */
  async getInsertCalls(): Promise<InsertCall[]> {
    try {
      const res = await fetch(`${MOCK_BASE}/test/inserts`);
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  }

  async getSendCalls(): Promise<InsertCall[]> {
    try {
      const res = await fetch(`${MOCK_BASE}/test/sends`);
      if (!res.ok) return [];
      return res.json();
    } catch { return []; }
  }

  getInjectedMessages(): MockMessage[] {
    return Array.from(this.messages.values());
  }

  private _buildGmailMessageObject(msg: MockMessage): object {
    const date = msg.date ?? new Date().toUTCString();
    return {
      id: msg.id,
      threadId: msg.threadId,
      labelIds: ['INBOX', 'UNREAD'],
      snippet: msg.body.slice(0, 100),
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: msg.from },
          { name: 'To', value: msg.to },
          { name: 'Subject', value: msg.subject },
          { name: 'Date', value: date },
          { name: 'Message-ID', value: `<${msg.id}@test.com>` },
        ],
        body: {
          data: Buffer.from(msg.body).toString('base64url'),
          size: msg.body.length,
        },
      },
    };
  }
}

/** Convenience factory for tests */
export function createMockEmail(overrides: Partial<MockMessage> = {}): MockMessage {
  const id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return {
    id,
    threadId: `thread-${id}`,
    from: 'customer@example.com',
    to: 'shared@test.com',
    subject: 'Test support request',
    body: 'Hi, I need help with my order.',
    ...overrides,
  };
}
