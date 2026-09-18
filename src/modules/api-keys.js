/**
 * API Key Manager
 *
 * Manages multiple client-facing API keys used to authenticate requests to the
 * proxy's `/v1/*` endpoints.
 *
 * Design goals:
 * - Backward compatible: the legacy single `config.apiKey` string is still a
 *   valid key. This module only manages the additional `config.apiKeys` list.
 * - Keys are formatted as `sk-ag-<random>` where <random> is url-safe base64.
 * - Each stored entry: { id, key, label, enabled, createdAt }.
 * - Validation is constant-time to avoid timing side-channels.
 *
 * All mutations persist through `saveConfig` so they survive restarts.
 */

import crypto from 'crypto';
import { config, saveConfig, maskKey } from '../config.js';

const KEY_PREFIX = 'sk-ag-';
const RANDOM_BYTES = 24; // 24 bytes -> 32 url-safe base64 chars

/**
 * Generate a new API key string in the form `sk-ag-<random>`.
 * @returns {string}
 */
export function generateKeyString() {
    const random = crypto.randomBytes(RANDOM_BYTES).toString('base64url');
    return `${KEY_PREFIX}${random}`;
}

/**
 * Generate a short unique id for referencing a key in management APIs.
 * @returns {string}
 */
function generateId() {
    return crypto.randomBytes(8).toString('hex');
}

/**
 * Get the raw list of key entries from config (never mutate the returned refs).
 * @returns {Array<{id:string,key:string,label:string,enabled:boolean,createdAt:number}>}
 */
export function getRawKeys() {
    return Array.isArray(config.apiKeys) ? config.apiKeys : [];
}

/**
 * List keys with the secret masked for safe display.
 * @returns {Array<{id:string,label:string,enabled:boolean,createdAt:number,keyPreview:string}>}
 */
export function listKeys() {
    return getRawKeys().map((entry) => ({
        id: entry.id,
        label: entry.label || '',
        enabled: entry.enabled !== false,
        createdAt: entry.createdAt || null,
        keyPreview: maskKey(entry.key)
    }));
}

/**
 * Get a single key entry's FULL secret by id. Intended only for the
 * password-protected WebUI "reveal" action — never expose this on unauthenticated
 * routes. Returns null if the id is unknown.
 * @param {string} id
 * @returns {{id:string,label:string,enabled:boolean,createdAt:number,key:string}|null}
 */
export function getKeyById(id) {
    const entry = getRawKeys().find((k) => k.id === id);
    if (!entry) return null;
    return {
        id: entry.id,
        label: entry.label || '',
        enabled: entry.enabled !== false,
        createdAt: entry.createdAt || null,
        key: entry.key
    };
}

/**
 * Create and persist a new API key.
 * @param {Object} [opts]
 * @param {string} [opts.label] - Optional human-readable label.
 * @returns {{id:string,key:string,label:string,enabled:boolean,createdAt:number}} The full entry (includes the raw key — surface it to the caller only once).
 * @throws {Error} If persistence fails.
 */
export function addKey({ label = '' } = {}) {
    const entry = {
        id: generateId(),
        key: generateKeyString(),
        label: typeof label === 'string' ? label.trim().slice(0, 100) : '',
        enabled: true,
        createdAt: Date.now()
    };

    const keys = [...getRawKeys(), entry];
    const ok = saveConfig({ apiKeys: keys });
    if (!ok) {
        throw new Error('Failed to persist API key');
    }
    return entry;
}

/**
 * Update a key's label and/or enabled state.
 * @param {string} id
 * @param {Object} updates
 * @param {string} [updates.label]
 * @param {boolean} [updates.enabled]
 * @returns {Object|null} The updated (masked) entry, or null if id not found.
 */
export function updateKey(id, { label, enabled } = {}) {
    const keys = getRawKeys();
    const idx = keys.findIndex((k) => k.id === id);
    if (idx === -1) return null;

    // Build a new array/object to avoid mutating live config before save.
    const updated = { ...keys[idx] };
    if (typeof label === 'string') updated.label = label.trim().slice(0, 100);
    if (typeof enabled === 'boolean') updated.enabled = enabled;

    const newKeys = keys.map((k, i) => (i === idx ? updated : k));
    const ok = saveConfig({ apiKeys: newKeys });
    if (!ok) {
        throw new Error('Failed to persist API key update');
    }

    return {
        id: updated.id,
        label: updated.label || '',
        enabled: updated.enabled !== false,
        createdAt: updated.createdAt || null,
        keyPreview: maskKey(updated.key)
    };
}

/**
 * Revoke (delete) a key by id.
 * @param {string} id
 * @returns {boolean} True if a key was removed.
 */
export function revokeKey(id) {
    const keys = getRawKeys();
    const newKeys = keys.filter((k) => k.id !== id);
    if (newKeys.length === keys.length) {
        return false; // nothing removed
    }
    const ok = saveConfig({ apiKeys: newKeys });
    if (!ok) {
        throw new Error('Failed to persist API key revocation');
    }
    return true;
}

/**
 * Constant-time string comparison. Returns false for length mismatch without
 * leaking via early return timing (crypto.timingSafeEqual requires equal lengths,
 * so we guard length separately but consistently).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Determine whether authentication is enforced at all.
 * When both the legacy `apiKey` and all `apiKeys` are empty, the proxy runs open.
 * @returns {boolean}
 */
export function isAuthConfigured() {
    if (config.apiKey) return true;
    return getRawKeys().some((k) => k.enabled !== false && !!k.key);
}

/**
 * Validate a provided client key against the legacy key and the multi-key list.
 * @param {string} providedKey
 * @returns {{valid:boolean, label:string|null, id:string|null, legacy:boolean}}
 */
export function validateKey(providedKey) {
    const result = { valid: false, label: null, id: null, legacy: false };
    if (!providedKey) return result;

    // Legacy single key.
    if (config.apiKey && safeEqual(providedKey, config.apiKey)) {
        result.valid = true;
        result.legacy = true;
        result.label = 'legacy';
        return result;
    }

    // Multi-key list (enabled entries only).
    for (const entry of getRawKeys()) {
        if (entry.enabled === false || !entry.key) continue;
        if (safeEqual(providedKey, entry.key)) {
            result.valid = true;
            result.label = entry.label || '';
            result.id = entry.id;
            return result;
        }
    }

    return result;
}

export default {
    generateKeyString,
    getRawKeys,
    listKeys,
    getKeyById,
    addKey,
    updateKey,
    revokeKey,
    isAuthConfigured,
    validateKey
};
