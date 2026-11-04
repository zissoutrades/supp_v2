// Supp v2 - TokenManager singleton
// Manages encrypted refresh token storage and access token caching.
// All refresh tokens live in chrome.storage.local, AES-encrypted with the storage key.
// Access tokens are cached in memory only and never persisted.

import { deriveStorageKey, encryptForStorage, decryptFromStorage } from '../crypto/storage-key.js';
import {
  generateRsaKeypair,
  exportPublicKey,
  exportPrivateKeyEncrypted,
  importPrivateKeyEncrypted
} from '../crypto/rsa.js';
import { exchangeRefreshToken } from '../crypto/pkce.js';

class TokenManager {
  #storageKey = null;               // CryptoKey — derived at init(), held in memory
  #accessTokenCache = new Map();    // email → { token, expiresAt }
  #privateKeyCache = null;          // CryptoKey — cached after first load

  /**
   * Must be called once at boot before any other method.
   * Derives the storage key and holds it in memory.
   */
  async init() {
    this.#storageKey = await deriveStorageKey();
  }

  #assertReady() {
    if (!this.#storageKey) throw new Error('TokenManager not initialized — call init() first');
  }

  // ─── Refresh tokens ────────────────────────────────────────────────────────

  /**
   * Store a refresh token for an email address, encrypted at rest.
   * @param {string} email
   * @param {string} refreshToken
   */
  async storeRefreshToken(email, refreshToken) {
    this.#assertReady();
    const encrypted = await encryptForStorage(refreshToken, this.#storageKey);
    const { refreshTokens = {} } = await chrome.storage.local.get('refreshTokens');
    refreshTokens[email] = encrypted;
    await chrome.storage.local.set({ refreshTokens });
  }

  /**
   * Load and decrypt a refresh token.
   * @param {string} email
   * @returns {Promise<string|null>}
   */
  async getRefreshToken(email) {
    this.#assertReady();
    const { refreshTokens = {} } = await chrome.storage.local.get('refreshTokens');
    const encrypted = refreshTokens[email];
    if (!encrypted) return null;
    return decryptFromStorage(encrypted, this.#storageKey);
  }

  /**
   * Check whether a refresh token is stored for the given email.
   * In test builds, also accepts pre-injected testTokens from chrome.storage.
   * @param {string} email
   * @returns {Promise<boolean>}
   */
  async hasRefreshToken(email) {
    const { refreshTokens = {} } = await chrome.storage.local.get('refreshTokens');
    if (refreshTokens[email]) return true;
    // Test mode: accept pre-injected test tokens
    if (process.env.NODE_ENV === 'test') {
      const { testTokens = {} } = await chrome.storage.local.get('testTokens');
      if (testTokens[email]) return true;
    }
    return false;
  }

  /**
   * Remove a stored refresh token (used during agent removal/revocation).
   * @param {string} email
   */
  async removeRefreshToken(email) {
    const { refreshTokens = {} } = await chrome.storage.local.get('refreshTokens');
    delete refreshTokens[email];
    await chrome.storage.local.set({ refreshTokens });
    this.#accessTokenCache.delete(email);
  }

  /**
   * Return all emails for which a refresh token is stored.
   * @returns {Promise<string[]>}
   */
  async listStoredEmails() {
    const { refreshTokens = {} } = await chrome.storage.local.get('refreshTokens');
    return Object.keys(refreshTokens);
  }

  // ─── Access tokens ─────────────────────────────────────────────────────────

  /**
   * Get a valid access token for the given email.
   * Uses in-memory cache; exchanges refresh token when expired or missing.
   *
   * @param {string} email
   * @returns {Promise<string>}
   * @throws if no refresh token stored or token exchange fails
   */
  async getAccessToken(email) {
    const cached = this.#accessTokenCache.get(email);
    if (cached && cached.expiresAt - Date.now() > 5 * 60 * 1000) {
      return cached.token;
    }

    // Test mode: return pre-injected test token directly (no refresh exchange needed)
    if (process.env.NODE_ENV === 'test') {
      const { testTokens = {} } = await chrome.storage.local.get('testTokens');
      if (testTokens[email]) return testTokens[email];
    }

    const refreshToken = await this.getRefreshToken(email);
    if (!refreshToken) throw new Error(`No refresh token stored for ${email}`);

    const { accessToken, expiresIn } = await exchangeRefreshToken(refreshToken);
    this.#accessTokenCache.set(email, {
      token: accessToken,
      expiresAt: Date.now() + expiresIn * 1000
    });
    return accessToken;
  }

  /**
   * Invalidate the cached access token for an email (call on 401 responses).
   * @param {string} email
   */
  clearAccessTokenCache(email) {
    this.#accessTokenCache.delete(email);
  }

  // ─── RSA keypair ───────────────────────────────────────────────────────────

  /**
   * Generate a new RSA keypair, store the encrypted private key and plaintext
   * public key in chrome.storage.local, and return the public key JWK.
   * @returns {Promise<JsonWebKey>}
   */
  async generateAndStoreKeypair() {
    this.#assertReady();
    const { publicKey, privateKey } = await generateRsaKeypair();
    const publicKeyJwk = await exportPublicKey(publicKey);
    const encryptedPrivateKey = await exportPrivateKeyEncrypted(privateKey, this.#storageKey);

    await chrome.storage.local.set({
      myPublicKey: publicKeyJwk,
      myPrivateKey: encryptedPrivateKey
    });

    this.#privateKeyCache = privateKey;
    return publicKeyJwk;
  }

  /**
   * Load and return the local RSA private key (decrypted from storage).
   * Cached in memory after first load.
   * @returns {Promise<CryptoKey>}
   */
  async getPrivateKey() {
    this.#assertReady();
    if (this.#privateKeyCache) return this.#privateKeyCache;

    const { myPrivateKey } = await chrome.storage.local.get('myPrivateKey');
    if (!myPrivateKey) throw new Error('No RSA private key in storage — run generateAndStoreKeypair() first');

    this.#privateKeyCache = await importPrivateKeyEncrypted(myPrivateKey, this.#storageKey);
    return this.#privateKeyCache;
  }

  /**
   * Return the local RSA public key JWK from storage.
   * @returns {Promise<JsonWebKey>}
   */
  async getPublicKey() {
    const { myPublicKey } = await chrome.storage.local.get('myPublicKey');
    if (!myPublicKey) throw new Error('No RSA public key in storage');
    return myPublicKey;
  }

  // ─── Wipe ──────────────────────────────────────────────────────────────────

  /**
   * Wipe all tokens, keys, and team config from storage.
   * Called on agent revocation / self-disable.
   */
  async clearAll() {
    await chrome.storage.local.clear();
    this.#storageKey = null;
    this.#accessTokenCache.clear();
    this.#privateKeyCache = null;
  }
}

export const tokenManager = new TokenManager();
