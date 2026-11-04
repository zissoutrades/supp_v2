// Supp v2 - Token Encryption
// AES-GCM 256-bit encryption for OAuth tokens stored in the team config (Google Drive).
// All operations use Web Crypto API (crypto.subtle), available in content scripts and service workers.

/**
 * Encode an ArrayBuffer or Uint8Array to a base64 string.
 */
function bufferToBase64(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

/**
 * Decode a base64 string to a Uint8Array.
 */
function base64ToBuffer(b64) {
  const binary = atob(b64);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf;
}

/**
 * Generate a new AES-GCM 256-bit team key.
 * @returns {Promise<CryptoKey>}
 */
export async function generateTeamKey() {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true, // extractable — needed to export as JWK and store in team config
    ['encrypt', 'decrypt']
  );
}

/**
 * Export a CryptoKey as a JWK object for storage in the team config.
 * @param {CryptoKey} cryptoKey
 * @returns {Promise<JsonWebKey>}
 */
export async function exportTeamKey(cryptoKey) {
  return crypto.subtle.exportKey('jwk', cryptoKey);
}

/**
 * Import a JWK object back into a CryptoKey for encryption/decryption.
 * @param {JsonWebKey} jwk
 * @returns {Promise<CryptoKey>}
 */
export async function importTeamKey(jwk) {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a string token using AES-GCM with a random 12-byte IV.
 * @param {string} token - plaintext token (or JSON string of a token object)
 * @param {CryptoKey} teamKey
 * @returns {Promise<{ iv: string, ciphertext: string, algorithm: 'AES-GCM' }>}
 */
export async function encryptToken(token, teamKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);

  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    teamKey,
    encoded
  );

  return {
    iv: bufferToBase64(iv),
    ciphertext: bufferToBase64(cipherBuffer),
    algorithm: 'AES-GCM'
  };
}

/**
 * Decrypt an encrypted token object back to a plaintext string.
 * @param {{ iv: string, ciphertext: string }} encrypted
 * @param {CryptoKey} teamKey
 * @returns {Promise<string>}
 */
export async function decryptToken(encrypted, teamKey) {
  const iv = base64ToBuffer(encrypted.iv);
  const cipherBuffer = base64ToBuffer(encrypted.ciphertext);

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    teamKey,
    cipherBuffer
  );

  return new TextDecoder().decode(plainBuffer);
}
