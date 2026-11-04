// Supp v2 - Firebase Auto-Setup
// Programmatic Firebase project configuration via REST APIs.
// Called when the team owner pastes their service account JSON.
// The service account JSON is processed entirely in the browser, used once to get a
// short-lived access token, then discarded — it is never stored.

/**
 * Encode a string or ArrayBuffer as base64url (no padding).
 */
function base64url(input) {
  let bytes;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Import an RSA private key from PEM (PKCS#8 format, as provided in service account JSON).
 * @param {string} pem - "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
 * @returns {Promise<CryptoKey>}
 */
async function importRsaPrivateKey(pem) {
  const pemContents = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s/g, '');

  const binary = atob(pemContents);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);

  return crypto.subtle.importKey(
    'pkcs8',
    der.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

/**
 * Build and sign a JWT for service account authentication.
 * @param {string} clientEmail - service account email
 * @param {CryptoKey} privateKey - imported RS256 signing key
 * @param {string[]} scopes - OAuth2 scopes to request
 * @returns {Promise<string>} signed JWT
 */
async function buildServiceAccountJwt(clientEmail, privateKey, scopes) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: clientEmail,
    scope: scopes.join(' '),
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }));

  const toSign = `${header}.${payload}`;
  const signatureBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    new TextEncoder().encode(toSign)
  );

  return `${toSign}.${base64url(signatureBuffer)}`;
}

/**
 * Exchange a signed service account JWT for a Google OAuth2 access token.
 * @param {string} jwt
 * @returns {Promise<string>} access token
 */
async function exchangeJwtForToken(jwt) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    })
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`JWT token exchange failed: ${err.error_description || resp.status}`);
  }

  const data = await resp.json();
  return data.access_token;
}

/**
 * Set Firebase Realtime Database security rules to allow authenticated users only.
 * Handles non-US regions: if the default URL returns 404 with a correctUrl in the body,
 * retries automatically with the correct regional URL.
 *
 * @param {string} projectId
 * @param {string} accessToken
 * @returns {Promise<string>} the actual databaseURL that was used (may be regional)
 */
async function setDatabaseSecurityRules(projectId, accessToken) {
  // Default URL assumes US region; non-US projects return 404 with the correct URL
  const defaultUrl = `https://${projectId}-default-rtdb.firebaseio.com`;
  let databaseUrl = defaultUrl;

  const rules = {
    rules: {
      rooms: {
        '$roomId': {
          '.read': 'auth != null',
          '.write': 'auth != null'
        }
      }
    }
  };

  // The RTDB rules REST API requires the token as a query parameter (?access_token=),
  // not as an Authorization: Bearer header. Bearer header works for data operations
  // but is not accepted by the /.settings/rules.json admin endpoint.
  const attempt = async (url) => fetch(
    `${url}/.settings/rules.json?access_token=${encodeURIComponent(accessToken)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rules)
    }
  );

  let resp = await attempt(databaseUrl);

  if (resp.status === 404) {
    // Firebase returns the correct regional URL in the error body
    const body = await resp.json().catch(() => ({}));
    if (body.correctUrl) {
      console.log(`[Supp] Firebase: database is in a different region, retrying with: ${body.correctUrl}`);
      databaseUrl = body.correctUrl.replace('/.settings/rules.json', '').split('?')[0];
      resp = await attempt(databaseUrl);
    }
  }

  if (!resp.ok) {
    if (resp.status === 401 || resp.status === 403) {
      // Regional Firebase databases (firebasedatabase.app) reject Google OAuth2 service account
      // tokens on the /.settings/rules.json endpoint — they require a Firebase ID token instead.
      // This is a known limitation when calling from the browser without the Firebase Admin SDK.
      // Return null to signal that manual rules setup is required.
      console.warn(`[Supp] Firebase: automatic rules update failed (${resp.status}) — manual setup required`);
      return null;
    }
    const body = await resp.json().catch(() => ({}));
    throw new Error(`Failed to set database rules (${resp.status}): ${body.error || JSON.stringify(body)}`);
  }

  return databaseUrl;
}

/**
 * Enable Google sign-in provider in Firebase Authentication via the Identity Toolkit API.
 * @param {string} projectId
 * @param {string} accessToken
 */
async function enableGoogleSignIn(projectId, accessToken) {
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`;

  const resp = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      signIn: {
        allowDuplicateEmails: false
      }
    })
  });

  // 403 is expected if the Auth API isn't enabled yet — not fatal, anonymous auth is fine
  if (!resp.ok && resp.status !== 403) {
    console.warn('[Supp] Could not configure Firebase Auth (non-fatal):', resp.status);
  }
}

/**
 * Create a Firebase web app and wait for the operation to complete.
 * Called automatically when the project has no web apps registered.
 * @param {string} projectId
 * @param {string} accessToken
 * @returns {Promise<string>} web app name (e.g. "projects/xxx/webApps/yyy")
 */
