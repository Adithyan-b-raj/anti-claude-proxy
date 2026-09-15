import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { config } from '../config.js';

/**
 * Shared Utility Functions
 *
 * General-purpose helper functions used across multiple modules.
 */

/**
 * Get the package version from package.json
 * @param {string} [defaultVersion='1.0.0'] - Default version if package.json cannot be read
 * @returns {string} The package version
 */
export function getPackageVersion(defaultVersion = '1.0.0') {
    try {
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = path.dirname(__filename);
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
        return packageJson.version || defaultVersion;
    } catch {
        return defaultVersion;
    }
}

/**
 * Format duration in milliseconds to human-readable string
 * @param {number} ms - Duration in milliseconds
 * @returns {string} Human-readable duration (e.g., "1h23m45s")
 */
export function formatDuration(ms) {
    const seconds = Math.floor(ms / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;

    if (hours > 0) {
        return `${hours}h${minutes}m${secs}s`;
    } else if (minutes > 0) {
        return `${minutes}m${secs}s`;
    }
    return `${secs}s`;
}


/**
 * Sleep for specified milliseconds
 * @param {number} ms - Duration to sleep in milliseconds
 * @returns {Promise<void>} Resolves after the specified duration
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Check if an error is a network error (transient)
 * @param {Error} error - The error to check
 * @returns {boolean} True if it is a network error
 */
export function isNetworkError(error) {
    const msg = error.message.toLowerCase();
    return (
        msg.includes('fetch failed') ||
        msg.includes('network error') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('socket hang up') ||
        msg.includes('timeout')
    );
}

/**
 * Throttled fetch with an opt-in global rate limiter.
 *
 * When requestThrottlingEnabled is set, upstream calls are serialized so that
 * at least `requestDelayMs` (plus a small random jitter) elapses between the
 * START of consecutive requests. This both spaces out calls and breaks up
 * bursty, perfectly-timed request patterns (a bot tell). When disabled, it is a
 * plain passthrough to fetch (original behavior).
 *
 * @param {string|URL} url - The URL to fetch
 * @param {RequestInit} [options] - Fetch options
 * @returns {Promise<Response>} Fetch response
 */
let _rateLimitChain = Promise.resolve();
let _lastCallTs = 0;

export async function throttledFetch(url, options) {
    if (!config.requestThrottlingEnabled) {
        return fetch(url, options);
    }

    const baseGap = config.requestDelayMs || 200;

    // Serialize gap computation so concurrent callers queue behind one another
    // rather than all firing after the same fixed delay.
    const waitTurn = _rateLimitChain.then(async () => {
        const now = Date.now();
        // Random jitter of 0–50% of the base gap on top of the min gap.
        const jitter = Math.floor(Math.random() * (baseGap * 0.5));
        const requiredGap = baseGap + jitter;
        const elapsed = now - _lastCallTs;
        const waitMs = Math.max(0, requiredGap - elapsed);
        if (waitMs > 0) {
            await sleep(waitMs);
        }
        _lastCallTs = Date.now();
    });

    // Advance the chain even if this turn throws, so the limiter never wedges.
    _rateLimitChain = waitTurn.catch(() => {});

    await waitTurn;
    return fetch(url, options);
}

/**
 * Generate random jitter for backoff timing (Thundering Herd Prevention)
 * Prevents all clients from retrying at the exact same moment after errors.
 * @param {number} maxJitterMs - Maximum jitter range (result will be ±maxJitterMs/2)
 * @returns {number} Random jitter value between -maxJitterMs/2 and +maxJitterMs/2
 */
export function generateJitter(maxJitterMs) {
    return Math.random() * maxJitterMs - (maxJitterMs / 2);
}
