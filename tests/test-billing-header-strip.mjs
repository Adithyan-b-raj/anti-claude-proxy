// Regression test for the Claude Code v2.1.274+ opaque-429 bug.
//
// Claude Code injects a telemetry/billing pseudo-header as the first block in the
// `system` array:
//   { "type": "text", "text": "x-anthropic-billing-header: cc_version=...; cc_entrypoint=sdk-cli;" }
// When forwarded inside Google Cloud Code's systemInstruction.parts, cloudcode-pa
// detects the `x-anthropic-*` string and returns a fake 429 RESOURCE_EXHAUSTED.
//
// The fix strips these lines in the converter (primary) and again defensively in the
// request builder. This test asserts the header never survives into the final payload.

import { convertAnthropicToGoogle, cleanSystemInstructionText } from '../src/format/request-converter.js';
import { buildCloudCodeRequest } from '../src/cloudcode/request-builder.js';

let failures = 0;
function assert(cond, msg) {
    if (!cond) { failures++; console.error('  ✗ FAIL:', msg); }
    else { console.log('  ✓', msg); }
}

const BILLING = 'x-anthropic-billing-header: cc_version=2.1.274.834; cc_entrypoint=sdk-cli;';

console.log('Test 1: cleanSystemInstructionText strips a standalone billing header');
{
    assert(cleanSystemInstructionText(BILLING) === '', 'standalone billing header -> empty string');
    assert(
        cleanSystemInstructionText(`${BILLING}\nYou are a helpful assistant.`) === 'You are a helpful assistant.',
        'billing header + real prompt -> only real prompt remains'
    );
    assert(
        cleanSystemInstructionText('x-anthropic-something: value\nReal content') === 'Real content',
        'generic x-anthropic-* line stripped'
    );
    assert(
        cleanSystemInstructionText('No headers here.') === 'No headers here.',
        'text without headers is unchanged'
    );
}

console.log('\nTest 2: converter drops the empty billing part (array system input)');
{
    const req = {
        model: 'claude-opus-4-6-thinking',
        messages: [{ role: 'user', content: 'hi' }],
        system: [
            { type: 'text', text: BILLING },
            { type: 'text', text: 'You are a coding assistant.' }
        ]
    };
    const google = convertAnthropicToGoogle(req);
    const parts = google.systemInstruction?.parts || [];
    const joined = parts.map(p => p.text).join('\n');
    assert(!joined.includes('x-anthropic'), 'no x-anthropic string in converted systemInstruction');
    assert(parts.length === 1, `empty billing part pruned (parts=${parts.length}, expected 1)`);
    assert(joined.includes('coding assistant'), 'real system prompt preserved');
}

console.log('\nTest 3: end-to-end buildCloudCodeRequest payload is clean');
{
    const req = {
        model: 'claude-opus-4-6-thinking',
        messages: [{ role: 'user', content: 'hi' }],
        system: [
            { type: 'text', text: BILLING },
            { type: 'text', text: 'You are Nous Research Hermes.' }
        ]
    };
    const payload = buildCloudCodeRequest(req, 'proj-123', 'user@example.com');
    const sysParts = payload.request.systemInstruction.parts;
    const joined = sysParts.map(p => p.text).join('\n');
    assert(!joined.includes('x-anthropic'), 'final payload has no x-anthropic billing header');
    assert(!joined.includes('Nous Research'), 'third-party identity scrubbed (secondary trigger)');
    assert(sysParts.every(p => p.text && p.text.trim().length > 0), 'no empty/blank system parts forwarded');
}

console.log('\nTest 4: string system input also stripped');
{
    const req = {
        model: 'gemini-3.6-flash-low',
        messages: [{ role: 'user', content: 'hi' }],
        system: `${BILLING}\nBe concise.`
    };
    const google = convertAnthropicToGoogle(req);
    const joined = (google.systemInstruction?.parts || []).map(p => p.text).join('\n');
    assert(!joined.includes('x-anthropic'), 'string-form billing header stripped');
    assert(joined.includes('Be concise'), 'string-form real prompt preserved');
}

console.log('\nTest 5: Claude Code / Anthropic identity strings scrubbed (Trigger #2)');
{
    const req = {
        model: 'claude-opus-4-6-thinking',
        messages: [{ role: 'user', content: 'hi' }],
        system: [{ type: 'text', text: 'You are Claude Code, made by Anthropic. You are Claude.' }]
    };
    const payload = buildCloudCodeRequest(req, 'proj-123', 'user@example.com');
    const joined = payload.request.systemInstruction.parts.map(p => p.text).join('\n');
    assert(!joined.includes('Claude Code'), '"Claude Code" scrubbed');
    assert(!joined.includes('Anthropic'), '"Anthropic" scrubbed');
    assert(!/\bClaude\b/.test(joined), '"Claude" scrubbed');
    assert(joined.includes('the coding assistant'), '"Claude Code" -> "the coding assistant"');
}

console.log('\nTest 6: colon-precision — non-header x-anthropic prose is NOT stripped');
{
    // A general mention without a colon is not a header line and must survive.
    const text = 'Use the x-anthropic-beta feature when available.';
    assert(
        cleanSystemInstructionText(text) === text,
        'prose mentioning x-anthropic-* (no colon) is preserved'
    );
}

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
