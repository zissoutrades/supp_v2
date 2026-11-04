// Supp v2 - PKCE OAuth helpers
// Content-script side: builds auth URLs and exchanges codes for tokens.
// The actual launchWebAuthFlow + code_verifier generation runs in the SW (LAUNCH_OAUTH_PKCE).

import { OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET } from '../../common/constants.js';

/**
 * Send a message to the service worker.
 */
function swMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (response?.success === false) reject(new Error(response.error || 'SW error'));
      else resolve(response);
    });
  });
}

/**
 * Launch the PKCE OAuth flow for a Google account.
 *
 * Delegates to the service worker (LAUNCH_OAUTH_PKCE) which:
 *   - generates code_verifier + code_challenge
 *   - calls chrome.identity.launchWebAuthFlow
 *   - returns { code, codeVerifier, redirectUri }
 *
 * Then exchanges the code for tokens via EXCHANGE_AUTH_CODE.
 *
 * @param {string} [loginHint] - pre-fill the Google sign-in email
 * @returns {Promise<{ accessToken: string, refreshToken: string, expiresIn: number, email: string }>}
 */
export async function launchOAuthPkce(loginHint) {
  const { code, codeVerifier, redirectUri } = await swMessage({
    type: 'LAUNCH_OAUTH_PKCE',
    loginHint
  });

  const { tokens } = await swMessage({
    type: 'EXCHANGE_AUTH_CODE',
    code,
    codeVerifier,
    redirectUri
  });

  // Decode the id_token JWT payload to extract the authenticated email
  let email = loginHint || null;
  if (tokens.id_token) {
    try {
      const payload = JSON.parse(atob(tokens.id_token.split('.')[1]));
      email = payload.email || email;
    } catch {
      // id_token parse failed — email stays as loginHint or null
    }
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresIn: tokens.expires_in,
    email
  };
}

/**
 * Exchange a stored refresh token for a fresh access token.
 * No client_secret needed — Desktop OAuth clients don't require it.
 *
 * @param {string} refreshToken
 * @returns {Promise<{ accessToken: string, expiresIn: number }>}
 */
export async function exchangeRefreshToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: OAUTH_CLIENT_ID,
      client_secret: OAUTH_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });

  const data = await resp.json();
  if (data.error) {
    const err = new Error(data.error_description || data.error);
    err.code = data.error; // 'invalid_grant' if token revoked
    throw err;
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in
  };
}
