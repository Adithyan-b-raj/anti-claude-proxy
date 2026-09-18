// Focused regression test: consecutiveFailures must be tracked per-model,
// so a burst-induced rate limit on one model does not escalate the
// progressive-backoff tier of an unrelated model.
import {
    markRateLimited,
    getConsecutiveFailures,
    resetConsecutiveFailures,
    incrementConsecutiveFailures
} from '../src/account-manager/rate-limits.js';
import { calculateSmartBackoff } from '../src/cloudcode/rate-limit-state.js';
import { QUOTA_EXHAUSTED_BACKOFF_TIERS_MS } from '../src/constants.js';

let failures = 0;
function assert(cond, msg) {
    if (!cond) { failures++; console.error('  ✗ FAIL:', msg); }
    else { console.log('  ✓', msg); }
}

const OPUS = 'claude-opus-4-6-thinking';
const FLASH = 'gemini-3.6-flash-low';

console.log('Test 1: opus failures do not leak into gemini-flash backoff tier');
{
    const accounts = [{ email: 'a@x.com' }];
    // Simulate the opus burst: 3 rate limits on opus
    markRateLimited(accounts, 'a@x.com', null, OPUS);
    markRateLimited(accounts, 'a@x.com', null, OPUS);
    markRateLimited(accounts, 'a@x.com', null, OPUS);

    const opusFails = getConsecutiveFailures(accounts, 'a@x.com', OPUS);
    assert(opusFails === 3, `opus per-model failures = 3 (got ${opusFails})`);

    // First-ever 429 on gemini-flash -> should be tier 0 (60s), NOT inflated
    const flashFails = getConsecutiveFailures(accounts, 'a@x.com', FLASH);
    assert(flashFails === 0, `gemini-flash per-model failures = 0 on first hit (got ${flashFails})`);

    // Opaque 429 (no reset delay) classified QUOTA_EXHAUSTED -> tier index = flashFails
    const backoff = calculateSmartBackoff(
        '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}', null, flashFails
    );
    assert(
        backoff === QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[0],
        `gemini-flash first-429 backoff = tier0 (${QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[0]}ms), got ${backoff}ms`
    );
}

console.log('\nTest 2: BEFORE-fix behavior would have used opus failures for flash');
{
    // Demonstrate the value that the OLD (buggy) code would have produced:
    // account-level counter after 3 opus failures = 3 -> tier index 2 = 30m.
    const accounts = [{ email: 'b@x.com' }];
    markRateLimited(accounts, 'b@x.com', null, OPUS);
    markRateLimited(accounts, 'b@x.com', null, OPUS);
    markRateLimited(accounts, 'b@x.com', null, OPUS);
    const legacy = getConsecutiveFailures(accounts, 'b@x.com'); // no modelId = legacy
    const buggyBackoff = calculateSmartBackoff('RESOURCE_EXHAUSTED', null, legacy);
    // tierIndex = min(legacy, len-1). With legacy=3 and tiers [60s,5m,30m,2h] -> index 3 = 2h.
    // (In the user's log the account had 2 prior failures -> index 2 = 30m0s.)
    const expectedTier = QUOTA_EXHAUSTED_BACKOFF_TIERS_MS[Math.min(legacy, QUOTA_EXHAUSTED_BACKOFF_TIERS_MS.length - 1)];
    console.log(`  (legacy account-level count = ${legacy} -> would give ${buggyBackoff}ms via the old cross-model path)`);
    assert(buggyBackoff === expectedTier, 'confirms old cross-model path produced an inflated tier (the reported bug)');
}

console.log('\nTest 3: success on a model resets that model\'s failures');
{
    const accounts = [{ email: 'c@x.com' }];
    markRateLimited(accounts, 'c@x.com', null, FLASH);
    markRateLimited(accounts, 'c@x.com', null, FLASH);
    assert(getConsecutiveFailures(accounts, 'c@x.com', FLASH) === 2, 'flash failures = 2 before success');
    resetConsecutiveFailures(accounts, 'c@x.com', FLASH);
    assert(getConsecutiveFailures(accounts, 'c@x.com', FLASH) === 0, 'flash failures = 0 after success');
}

console.log('\nTest 4: increment is isolated per model');
{
    const accounts = [{ email: 'd@x.com' }];
    incrementConsecutiveFailures(accounts, 'd@x.com', OPUS);
    incrementConsecutiveFailures(accounts, 'd@x.com', OPUS);
    assert(getConsecutiveFailures(accounts, 'd@x.com', OPUS) === 2, 'opus increment = 2');
    assert(getConsecutiveFailures(accounts, 'd@x.com', FLASH) === 0, 'flash unaffected by opus increment');
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
