// Supp v2 - Device-local AES-256-GCM storage key
// Derives a per-device key using HKDF-SHA256. The key is held in memory only —
// never stored anywhere. Re-derived fresh on each call (cheap; result cached by caller).

/**
 * Encode a Uint8Array or ArrayBuffer to base64url (no padding).
 */
export function base64url(input) {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decode a base64url string to Uint8Array.
 */
export function base64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Send a message to the service worker.
 */
function swMessage(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

/**
 * Derive the device-local AES-256-GCM storage key.
 *
 * Inputs:
 *   - Chrome profile ID (stable per Chrome profile, via GET_PROFILE_USER_INFO)
 *   - storageSalt (32 random bytes, generated once and persisted in chrome.storage.local)
 *
 * The resulting CryptoKey is non-extractable and held in memory only.
 *
 * @returns {Promise<CryptoKey>}
 */
export async function deriveStorageKey() {
  const profileInfo = await swMessage({ type: 'GET_PROFILE_USER_INFO' });
  const chromeProfileId = profileInfo?.id || 'anonymous';

  let { storageSalt } = await chrome.storage.local.get('storageSalt');
  if (!storageSalt) {
    storageSalt = base64url(crypto.getRandomValues(new Uint8Array(32)));
    await chrome.storage.local.set({ storageSalt });
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(chromeProfileId + storageSalt),
    'HKDF',
    false,
    ['deriveKey']
  );

  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(32),
      info: new TextEncoder().encode('supp-storage-v1')
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a plaintext string with AES-256-GCM using a random 12-byte IV.
 * @param {string} plaintext
 * @param {CryptoKey} storageKey
 * @returns {Promise<{ ciphertext: string, iv: string, version: number }>}
 */
export async function encryptForStorage(plaintext, storageKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    storageKey,
    new TextEncoder().encode(plaintext)
  );
  return {
    ciphertext: base64url(ciphertext),
    iv: base64url(iv),
    version: 1
  };
}

/**
 * Decrypt an encrypted storage value back to a plaintext string.
 * @param {{ ciphertext: string, iv: string }} encrypted
 * @param {CryptoKey} storageKey
 * @returns {Promise<string>}
 */
export async function decryptFromStorage(encrypted, storageKey) {
  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64urlDecode(encrypted.iv) },
    storageKey,
    base64urlDecode(encrypted.ciphertext)
  );
  return new TextDecoder().decode(plainBuffer);
}
