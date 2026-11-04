// Supp v2 - Shared Constants
// All magic strings, config defaults, domain names, and intervals

// OAuth
export const OAUTH_CLIENT_ID = '160155536458-tgvt5miooe80o9nvogvc10vkofv70d4p.apps.googleusercontent.com';
export const OAUTH_CLIENT_SECRET = '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';

// Shadow email configuration
export const SHADOW_DOMAIN = 'tkt.suppapp.com';
export const SHADOW_EMAIL_PREFIX = 'tkt-';

// Gmail labels
export const SUPP_LABEL_NAME = 'Supp';

// Yjs/IndexedDB configuration
export const YJS_DB_NAME = 'supp-v2-tickets';

// Gmail OAuth scope (single scope covers all gmail.modify + send operations)
export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.modify'];

// Gmail system thread subjects and label
export const SUPP_SYSTEM_LABEL = 'Supp-System';
export const SYSTEM_SUBJECTS = {
  CONFIG:        '[supp-config]',
  KEYRING:       '[supp-keyring]',
  JOIN_REQUEST:  '[supp-join-request]',
  TOKEN_PACKAGE: '[supp-token-package]',
  REVOCATIONS:   '[supp-revocations]'
};

// Gmail API base URLs (overridden by build-time constants in test builds)
export const GMAIL_API_BASE = typeof __GMAIL_API_BASE__ !== 'undefined'
  ? __GMAIL_API_BASE__
  : 'https://gmail.googleapis.com/gmail/v1';

export const GMAIL_UPLOAD_BASE = typeof __GMAIL_UPLOAD_BASE__ !== 'undefined'
  ? __GMAIL_UPLOAD_BASE__
  : 'https://gmail.googleapis.com/upload/gmail/v1';

// Timing constants
export const HEARTBEAT_INTERVAL_MS = 5000;        // Leader election heartbeat
export const LEADER_TIMEOUT_MS = 15000;           // Dead leader detection
export const INBOX_POLL_INTERVAL_MS = 30000;      // Gmail polling frequency
export const LEADER_CHECK_INTERVAL = 2000;        // Leadership check frequency

// Leader election priorities
export const MAIN_ACCOUNT_PRIORITY = 1000;        // Shared inbox account
export const FIRST_AGENT_PRIORITY = 100;          // First agent starts at 100

// UI limits
export const MAX_THREADS_PER_PAGE = 50;           // InboxSDK hardcoded limit
export const MAX_TAGS_IN_ROW = 3;                 // Tags shown in thread row labels
export const MAX_TAGS_PER_TICKET = 10;            // Maximum tags per ticket

// Filtered view route IDs
export const FILTERED_VIEW_ROUTES = {
  ALL: 'supp-all',
  MINE: 'supp-mine',
  OPEN: 'supp-open',
  PENDING: 'supp-pending',
  SOLVED: 'supp-solved',
  UNASSIGNED: 'supp-unassigned'
};

// License tier configurations
export const LICENSE_TIERS = {
  TRIAL: {
    maxAgents: 3,
    historyDays: 30,
    teamCanned: false,
    export: false
  },
  BASIC: {
    maxAgents: 5,
    historyDays: 90,
    teamCanned: true,
    export: 'csv'
  },
  PRO: {
    maxAgents: 20,
    historyDays: 365,
    teamCanned: true,
    export: 'all'
  }
};
