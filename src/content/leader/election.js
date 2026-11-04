// Supp v2 - Leader Election
// Distributed leader election using Yjs Awareness as a shared ephemeral heartbeat store.
// Awareness is NOT persisted to IndexedDB and NOT included in Yjs state vectors,
// so it never accumulates CRDT tombstones (unlike Y.Map presence).
//
// Algorithm: Each agent writes its awareness state every HEARTBEAT_INTERVAL_MS.
// Every LEADER_CHECK_INTERVAL ms (and on any awareness change), each agent runs the
// election: alive agents sorted by priority desc, agentId asc. The winner is leader.
// This is deterministic — no coordination needed.

const MAIN_ACCOUNT_PRIORITY = 1000;
const DEFAULT_HEARTBEAT_INTERVAL = 5000;  // ms
const DEFAULT_LEADER_TIMEOUT = 15000;     // ms — agent considered dead after this
const LEADER_CHECK_INTERVAL = 2000;       // ms

export class LeaderElection {
  /**
   * @param {import('y-protocols/awareness').Awareness} awareness
   * @param {string} agentId - stable nanoid, persisted in chrome.storage
   * @param {string} agentEmail - this agent's Gmail address
   * @param {object} teamConfig - team config from chrome.storage
   */
  constructor(awareness, agentId, agentEmail, teamConfig) {
    this.awareness = awareness;
    this.agentId = agentId;
    this.agentEmail = agentEmail;
    this.teamConfig = teamConfig;

    this.HEARTBEAT_INTERVAL = teamConfig?.settings?.leaderHeartbeatInterval ?? DEFAULT_HEARTBEAT_INTERVAL;
    this.LEADER_TIMEOUT = teamConfig?.settings?.leaderTimeout ?? DEFAULT_LEADER_TIMEOUT;

    this.isLeader = false;
    this._stopped = false;
    this._becomeLeaderGen = 0;
    this._hasEverSeenLivePeer = false;
    this.heartbeatInterval = null;
    this.checkInterval = null;
    this.onBecomeLeader = null;
    this.onStepDown = null;
    this._tokenManager = null;

    this._onPresenceChange = () => this.checkAndClaimLeadership();
    this._onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        this.announcePresence();
        this.checkAndClaimLeadership();
      }
    };
  }

  calculatePriority() {
    if (this.agentEmail === this.teamConfig?.sharedInboxEmail) {
      return MAIN_ACCOUNT_PRIORITY;
    }
    return this.teamConfig?.agentPriority ?? 100;
  }

  announcePresence() {
    if (this._stopped) return;
    this.awareness.setLocalState({
      agentId: this.agentId,
      email: this.agentEmail,
      lastSeen: Date.now(),
      isLeader: this.isLeader,
      priority: this.calculatePriority(),
      tokenVersions: this._knownTokenEmails || []
    });
  }

  /** Update the list of emails whose tokens this agent holds (for tokenVersions in presence). */
  setKnownTokenEmails(emails) {
    this._knownTokenEmails = emails;
  }

  start() {
    console.log(`[Supp] Leader election started — agentId=${this.agentId} email=${this.agentEmail}`);
    this._stopped = false;

    this.announcePresence();

    this.heartbeatInterval = setInterval(() => this.announcePresence(), this.HEARTBEAT_INTERVAL);
    this.checkInterval = setInterval(() => this.checkAndClaimLeadership(), LEADER_CHECK_INTERVAL);

    this.awareness.on('change', this._onPresenceChange);
    document.addEventListener('visibilitychange', this._onVisibilityChange);

    this.checkAndClaimLeadership();
  }

  stop() {
    this._stopped = true;

    clearInterval(this.heartbeatInterval);
    clearInterval(this.checkInterval);
    this.heartbeatInterval = null;
    this.checkInterval = null;

    // Unregister BEFORE setLocalState(null) so the removal doesn't retrigger us
    this.awareness.off('change', this._onPresenceChange);
    document.removeEventListener('visibilitychange', this._onVisibilityChange);

    const wasLeader = this.isLeader;
    this.isLeader = false;
    // setLocalState(null) removes our entry and propagates the removal to peers
    this.awareness.setLocalState(null);

    if (wasLeader) {
      this.onStepDown?.();
    }

    console.log('[Supp] Leader election stopped');
  }

  checkAndClaimLeadership() {
    if (this._stopped) return;

    const now = Date.now();
    const allStates = [...this.awareness.getStates().values()];

    // Alive = heartbeated within LEADER_TIMEOUT
    const alive = allStates.filter(s => s && now - s.lastSeen < this.LEADER_TIMEOUT);

    // One-way latch — once set, failover elections are allowed.
    if (alive.some(s => s.agentId !== this.agentId)) {
      this._hasEverSeenLivePeer = true;
    }

    if (alive.length === 0) {
      // Our awareness state may have been removed by the auto-timeout.
      // Re-assert so the next tick finds us.
      this.announcePresence();
      return;
    }

    const aliveLeaders = alive.filter(s => s.isLeader);
    if (aliveLeaders.length > 1) {
      console.warn('[Supp] Split-brain detected — resolving via election');
    }

    // Election: highest priority wins; agentId ascending as tiebreaker
    const candidates = [...alive].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.agentId.localeCompare(b.agentId);
    });

    const winnerId = candidates[0].agentId;

    if (winnerId === this.agentId && !this.isLeader) {
      this.becomeLeader();
    } else if (winnerId !== this.agentId && this.isLeader) {
      this.stepDown();
    }
  }

  async becomeLeader() {
    if (this._stopped) return;

    const gen = ++this._becomeLeaderGen;

    if (this._tokenManager) {
      const sharedInboxEmail = this.teamConfig?.sharedInboxEmail;
      if (sharedInboxEmail) {
        const hasToken = await this._tokenManager.hasRefreshToken(sharedInboxEmail);
        if (this._stopped || this._becomeLeaderGen !== gen) return;
        if (!hasToken) {
          console.warn('[Supp] Cannot become leader — no shared inbox token. Stepping down.');
          this.awareness.setLocalState({
            agentId: this.agentId,
            email: this.agentEmail,
            lastSeen: 0,
            isLeader: false,
            priority: 0,
            tokenVersions: []
          });
          return;
        }

        const allEmails = await this._tokenManager.listStoredEmails();
        if (this._stopped || this._becomeLeaderGen !== gen) return;
        const agentEmails = [...this.awareness.getStates().values()]
          .filter(s => s?.email && s.email !== sharedInboxEmail && s.email !== this.agentEmail)
          .map(s => s.email);
        const missing = agentEmails.filter(e => !allEmails.includes(e));
        if (missing.length > 0) {
          console.warn('[Supp] Missing tokens for:', missing.join(', '), '— their shadows won\'t update');
        }
      }
    }

    if (this.agentEmail !== this.teamConfig?.sharedInboxEmail) {
      if (!this._hasEverSeenLivePeer) {
        console.log('[Supp] Agent deferring leadership — no live peers seen yet, waiting for sync');
        return;
      }
    }

    if (this._stopped || this._becomeLeaderGen !== gen) return;
    this.isLeader = true;
    this.announcePresence();
    console.log('[Supp] BECAME LEADER');
    this.onBecomeLeader?.();
  }

  stepDown() {
    if (this._stopped || !this.isLeader) return;
    this._becomeLeaderGen++;
    this.isLeader = false;
    this.announcePresence();
    console.log('[Supp] STEPPED DOWN as leader');
    this.onStepDown?.();
  }

  setOnBecomeLeader(fn) { this.onBecomeLeader = fn; }
  setOnStepDown(fn) { this.onStepDown = fn; }
  setTokenManager(tm) { this._tokenManager = tm; }
}
