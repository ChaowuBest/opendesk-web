import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const source = (relative: string): string =>
    readFileSync(fileURLToPath(new URL(`../../../../../main/${relative}`, import.meta.url)), 'utf8');

test('keeps shared interaction contracts in one zero-dependency leaf', () => {
    const contracts = source('aikernel/interaction/contracts.ts');
    assert.doesNotMatch(contracts, /^\s*import\b/m);
    assert.doesNotMatch(contracts, /\bfrom\s+['"]/);

    const tools = source('aikernel/interaction/tools.ts');
    const exit = source('aikernel/interaction/exitPlanMode.ts');
    const permission = source('aikernel/security/permission.ts');
    const profile = source('applications/mobileaccess/acp/mobile/interaction/message-mapper.ts');
    for (const consumer of [tools, exit, permission, profile]) {
        assert.match(consumer, /interaction\/contracts\.js|\.\/contracts\.js/);
    }
    assert.doesNotMatch(profile, /interaction\/(?:tools|exitPlanMode)\.js/);
});
