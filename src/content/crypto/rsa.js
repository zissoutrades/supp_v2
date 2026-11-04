// Supp v2 - RSA-OAEP key management + hybrid encryption
// RSA-OAEP 4096-bit for encrypting tokens addressed to specific recipients.
// Hybrid encryption (RSA wraps an AES session key) handles payloads of any size.

import { base64url, base64urlDecode, encryptForStorage, decryptFromStorage } from './storage-key.js';

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256'
};

/**
 * Generate a new RSA-OAEP 4096-bit keypair.
 * Private key is non-extractable here; use exportPrivateKeyEncrypted to persist it.
 * @returns {Promise<{ publicKey: CryptoKey, privateKey: CryptoKey }>}
 */
export async function generateRsaKeypair() {
  return crypto.subtle.generateKey(RSA_PARAMS, true, ['encrypt', 'decrypt']);
}

/**
 * Export a public key as JWK (safe to publish to [supp-keyring]).
 * @param {CryptoKey} publicKey
 * @returns {Promise<JsonWebKey>}
 */
export async function exportPublicKey(publicKey) {
  return crypto.subtle.exportKey('jwk', publicKey);
}

/**
 * Import a JWK public key back to a CryptoKey.
 * @param {JsonWebKey} jwk
 * @returns {Promise<CryptoKey>}
 */
export async function importPublicKey(jwk) {
  return crypto.subtle.importKey('jwk', jwk, RSA_PARAMS, true, ['encrypt']);
}

/**
 * Export a private key as JWK, then AES-GCM encrypt it with the storage key.
 * @param {CryptoKey} privateKey
 * @param {CryptoKey} storageKey
 * @returns {Promise<{ ciphertext: string, iv: string, version: number }>}
 */
export async function exportPrivateKeyEncrypted(privateKey, storageKey) {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  return encryptForStorage(JSON.stringify(jwk), storageKey);
}

/**
 * Decrypt and import an encrypted private key JWK.
 * @param {{ ciphertext: string, iv: string, version: number }} encryptedJwk
 * @param {CryptoKey} storageKey
 * @returns {Promise<CryptoKey>}
 */
export async function importPrivateKeyEncrypted(encryptedJwk, storageKey) {
  const jwkJson = await decryptFromStorage(encryptedJwk, storageKey);
  const jwk = JSON.parse(jwkJson);
  return crypto.subtle.importKey('jwk', jwk, RSA_PARAMS, true, ['decrypt']);
}

/**
 * Hybrid encrypt arbitrary plaintext for a specific recipient.
 *
 * Steps:
 *   1. Generate a random AES-256-GCM session key
 *   2. AES-GCM encrypt the plaintext → { iv, ciphertext }
 *   3. RSA-OAEP encrypt the raw session key bytes → encryptedKey
 *
 * Returns { encryptedKey, iv, ciphertext } — all base64url strings.
 *
 * @param {string} plaintext
 * @param {CryptoKey} recipientPublicKey
 * @returns {Promise<{ encryptedKey: string, iv: string, ciphertext: string }>}
 */
export async function hybridEncrypt(plaintext, recipientPublicKey) {
  const sessionKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 }, true, ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipherBuffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    sessionKey,
    new TextEncoder().encode(plaintext)
  );

  const rawSessionKey = await crypto.subtle.exportKey('raw', sessionKey);
  const encryptedKeyBuffer = await crypto.subtle.encrypt(
    { name: 'RSA-OAEP' },
    recipientPublicKey,
    rawSessionKey
  );

  return {
    encryptedKey: base64url(encryptedKeyBuffer),
    iv: base64url(iv),
    ciphertext: base64url(cipherBuffer)
  };
}

/**
 * Hybrid decrypt a payload produced by hybridEncrypt.
 * @param {{ encryptedKey: string, iv: string, ciphertext: string }} encrypted
 * @param {CryptoKey} privateKey
 * @returns {Promise<string>}
 */
export async function hybridDecrypt(encrypted, privateKey) {
  const rawSessionKey = await crypto.subtle.decrypt(
    { name: 'RSA-OAEP' },
    privateKey,
    base64urlDecode(encrypted.encryptedKey)
  );

  const sessionKey = await crypto.subtle.importKey(
    'raw', rawSessionKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
  );

  const plainBuffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64urlDecode(encrypted.iv) },
    sessionKey,
    base64urlDecode(encrypted.ciphertext)
  );

  return new TextDecoder().decode(plainBuffer);
}
