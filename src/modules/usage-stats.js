import fs from 'fs';
import path from 'path';

import { USAGE_HISTORY_PATH } from '../constants.js';
import { logger } from '../utils/logger.js';

// Persistence path
const HISTORY_FILE = USAGE_HISTORY_PATH;
const DATA_DIR = path.dirname(HISTORY_FILE);
const OLD_DATA_DIR = path.join(process.cwd(), 'data');
const OLD_HISTORY_FILE = path.join(OLD_DATA_DIR, 'usage-history.json');

// In-memory storage
// Structure: { "YYYY-MM-DDTHH:00:00.000Z": { "claude": { "model-name": count, "_subtotal": count }, "_total": count } }
let history = {};
// Per-key cumulative token usage.
// Structure: { [keyId]: { label, inputTokens, outputTokens, requests, lastUsed } }
let keyUsage = {};
let isDirty = false;

/**
 * Extract model family from model ID
 * @param {string} modelId - The model identifier (e.g., "claude-opus-4-6-thinking")
 * @returns {string} The family name (claude, gemini, or other)
 */
function getFamily(modelId) {
    const lower = (modelId || '').toLowerCase();
    if (lower.includes('claude')) return 'claude';
    if (lower.includes('gemini')) return 'gemini';
    return 'other';
}

/**
 * Extract short model name (without family prefix)
 * @param {string} modelId - The model identifier
 * @param {string} family - The model family
 * @returns {string} Short model name
 */
function getShortName(modelId, family) {
    if (family === 'other') return modelId;
    // Remove family prefix (e.g., "claude-opus-4-6" -> "opus-4-6")
    return modelId.replace(new RegExp(`^${family}-`, 'i'), '');
}

/**
 * Ensure data directory exists and load history.
 * Includes migration from legacy local data directory.
 */
function load() {
    try {
        // Migration logic: if old file exists and new one doesn't
        if (fs.existsSync(OLD_HISTORY_FILE) && !fs.existsSync(HISTORY_FILE)) {
            logger.info('[UsageStats] Migrating legacy usage data...');
            if (!fs.existsSync(DATA_DIR)) {
                fs.mkdirSync(DATA_DIR, { recursive: true });
            }
            fs.copyFileSync(OLD_HISTORY_FILE, HISTORY_FILE);
            // We keep the old file for safety initially, but could delete it
            logger.info(`[UsageStats] Migration complete: ${OLD_HISTORY_FILE} -> ${HISTORY_FILE}`);
        }

        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        if (fs.existsSync(HISTORY_FILE)) {
            const data = fs.readFileSync(HISTORY_FILE, 'utf8');
            history = JSON.parse(data);
            // Per-key usage is stored under a reserved key inside the same file
            // to stay backward compatible with existing history files.
            if (history.__keyUsage__ && typeof history.__keyUsage__ === 'object') {
                keyUsage = history.__keyUsage__;
            }
            delete history.__keyUsage__;
        }
    } catch (err) {
        logger.error('[UsageStats] Failed to load history:', err);
        history = {};
    }
}

/**
 * Save history to disk
 */
function save() {
    if (!isDirty) return;
    try {
        // Write history plus per-key usage under a reserved key, without
        // mutating the in-memory history object.
        const payload = { ...history, __keyUsage__: keyUsage };
        fs.writeFileSync(HISTORY_FILE, JSON.stringify(payload, null, 2));
        isDirty = false;
    } catch (err) {
        logger.error('[UsageStats] Failed to save history:', err);
    }
}

/**
 * Prune old data (keep last 30 days)
 */
function prune() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    let pruned = false;
    Object.keys(history).forEach(key => {
        if (new Date(key) < cutoff) {
            delete history[key];
            pruned = true;
        }
    });

    if (pruned) isDirty = true;
}

/**
 * Track a request by model ID using hierarchical structure
 * @param {string} modelId - The specific model identifier
 */
