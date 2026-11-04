// Supp v2 - Service Worker
// Thin service worker that handles:
// 1. InboxSDK pageWorld.js injection (required for InboxSDK to work properly)
// 2. Message relay between content script and popup
// 3. Extension lifecycle events

console.log('[Supp SW] Service worker starting...');

// InboxSDK pageWorld injection handler
// This is CRITICAL - without this, InboxSDK features like handleCustomListRoute silently fail
// See PoC 3 findings in PoC_test_findings.md
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'inboxsdk__injectPageWorld') {
    console.log('[Supp SW] InboxSDK pageWorld injection requested');

    if (!sender.tab?.id) {
      console.error('[Supp SW] No tab ID for injection');
      sendResponse({ success: false, error: 'No tab ID' });
      return;
    }

    console.log('[Supp SW] Injecting pageWorld.js into tab', sender.tab.id);

    // Inject our bundled pageWorld.js file
    chrome.scripting.executeScript({
      target: { tabId: sender.tab.id },
      world: 'MAIN',
      files: ['pageWorld.js']
    })
      .then(() => {
        console.log('[Supp SW] InboxSDK pageWorld.js injected successfully');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('[Supp SW] InboxSDK pageWorld.js injection failed:', error);
        sendResponse({ success: false, error: error.message });
      });

    // Keep message channel open for async response
    return true;
  }

  // Get Google OAuth token for Firebase authentication
  if (message.type === 'GET_AUTH_TOKEN') {
    console.log('[Supp SW] Getting OAuth token for Firebase auth');
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        console.error('[Supp SW] OAuth token error:', chrome.runtime.lastError);
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        console.log('[Supp SW] OAuth token obtained');
        sendResponse({ success: true, token });
      }
    });
    return true;
  }

  // Get current Chrome user's email for leader election.
  // Stored agentEmail takes priority (set by test fixture or manual SW config paste).
  // Falls back to chrome.identity for production use when no stored email is present.
  if (message.type === 'GET_USER_EMAIL') {
    chrome.storage.local.get(['agentEmail'], (result) => {
      if (result.agentEmail) {
        sendResponse({ success: true, email: result.agentEmail });
      } else {
        chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
          sendResponse({ success: true, email: info?.email || null });
        });
      }
    });
    return true;
  }

  // Launch PKCE OAuth flow. Generates code_verifier/challenge here (in SW where
  // crypto is available), launches launchWebAuthFlow, returns { code, codeVerifier, redirectUri }.
  // The content script then calls EXCHANGE_AUTH_CODE to complete the exchange.
  if (message.type === 'LAUNCH_OAUTH_PKCE') {
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest.oauth2?.client_id;
    if (!clientId) {
      sendResponse({ success: false, error: 'OAuth client_id not configured in manifest' });
      return true;
    }

    // Wrap in async IIFE — must return true synchronously to keep channel open
    (async () => {
      // Generate PKCE code_verifier (43 random chars, base64url)
      const verifierBytes = crypto.getRandomValues(new Uint8Array(32));
      const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

      // code_challenge = BASE64URL(SHA-256(code_verifier))
      const challengeBuffer = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(codeVerifier)
      );
      const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

      const redirectUri = chrome.identity.getRedirectURL();
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email https://www.googleapis.com/auth/gmail.modify',
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        ...(message.loginHint ? { login_hint: message.loginHint } : {})
      });

      const authUrl = `https://accounts.google.com/o/oauth2/auth?${params}`;

      chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true }, (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'OAuth cancelled' });
          return;
        }
        const code = new URL(redirectUrl).searchParams.get('code');
        if (!code) {
          sendResponse({ success: false, error: 'No authorization code in redirect URL' });
          return;
        }
        sendResponse({ success: true, code, codeVerifier, redirectUri });
      });
    })();

    return true;
  }

  // Exchange authorization code + code_verifier for tokens.
  // Returns { access_token, refresh_token, expires_in }.
  if (message.type === 'EXCHANGE_AUTH_CODE') {
    const manifest = chrome.runtime.getManifest();
    const clientId = manifest.oauth2?.client_id;
    // Web application OAuth clients require client_secret in the code exchange.
    // This is an accepted pattern for Chrome extensions — the secret is not
    // truly secret but Google permits it for extension distribution.
    const CLIENT_SECRET = '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';

    fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: message.code,
        client_id: clientId,
        client_secret: CLIENT_SECRET,
        redirect_uri: message.redirectUri,
        code_verifier: message.codeVerifier,
        grant_type: 'authorization_code'
      })
    }).then(r => r.json()).then(tokens => {
      if (tokens.error) {
        sendResponse({ success: false, error: tokens.error_description || tokens.error });
      } else {
        sendResponse({ success: true, tokens });
      }
    }).catch(err => sendResponse({ success: false, error: err.message }));

    return true;
  }

  // Get current Chrome profile user info (email + display name).
  if (message.type === 'GET_USER_INFO') {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      sendResponse({ success: true, email: info?.email || null, name: info?.id || null });
    });
    return true;
  }

  // Get OAuth token interactively (prompts login if needed).
  if (message.type === 'GET_AUTH_TOKEN_INTERACTIVE') {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, token });
      }
    });
    return true;
  }

  // Search Gmail messages using the Gmail API query syntax.
  // message.accessToken — the bearer token for the account to search
  // message.query — Gmail search query string
  // message.maxResults — optional, defaults to 20
  // Returns { messages: [{ id, threadId }] }
  if (message.type === 'GMAIL_SEARCH') {
    const params = new URLSearchParams({
      q: message.query,
      maxResults: String(message.maxResults || 20)
    });
    fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, {
      headers: { 'Authorization': `Bearer ${message.accessToken}` }
    }).then(r => r.json()).then(data => {
      sendResponse({ success: true, messages: data.messages || [] });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // Get Chrome profile user info (for storage key derivation).
  // Returns { id, email } where id is the stable Chrome profile ID.
  if (message.type === 'GET_PROFILE_USER_INFO') {
    chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, (info) => {
      sendResponse({ success: true, id: info?.id || '', email: info?.email || '' });
    });
    return true;
  }

  // Set Firebase config (for manual testing)
  if (message.type === 'SET_CONFIG') {
    console.log('[Supp SW] Setting Firebase config');
    chrome.storage.local.set(message.data, () => {
      console.log('[Supp SW] Config saved successfully');
      sendResponse({ success: true });
    });
    return true;
  }

  // Message relay for popup queries
  if (message.type === 'GET_STATE' && message.target === 'content') {
    // Find Gmail tabs and forward the message
    chrome.tabs.query({ url: 'https://mail.google.com/*' }, (tabs) => {
      if (tabs.length === 0) {
        sendResponse({ error: 'No Gmail tab open' });
        return;
      }

      // Send to first Gmail tab
      chrome.tabs.sendMessage(tabs[0].id, message, (response) => {
        if (chrome.runtime.lastError) {
          sendResponse({ error: chrome.runtime.lastError.message });
        } else {
          sendResponse(response);
        }
      });
    });

    return true;
  }
});

// Extension lifecycle logging
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    console.log('[Supp SW] Extension installed');
  } else if (details.reason === 'update') {
    console.log('[Supp SW] Extension updated from', details.previousVersion, 'to', chrome.runtime.getManifest().version);
  }
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Supp SW] Browser startup - service worker activated');
});

console.log('[Supp SW] Service worker initialized');
