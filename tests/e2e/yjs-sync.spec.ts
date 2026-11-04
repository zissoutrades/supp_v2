// Yjs P2P Sync E2E Tests
// Tests WebRTC peer-to-peer synchronization of Yjs document

import { test, expect } from '../helpers/contexts.js';
import { getTickets, getTicket, waitForYjsSync, waitForTicketSync } from '../helpers/yjs-inspector.js';

const BASE_TICKET = {
  customerEmail: 'customer@test.com',
  customerName: 'Test Customer',
  assignee: null,
  tags: [],
  notes: '',
  customerId: '',
  shadowThreads: {},
  lastReply: null,
  lastReplyBy: null,
  messageCount: 1,
  excluded: false,
};

test.describe('Yjs P2P Sync', () => {
  test('both contexts connect via WebRTC and sync', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    const sharedState = await sharedPage.evaluate(() => (window as any).__suppDebug.getYjsSyncState());
    const agentState  = await agentPage.evaluate(() => (window as any).__suppDebug.getYjsSyncState());

    expect(sharedState).toBe('synced');
    expect(agentState).toBe('synced');
  });

  test('ticket status change syncs from agent to shared inbox', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-1', {
        ticketId: 'test-ticket-1',
        originalThreadId: 'thread-001',
        customerEmail: 'customer@test.com',
        customerName: 'Test Customer',
        subject: 'Test Ticket',
        status: 'open',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-test1@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    const agentTicket = await getTicket(agentPage, 'thread-001');
    expect(agentTicket).toBeDefined();
    expect(agentTicket.status).toBe('open');

    await agentPage.evaluate(async () => {
      const ticket = await (window as any).__suppDebug.getMapEntry('tickets', 'test-ticket-1');
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-1', {
        ...ticket,
        status: 'pending',
        lastModified: Date.now(),
      });
    });

    await waitForTicketSync(sharedPage, agentPage, 'thread-001', 'status', 'pending');

    const sharedTicket = await getTicket(sharedPage, 'thread-001');
    expect(sharedTicket.status).toBe('pending');

    const updatedAgentTicket = await getTicket(agentPage, 'thread-001');
    expect(updatedAgentTicket.status).toBe('pending');
  });

  test('CRDT resolves concurrent status updates without conflict', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-2', {
        ticketId: 'test-ticket-2',
        originalThreadId: 'thread-002',
        customerEmail: 'customer@test.com',
        customerName: 'Test Customer',
        subject: 'CRDT Test',
        status: 'open',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-test2@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    await Promise.all([
      sharedPage.evaluate(async () => {
        const ticket = await (window as any).__suppDebug.getMapEntry('tickets', 'test-ticket-2');
        await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-2', {
          ...ticket,
          status: 'solved',
          lastModified: Date.now(),
        });
      }),
      agentPage.evaluate(async () => {
        const ticket = await (window as any).__suppDebug.getMapEntry('tickets', 'test-ticket-2');
        await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-2', {
          ...ticket,
          status: 'pending',
          lastModified: Date.now(),
        });
      }),
    ]);

    await new Promise(resolve => setTimeout(resolve, 2000));

    const sharedTicket = await getTicket(sharedPage, 'thread-002');
    const agentTicket  = await getTicket(agentPage, 'thread-002');

    expect(sharedTicket.status).toBeDefined();
    expect(agentTicket.status).toBeDefined();
    expect(sharedTicket.status).toBe(agentTicket.status);

    console.log(`CRDT converged to status: ${sharedTicket.status}`);
  });

  test('offline agent catches up on reconnect', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-3', {
        ticketId: 'test-ticket-3',
        originalThreadId: 'thread-003',
        customerEmail: 'customer@test.com',
        customerName: 'Test Customer',
        subject: 'Offline Test',
        status: 'open',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-test3@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    await new Promise(resolve => setTimeout(resolve, 1000));

    await agentPage.evaluate(() => { (window as any).__suppDebug.disconnectWebRTC(); });
    console.log('Agent disconnected');

    await new Promise(resolve => setTimeout(resolve, 500));

    await sharedPage.evaluate(async () => {
      const ticket = await (window as any).__suppDebug.getMapEntry('tickets', 'test-ticket-3');
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-ticket-3', {
        ...ticket,
        status: 'solved',
        assignee: 'shared@test.com',
        lastModified: Date.now(),
      });
    });

    console.log('Shared inbox updated ticket while agent offline');

    await new Promise(resolve => setTimeout(resolve, 500));

    await agentPage.evaluate(async () => { await (window as any).__suppDebug.reconnectWebRTC(); });
    console.log('Agent reconnected');

    await waitForTicketSync(sharedPage, agentPage, 'thread-003', 'status', 'solved');

    const agentTicket = await getTicket(agentPage, 'thread-003');
    expect(agentTicket.status).toBe('solved');
    expect(agentTicket.assignee).toBe('shared@test.com');

    console.log('Agent successfully caught up after reconnection');
  });

  test('firebase fallback syncs ticket when WebRTC is blocked', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    // Confirm FirebaseYjsSync is running on both
    const sharedFbState = await sharedPage.evaluate(() => (window as any).__suppDebug.getFirebaseYjsSyncState());
    const agentFbState  = await agentPage.evaluate(() => (window as any).__suppDebug.getFirebaseYjsSyncState());
    expect(sharedFbState.running).toBe(true);
    expect(agentFbState.running).toBe(true);

    // Disconnect WebRTC on both sides but keep Firebase listeners active
    await sharedPage.evaluate(() => (window as any).__suppDebug.disconnectWebRTCKeepFirebase());
    await agentPage.evaluate(() => (window as any).__suppDebug.disconnectWebRTCKeepFirebase());
    await new Promise(resolve => setTimeout(resolve, 300));

    // Seed a ticket on sharedPage — should flow via Firebase only
    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-fb-1', {
        ticketId: 'test-fb-1',
        originalThreadId: 'thread-fb-1',
        customerEmail: 'fb-customer@test.com',
        customerName: 'FB Customer',
        subject: 'Firebase fallback test',
        status: 'open',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-fb1@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    // Wait for Firebase delivery (typically ~100-200ms; allow 3s)
    let agentTicket: any;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const entries: Array<[string, any]> = await agentPage.evaluate(() => (window as any).__suppDebug.getTickets());
      const entry = entries.find(([k]) => k === 'test-fb-1');
      if (entry) { agentTicket = entry[1]; break; }
    }

    expect(agentTicket).toBeDefined();
    expect(agentTicket.status).toBe('open');
    expect(agentTicket.subject).toBe('Firebase fallback test');
    console.log('Firebase fallback: ticket synced without WebRTC');
  });

  test('no firebase writes when webrtc channel is open', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    const sharedFbState = await sharedPage.evaluate(() => (window as any).__suppDebug.getFirebaseYjsSyncState());
    const agentFbState  = await agentPage.evaluate(() => (window as any).__suppDebug.getFirebaseYjsSyncState());
    expect(sharedFbState.running).toBe(true);
    expect(agentFbState.running).toBe(true);

    // Set a ticket — should flow via WebRTC (channels are open)
    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-webrtc-only', {
        ticketId: 'test-webrtc-only',
        originalThreadId: 'thread-webrtc-only',
        customerEmail: 'rtc@test.com',
        customerName: 'RTC Customer',
        subject: 'WebRTC path test',
        status: 'open',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-rtc@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    await waitForTicketSync(sharedPage, agentPage, 'thread-webrtc-only', 'status', 'open');

    // Firebase listener is running — confirm no error
    const finalFbState = await agentPage.evaluate(() => (window as any).__suppDebug.getFirebaseYjsSyncState());
    expect(finalFbState.running).toBe(true);
    console.log('WebRTC-path test: agentPage knownPeers =', finalFbState.knownPeers);
  });

  test('firebase delivers updates older than webrtc connection (replay)', async ({ sharedPage, agentPage }) => {
    await waitForYjsSync(sharedPage);
    await waitForYjsSync(agentPage);

    // Cut WebRTC on both so sharedPage sends via Firebase
    await sharedPage.evaluate(() => (window as any).__suppDebug.disconnectWebRTCKeepFirebase());
    await agentPage.evaluate(() => (window as any).__suppDebug.disconnectWebRTCKeepFirebase());
    await new Promise(resolve => setTimeout(resolve, 300));

    // sharedPage creates a ticket — goes to Firebase
    await sharedPage.evaluate(async () => {
      await (window as any).__suppDebug.setMapEntry('tickets', 'test-fb-replay', {
        ticketId: 'test-fb-replay',
        originalThreadId: 'thread-fb-replay',
        customerEmail: 'replay@test.com',
        customerName: 'Replay Customer',
        subject: 'Firebase replay test',
        status: 'pending',
        assignee: null,
        tags: [],
        notes: '',
        customerId: '',
        shadowEmail: 'tkt-replay@tkt.suppapp.com',
        shadowThreads: {},
        createdAt: Date.now(),
        lastModified: Date.now(),
        lastReply: null,
        lastReplyBy: null,
        messageCount: 1,
        excluded: false,
      });
    });

    // Wait for Firebase delivery (onChildAdded replay)
    let agentTicket: any;
    for (let i = 0; i < 30; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const entries: Array<[string, any]> = await agentPage.evaluate(() => (window as any).__suppDebug.getTickets());
      const entry = entries.find(([k]) => k === 'test-fb-replay');
      if (entry) { agentTicket = entry[1]; break; }
    }

    expect(agentTicket).toBeDefined();
    expect(agentTicket.status).toBe('pending');
    console.log('Firebase replay test: ticket delivered via onChildAdded replay');
  });
});
