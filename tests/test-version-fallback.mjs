// Regression test for the User-Agent version fallback bug.
//
// Bug: getUserAgentVersionConfig() gated product.json's `ideVersion` behind
// isVersionHigher(ideVersion, FALLBACK). Antigravity's ideVersion tracks the IDE
// build (e.g. 1.19.6), which can be numerically LOWER than the hardcoded
// User-Agent fallback (2.0.3). The guard silently discarded the real installed
// version and sent the stale fallback, tripping the "stale version headers" warn
// and making requests look non-official.
//
// Fix: trust product.json's ideVersion verbatim when present.
//
// This test verifies:
//   1. isVersionHigher is a strict "greater than" (documents the trap).
//   2. When a local product.json is present, getVersionSource() sources BOTH
//      headers from product.json (never 'fallback') and does not set usingFallback.
//   3. The reported scenario (ideVersion 1.19.6 < fallback 2.0.3) would previously
//      have been rejected by the old guard.

import assert from 'assert';
import { platform, homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { getVersionSource, generateSmartUserAgent } from '../src/utils/version-detector.js';

let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.error('  ✗ FAIL:', msg); }
    else { console.log('  ✓', msg); }
}

// Mirror of the module-private isVersionHigher, to document the trap.
function isVersionHigher(v1, v2) {
    const a = v1.split('.').map(Number), b = v2.split('.').map(Number);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0, y = b[i] || 0;
        if (x > y) return true;
        if (x < y) return false;
    }
    return false;
}

// Locate a real product.json the same way the detector does (subset of paths).
function findProductJson() {
    const os = platform();
    const paths = [];
    if (os === 'win32') {
        const localAppData = process.env.LOCALAPPDATA;
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        if (localAppData) paths.push(join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'product.json'));
        paths.push(join(programFiles, 'Antigravity', 'resources', 'app', 'product.json'));
    } else if (os === 'darwin') {
        paths.push('/Applications/Antigravity.app/Contents/Resources/app/product.json');
        paths.push(join(homedir(), 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app', 'product.json'));
    } else {
        paths.push('/usr/share/antigravity/resources/app/product.json');
        paths.push('/opt/antigravity/resources/app/product.json');
        paths.push(join(homedir(), '.local', 'share', 'antigravity', 'resources', 'app', 'product.json'));
    }
    for (const p of paths) {
        try { if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8')); } catch { /* next */ }
    }
    return null;
}

console.log('Test 1: isVersionHigher is strict greater-than (documents the old trap)');
{
    check(isVersionHigher('1.19.6', '2.0.3') === false, '1.19.6 is NOT > 2.0.3 (old guard would reject the real value)');
    check(isVersionHigher('2.1.0', '2.0.3') === true, '2.1.0 > 2.0.3');
}

const product = findProductJson();
if (!product) {
    console.log('\nTest 2 SKIPPED: no local Antigravity product.json found on this machine.');
} else {
    console.log(`\nTest 2: local product.json present (ideVersion=${product.ideVersion}, version=${product.version})`);
    // Only meaningful when env overrides are not forcing the values.
    const envForced = process.env.FALLBACK_ANTIGRAVITY_VERSION || process.env.ANTIGRAVITY_CLIENT_VERSION;
    if (envForced) {
        console.log('  (env override active — skipping source assertions)');
    } else {
        const src = getVersionSource();
        check(src.userAgentSource === 'product.json', `User-Agent version sourced from product.json (got '${src.userAgentSource}')`);
        check(src.clientVersionSource === 'product.json', `X-Client-Version sourced from product.json (got '${src.clientVersionSource}')`);
        check(src.usingFallback === false, 'usingFallback is false -> no stale-version warning');
        if (product.ideVersion) {
            check(src.userAgentVersion === product.ideVersion, `User-Agent version equals ideVersion (${src.userAgentVersion})`);
            // This is the crux: even if ideVersion < fallback, it must still be used.
            if (!isVersionHigher(product.ideVersion, '2.0.3')) {
                check(src.userAgentVersion === product.ideVersion, 'ideVersion below fallback is STILL used (bug fixed)');
            }
        }
        check(generateSmartUserAgent().includes(src.userAgentVersion), 'User-Agent string embeds the resolved version');
    }
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