async function createFirebaseWebApp(projectId, accessToken) {
  console.log('[Supp] Firebase setup: no web app found — creating one automatically');

  const createResp = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ displayName: 'Supp Extension' })
    }
  );

  if (!createResp.ok) {
    const err = await createResp.json().catch(() => ({}));
    throw new Error(`Could not create Firebase web app: ${err.error?.message || createResp.status}`);
  }

  const operation = await createResp.json();
  const operationName = operation.name;

  // Poll until the operation completes (typically < 5 seconds)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    const opResp = await fetch(
      `https://firebase.googleapis.com/v1beta1/${operationName}`,
      { headers: { 'Authorization': `Bearer ${accessToken}` } }
    );
    if (!opResp.ok) continue;
    const op = await opResp.json();
    if (op.done) {
      console.log('[Supp] Firebase setup: web app created —', op.response?.name);
      return op.response?.name;
    }
  }

  throw new Error('Timed out waiting for Firebase web app creation');
}

/**
 * Fetch the Firebase project's web app config (apiKey, appId, messagingSenderId).
 * If no web app exists, creates one automatically then fetches its config.
 * @param {string} projectId
 * @param {string} accessToken
 * @param {string} databaseURL - the actual database URL resolved by setDatabaseSecurityRules
 * @returns {Promise<object>} firebaseConfig
 */
async function fetchFirebaseWebConfig(projectId, accessToken, databaseURL) {
  const authHeader = { 'Authorization': `Bearer ${accessToken}` };

  // List existing web apps
  const appsResp = await fetch(
    `https://firebase.googleapis.com/v1beta1/projects/${projectId}/webApps`,
    { headers: authHeader }
  );

  let appName = null;

  if (appsResp.ok) {
    const data = await appsResp.json();
    const apps = data.apps || [];
    if (apps.length > 0) {
      appName = apps[0].name;
    }
  }

  // No web app registered — create one so we can get the apiKey
  if (!appName) {
    try {
      appName = await createFirebaseWebApp(projectId, accessToken);
    } catch (err) {
      console.warn('[Supp] Firebase setup: web app creation failed —', err.message);
    }
  }

  // Fetch config for the (existing or newly created) web app
  if (appName) {
    const cfgResp = await fetch(
      `https://firebase.googleapis.com/v1beta1/${appName}/config`,
      { headers: authHeader }
    );
    if (cfgResp.ok) {
      const cfg = await cfgResp.json();
      return {
        apiKey: cfg.apiKey,
        authDomain: `${projectId}.firebaseapp.com`,
        databaseURL,
        projectId,
        storageBucket: `${projectId}.appspot.com`,
        messagingSenderId: cfg.messagingSenderId,
        appId: cfg.appId
      };
    }
  }

  // Fallback: construct from project_id. apiKey must be filled in manually.
  console.warn('[Supp] Could not fetch Firebase web config automatically — using partial config');
  return {
    apiKey: null,
    authDomain: `${projectId}.firebaseapp.com`,
    databaseURL,
    projectId,
    storageBucket: `${projectId}.appspot.com`,
    messagingSenderId: null,
    appId: null
  };
}

/**
 * Full Firebase auto-setup flow.
 * Parses the service account JSON, signs a JWT, exchanges it for a token,
 * sets database security rules, and returns the firebaseConfig object.
 *
 * @param {string} serviceAccountJson - raw JSON string pasted by team owner
 * @returns {Promise<{ firebaseConfig: object, needsManualApiKey: boolean }>}
 */
export async function setupFirebase(serviceAccountJson) {
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error('Invalid service account JSON — check that you pasted the entire file');
  }

  const { client_email, private_key, project_id } = serviceAccount;

  if (!client_email || !private_key || !project_id) {
    throw new Error('Service account JSON is missing required fields (client_email, private_key, project_id)');
  }

  console.log('[Supp] Firebase setup: signing JWT for', client_email);

  const scopes = [
    'https://www.googleapis.com/auth/firebase',
    'https://www.googleapis.com/auth/cloud-platform'
  ];

  const privateKey = await importRsaPrivateKey(private_key);
  const jwt = await buildServiceAccountJwt(client_email, privateKey, scopes);
  const accessToken = await exchangeJwtForToken(jwt);

  console.log('[Supp] Firebase setup: access token obtained, configuring project');

  const resolvedDatabaseURL = await setDatabaseSecurityRules(project_id, accessToken);
  // resolvedDatabaseURL is null if automatic rules update failed (regional database limitation)
  const needsManualRules = resolvedDatabaseURL === null;

  // Fall back to constructing the default URL — fetchFirebaseWebConfig will use it,
  // and the user will be shown the correct URL from the web app config fetch anyway.
  const databaseURL = resolvedDatabaseURL ?? `https://${project_id}-default-rtdb.firebaseio.com`;

  await enableGoogleSignIn(project_id, accessToken);

  const firebaseConfig = await fetchFirebaseWebConfig(project_id, accessToken, databaseURL);

  const needsManualApiKey = !firebaseConfig.apiKey;
  if (needsManualApiKey) {
    console.warn('[Supp] Firebase setup: apiKey not fetched automatically. Team owner must provide it from Firebase console → Project Settings → General → Web API Key');
  }

  console.log('[Supp] Firebase setup complete for project:', project_id);
  return { firebaseConfig, needsManualApiKey, needsManualRules };
}
