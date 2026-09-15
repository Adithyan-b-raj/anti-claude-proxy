/**
 * Test for Multiple Client API Keys
 *
 * Validates the multi-key auth feature added on top of the legacy single `apiKey`:
 *   1. Key generation format (sk-ag-<random>) and uniqueness
 *   2. maskKey() redaction
 *   3. isAuthConfigured() open-mode vs enforced
 *   4. validateKey() against legacy key, enabled keys, disabled keys, unknown keys
 *   5. CRUD (add/update/revoke) persistence round-trip
 *   6. getPublicConfig() never leaks full keys
 *
 * Pure unit test (dynamic ESM imports). It snapshots the on-disk config file and
 * the in-memory config, then restores both so it never clobbers a real config.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_FILE = path.join(os.homedir(), '.config', 'antigravity-proxy', 'config.json');

async function runTests() {
    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║              MULTIPLE API KEYS TEST SUITE                    ║');
    console.log('╚══════════════════════════════════════════════════════════════╝\n');

    // Snapshot on-disk config so CRUD tests (which persist via saveConfig) don't clobber it.
    let diskBackup = null;
    let diskExisted = false;
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            diskExisted = true;
            diskBackup = fs.readFileSync(CONFIG_FILE, 'utf8');
        }
    } catch (e) { /* ignore */ }

    const { config, getPublicConfig, maskKey } = await import('../src/config.js');
    const apiKeys = (await import('../src/modules/api-keys.js')).default;

    // Snapshot in-memory config fields we mutate.
    const originalApiKey = config.apiKey;
    const originalApiKeys = JSON.parse(JSON.stringify(config.apiKeys || []));

    let passed = 0;
    let failed = 0;

    function test(name, fn) {
        try {
            fn();
            console.log(`  ✓ ${name}`);
            passed++;
        } catch (e) {
            console.log(`  ✗ ${name}`);
            console.log(`    Error: ${e.message}`);
            failed++;
        }
    }

    function assert(cond, message = '') {
        if (!cond) throw new Error(message || 'Assertion failed');
    }
    function assertEqual(actual, expected, message = '') {
        if (actual !== expected) {
            throw new Error(`${message}\n    Expected: ${JSON.stringify(expected)}\n    Actual:   ${JSON.stringify(actual)}`);
        }
    }

    try {
        // --- Key generation ---
        console.log('Key generation & masking:');
        test('generateKeyString has sk-ag- prefix', () => {
            const k = apiKeys.generateKeyString();
            assert(k.startsWith('sk-ag-'), `got ${k}`);
        });
        test('generateKeyString is url-safe and long enough', () => {
            const k = apiKeys.generateKeyString();
            const body = k.slice('sk-ag-'.length);
            assert(body.length >= 24, `body too short: ${body.length}`);
            assert(/^[A-Za-z0-9_-]+$/.test(body), `not url-safe: ${body}`);
        });
        test('generateKeyString produces unique keys', () => {
            const a = apiKeys.generateKeyString();
            const b = apiKeys.generateKeyString();
            assert(a !== b, 'keys collided');
        });
        test('maskKey redacts middle, keeps prefix + last 4', () => {
            const masked = maskKey('sk-ag-ABCDEFGHIJKLMNOP1234');
            assert(masked.startsWith('sk-ag-'), `got ${masked}`);
            assert(masked.includes('...'), `got ${masked}`);
            assert(masked.endsWith('1234'), `got ${masked}`);
        });
        test('maskKey handles empty/short input', () => {
            assertEqual(maskKey(''), '');
            assertEqual(maskKey('short'), '****');
        });

        // --- Auth enforcement mode ---
        console.log('\nAuth enforcement mode:');
        test('open mode when no legacy key and no apiKeys', () => {
            config.apiKey = '';
            config.apiKeys = [];
            assertEqual(apiKeys.isAuthConfigured(), false);
        });
        test('enforced when legacy apiKey set', () => {
            config.apiKey = 'legacy-secret';
            config.apiKeys = [];
            assertEqual(apiKeys.isAuthConfigured(), true);
        });
        test('enforced when an enabled apiKeys entry exists', () => {
            config.apiKey = '';
            config.apiKeys = [{ id: 'x', key: 'sk-ag-enabledkeyvalue000000', label: 'a', enabled: true, createdAt: 1 }];
            assertEqual(apiKeys.isAuthConfigured(), true);
        });
        test('open mode when only disabled apiKeys exist', () => {
            config.apiKey = '';
            config.apiKeys = [{ id: 'x', key: 'sk-ag-disabledkey0000000000', label: 'a', enabled: false, createdAt: 1 }];
            assertEqual(apiKeys.isAuthConfigured(), false);
        });

        // --- Validation ---
        console.log('\nKey validation:');
        test('legacy single key still validates (backward compat)', () => {
            config.apiKey = 'legacy-secret';
            config.apiKeys = [];
            const r = apiKeys.validateKey('legacy-secret');
            assert(r.valid, 'legacy key should be valid');
            assert(r.legacy, 'should be flagged legacy');
        });
        test('multiple keys: each enabled key validates', () => {
            config.apiKey = '';
            config.apiKeys = [
                { id: 'k1', key: 'sk-ag-keyonevalue00000000000', label: 'one', enabled: true, createdAt: 1 },
                { id: 'k2', key: 'sk-ag-keytwovalue00000000000', label: 'two', enabled: true, createdAt: 2 }
            ];
            const r1 = apiKeys.validateKey('sk-ag-keyonevalue00000000000');
            const r2 = apiKeys.validateKey('sk-ag-keytwovalue00000000000');
            assert(r1.valid && r1.label === 'one' && r1.id === 'k1', 'key one failed');
            assert(r2.valid && r2.label === 'two' && r2.id === 'k2', 'key two failed');
        });
        test('disabled key is rejected', () => {
            config.apiKey = '';
            config.apiKeys = [{ id: 'k1', key: 'sk-ag-disabledvalue000000000', label: 'x', enabled: false, createdAt: 1 }];
            const r = apiKeys.validateKey('sk-ag-disabledvalue000000000');
            assertEqual(r.valid, false);
        });
        test('unknown key is rejected', () => {
            config.apiKey = 'legacy-secret';
            config.apiKeys = [{ id: 'k1', key: 'sk-ag-knownvalue0000000000000', label: 'x', enabled: true, createdAt: 1 }];
            assertEqual(apiKeys.validateKey('sk-ag-nopewrongkey').valid, false);
            assertEqual(apiKeys.validateKey('').valid, false);
            assertEqual(apiKeys.validateKey(undefined).valid, false);
        });
        test('legacy + multi-key coexist', () => {
            config.apiKey = 'legacy-secret';
            config.apiKeys = [{ id: 'k1', key: 'sk-ag-coexistvalue0000000000', label: 'x', enabled: true, createdAt: 1 }];
            assert(apiKeys.validateKey('legacy-secret').valid, 'legacy failed');
            assert(apiKeys.validateKey('sk-ag-coexistvalue0000000000').valid, 'multi failed');
        });

        // --- CRUD persistence round-trip ---
        console.log('\nCRUD persistence:');
        test('addKey creates a valid, enabled key that validates', () => {
            config.apiKey = '';
            config.apiKeys = [];
            const entry = apiKeys.addKey({ label: 'laptop' });
            assert(entry.key.startsWith('sk-ag-'), 'bad key format');
            assertEqual(entry.label, 'laptop');
            assertEqual(entry.enabled, true);
            const r = apiKeys.validateKey(entry.key);
            assert(r.valid && r.id === entry.id, 'new key does not validate');
        });
        test('listKeys returns masked previews, never full keys', () => {
            const list = apiKeys.listKeys();
            assert(list.length >= 1, 'expected at least one key');
            for (const k of list) {
                assert(!('key' in k), 'listKeys leaked raw key field');
                assert(typeof k.keyPreview === 'string' && k.keyPreview.includes('...'), 'preview not masked');
            }
        });
        test('updateKey can disable a key so it no longer validates', () => {
            const entry = apiKeys.addKey({ label: 'temp' });
            const updated = apiKeys.updateKey(entry.id, { enabled: false });
            assert(updated && updated.enabled === false, 'update did not disable');
            assertEqual(apiKeys.validateKey(entry.key).valid, false);
        });
        test('updateKey relabels', () => {
            const entry = apiKeys.addKey({ label: 'old' });
            const updated = apiKeys.updateKey(entry.id, { label: 'new' });
            assertEqual(updated.label, 'new');
        });
        test('updateKey returns null for unknown id', () => {
            assertEqual(apiKeys.updateKey('does-not-exist', { enabled: true }), null);
        });
        test('revokeKey removes a key', () => {
            const entry = apiKeys.addKey({ label: 'revoke-me' });
            assertEqual(apiKeys.revokeKey(entry.id), true);
            assertEqual(apiKeys.validateKey(entry.key).valid, false);
        });
        test('revokeKey returns false for unknown id', () => {
            assertEqual(apiKeys.revokeKey('nope'), false);
        });

        // --- Public config redaction ---
        console.log('\nPublic config redaction:');
        test('getPublicConfig masks apiKeys and never exposes raw key', () => {
            config.apiKey = 'legacy-secret';
            config.apiKeys = [{ id: 'k1', key: 'sk-ag-secretrawvalue000000000', label: 'x', enabled: true, createdAt: 1 }];
            const pub = getPublicConfig();
            assertEqual(pub.apiKey, '********');
            assert(Array.isArray(pub.apiKeys), 'apiKeys missing');
            const entry = pub.apiKeys[0];
            assert(!('key' in entry), 'raw key leaked in public config');
            assert(entry.keyPreview.includes('...'), 'preview not masked');
            const serialized = JSON.stringify(pub);
            assert(!serialized.includes('sk-ag-secretrawvalue000000000'), 'full key leaked in serialized public config');
        });

    } finally {
        // Restore in-memory config.
        config.apiKey = originalApiKey;
        config.apiKeys = originalApiKeys;
        // Restore on-disk config exactly as it was.
        try {
            if (diskExisted) {
                fs.writeFileSync(CONFIG_FILE, diskBackup, 'utf8');
            } else if (fs.existsSync(CONFIG_FILE)) {
                fs.unlinkSync(CONFIG_FILE);
            }
        } catch (e) {
            console.log(`  ! Warning: failed to restore config file: ${e.message}`);
        }
    }

    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log(`║  Results: ${passed} passed, ${failed} failed`.padEnd(63) + '║');
    console.log('╚══════════════════════════════════════════════════════════════╝');

    process.exit(failed === 0 ? 0 : 1);
}

runTests().catch(err => {
    console.error('Test suite crashed:', err);
    process.exit(1);
});