function track(modelId) {
    const now = new Date();
    // Round down to nearest hour
    now.setMinutes(0, 0, 0);
    const key = now.toISOString();

    if (!history[key]) {
        history[key] = { _total: 0 };
    }

    const hourData = history[key];
    const family = getFamily(modelId);
    const shortName = getShortName(modelId, family);

    // Initialize family object if needed
    if (!hourData[family]) {
        hourData[family] = { _subtotal: 0 };
    }

    // Increment model-specific count
    hourData[family][shortName] = (hourData[family][shortName] || 0) + 1;

    // Increment family subtotal
    hourData[family]._subtotal = (hourData[family]._subtotal || 0) + 1;

    // Increment global total
    hourData._total = (hourData._total || 0) + 1;

    isDirty = true;
}

/**
 * Track token usage attributed to a specific API key.
 * Reads token counts already returned by the upstream API (no local
 * tokenization), so the cost is a couple of integer additions per request.
 *
 * @param {string} keyId - The API key id (or 'unattributed' when auth is open)
 * @param {string} label - Human-readable label for display
 * @param {number} inputTokens - Prompt/input tokens for this request
 * @param {number} outputTokens - Completion/output tokens for this request
 */
function trackKeyUsage(keyId, label, inputTokens = 0, outputTokens = 0) {
    const id = keyId || 'unattributed';

    if (!keyUsage[id]) {
        keyUsage[id] = {
            label: label || '',
            inputTokens: 0,
            outputTokens: 0,
            requests: 0,
            lastUsed: null
        };
    }

    const entry = keyUsage[id];
    // Keep label fresh (it may have been relabeled).
    if (label) entry.label = label;
    entry.inputTokens += Math.max(0, Number(inputTokens) || 0);
    entry.outputTokens += Math.max(0, Number(outputTokens) || 0);
    entry.requests += 1;
    entry.lastUsed = new Date().toISOString();

    isDirty = true;
}

/**
 * Get per-key token usage totals.
 * @returns {Object} Map of keyId -> { label, inputTokens, outputTokens, totalTokens, requests, lastUsed }
 */
function getKeyUsage() {
    const result = {};
    Object.keys(keyUsage).forEach((id) => {
        const e = keyUsage[id];
        result[id] = {
            label: e.label || '',
            inputTokens: e.inputTokens || 0,
            outputTokens: e.outputTokens || 0,
            totalTokens: (e.inputTokens || 0) + (e.outputTokens || 0),
            requests: e.requests || 0,
            lastUsed: e.lastUsed || null
        };
    });
    return result;
}

/**
 * Setup Express Middleware
 * @param {import('express').Application} app
 */
function setupMiddleware(app) {
    load();

    // Auto-save every minute
    setInterval(() => {
        save();
        prune();
    }, 60 * 1000);

    // Save on exit
    process.on('SIGINT', () => { save(); process.exit(); });
    process.on('SIGTERM', () => { save(); process.exit(); });

    // Request interceptor
    // Track both Anthropic (/v1/messages) and OpenAI compatible (/v1/chat/completions) endpoints
    const TRACKED_PATHS = ['/v1/messages', '/v1/chat/completions'];

    app.use((req, res, next) => {
        if (req.method === 'POST' && TRACKED_PATHS.includes(req.path)) {
            const model = req.body?.model;
            if (model) {
                track(model);
            }
        }
        next();
    });
}

/**
 * Setup API Routes
 * @param {import('express').Application} app
 */
function setupRoutes(app) {
    app.get('/api/stats/history', (req, res) => {
        // Sort keys to ensure chronological order
        const sortedKeys = Object.keys(history).sort();
        const sortedData = {};
        sortedKeys.forEach(key => {
            sortedData[key] = history[key];
        });
        res.json(sortedData);
    });

    app.get('/api/keys/usage', (req, res) => {
        res.json({ status: 'ok', usage: getKeyUsage() });
    });
}

/**
 * Get usage history data
 * @returns {object} History data sorted by timestamp
 */
function getHistory() {
    const sortedKeys = Object.keys(history).sort();
    const sortedData = {};
    sortedKeys.forEach(key => {
        sortedData[key] = history[key];
    });
    return sortedData;
}

export default {
    setupMiddleware,
    setupRoutes,
    track,
    trackKeyUsage,
    getKeyUsage,
    getFamily,
    getShortName,
    getHistory
};
