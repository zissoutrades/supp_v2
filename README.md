# Supp v2

**Dormant prototype. Not maintained, no support, no hosted backend.** Built in early 2026 to about 90% of an MVP and then abandoned. Published as a working reference, not as a product.

A Chrome extension that turns a shared Gmail inbox into a lightweight support desk for small teams. The conversations stay in Gmail; the ticket state — assignee, status, tags, notes — syncs peer-to-peer between the agents' browsers. No helpdesk server, no ticket database in anyone's cloud.

## What works

- **Shadow emails.** The elected leader polls the shared inbox and inserts a per-ticket copy into every agent's Gmail under a placeholder sender, `tkt-<ticket-id>@tkt.suppapp.com`, which never receives real mail. Agents reply in their own Gmail and the extension intercepts the send; the leader dispatches it from the shared address.
- **Peer-to-peer sync.** Ticket state is a Yjs CRDT replicated over WebRTC and persisted in IndexedDB. Firebase RTDB carries signalling, presence and leader heartbeats only — ticket metadata never touches it.
- **Leader election.** Five-second heartbeats, fifteen-second timeout, priority-based, deterministic tie-breaking. Any instance can take over; the shared-inbox OAuth refresh token is distributed during onboarding, RSA-4096-wrapped in transit and AES-256-GCM encrypted at rest.
- **Onboarding.** Team setup, invite emails, key exchange, and encrypted token distribution through Gmail system threads.
- **UI inside Gmail.** Side panel with status, assignee, tags, notes and customer id; six filtered views; thread-row labels; compose buttons for *Send + Solved*, *Send + Open* and *Not a ticket*; fuzzy tag search; personal and team-shared canned responses.
- **Fallback transport.** A Firebase-backed Yjs transport for peers that cannot establish WebRTC (newly landed at the end of the project, not battle-tested).

## What is partial

- Onboarding UX — functional, verified on two machines, but with rough edges around duplicate logins and modal/panel placement.
- The Firebase fallback transport above.

## What was never built

Monetisation (licence validation, activation, payments), Cloud Relay / always-on inbox monitoring, analytics, custom fields, export, an AI assistant, mobile, and webhooks. Design specs existed for most of these; no code does.

## Architecture

Chrome MV3. All stateful logic lives in the content script — the Yjs document, the WebRTC mesh, the InboxSDK UI — because the service worker is torn down after 30 seconds idle; the service worker only handles OAuth (PKCE, no client secret) and alarms. The elected leader reads the shared inbox through the Gmail History API and inserts shadow messages with each agent's own OAuth token. Refresh tokens stay in each browser, encrypted at rest; no server ever sees them. Each team provisions its own Firebase project for signalling, so there is nothing for the author to host or shut down.

## Running it

Requires Node and npm.

```bash
npm install
npm run build          # webpack -> dist/
```

Then load `dist/` as an unpacked extension in Chrome (chrome://extensions, Developer mode). A working install needs a Google Cloud OAuth client with Gmail scopes and a Firebase Realtime Database project for signalling; both are supplied by whoever runs it. There is no hosted instance.

## Tests

```bash
npm test
```

This builds a test extension, starts a local mock of the Gmail API, and runs a Playwright suite (9 spec files, 31 cases) covering the shadow pipeline, sync, leader election, reply flow, views, side panel, canned responses and tags.

**Known limitation: the suite is flaky.** Playwright reuses Chrome profiles between runs and IndexedDB state accumulates, so individual specs pass while full runs fail. Delete the browser-profile directory between runs, or run specs one at a time. The product itself was verified manually on two machines on different networks, which is the evidence this prototype actually worked.

The suite also needs a test Firebase project and manually captured Gmail OAuth tokens in `.env.test`; that file is not included.

## Status

The test Firebase project used during development is gone. Expect to provision your own before anything runs. There is no Chrome Web Store listing and no purchase flow.

## License

[PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0). Free to use, modify and share for any noncommercial purpose; forks and experiments are welcome. **Commercial use requires a written licence** — contact [@zissoutrades](https://github.com/zissoutrades) on GitHub. Provided as is, without warranty.

Required Notice: Copyright 2026 Denis Critco