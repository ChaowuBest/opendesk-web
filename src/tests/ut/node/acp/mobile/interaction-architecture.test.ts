import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');

function read(relative: string): string {
    return readFileSync(path.join(repositoryRoot, relative), 'utf8');
}

function filesBelow(relative: string): string[] {
    const absolute = path.join(repositoryRoot, relative);
    return readdirSync(absolute).flatMap((name) => {
        const child = path.join(relative, name);
        return statSync(path.join(repositoryRoot, child)).isDirectory() ? filesBelow(child) : [child];
    });
}

const formalInteractionFiles = [
    'src/main/aikernel/interaction/contracts.ts',
    'src/main/aikernel/interaction/delivery.ts',
    'src/main/aikernel/security/permission-delivery-options.ts',
    'src/main/applications/mobileaccess/acp/mobile/interaction/message-mapper.ts',
    'src/main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.ts'
];

test('formal interaction modules have no temporary transport or diagnostics dependency', () => {
    for (const relative of formalInteractionFiles) {
        const source = read(relative);
        assert.doesNotMatch(source, /from ['"].*\/testing\//, relative);
        assert.doesNotMatch(source, /WebSocket|127\.0\.0\.1|localhost|faultPlan|FaultPlan|diagnosticsGlobal/, relative);
    }
});

test('the shared contracts leaf has no imports and business modules re-export its types', () => {
    const contracts = read('src/main/aikernel/interaction/contracts.ts');
    assert.doesNotMatch(contracts, /^\s*import\b|\bfrom\s+['"]/m);

    for (const relative of [
        'src/main/aikernel/interaction/tools.ts',
        'src/main/aikernel/interaction/exitPlanMode.ts',
        'src/main/aikernel/security/permission.ts'
    ]) {
        const source = read(relative);
        assert.match(source, /(?:interaction\/|\.\/)contracts\.js/);
        assert.match(source, /export\s+type\s*\{/);
    }
});

test('delivery remains a single stateless routing seam', () => {
    const delivery = read('src/main/aikernel/interaction/delivery.ts');
    assert.doesNotMatch(delivery, /\b(?:new\s+)?Map\b/);
    // The readiness fan-out is the only collection the seam owns: it holds listeners, never requests,
    // answers or a queue, so each Provider stays the single authority over its own pending item.
    assert.deepEqual(delivery.match(/new\s+Set\b/g), ['new Set']);
    assert.match(delivery, /private readonly readyListeners = new Set<\(generation: number\) => void>\(\);/);
    assert.doesNotMatch(delivery, /private\s+(?:readonly\s+)?(?:queue|winner|current|settled|pending)\b/);
    assert.doesNotMatch(delivery, /locale|permission-delivery-options/);
    assert.match(delivery, /private registration\?/);
    assert.match(delivery, /private generation = 0/);

    const helper = read('src/main/aikernel/security/permission-delivery-options.ts');
    assert.match(helper, /interaction\/delivery\.js/);
    for (const relative of [
        'src/main/applications/mobileaccess/acp/mobile/acp-endpoint/agent-adapter.ts',
        'src/main/applications/mobileaccess/acp/mobile/acp-endpoint/connection-host.ts',
        'src/main/applications/mobileaccess/acp/mobile/interaction/delivery-endpoint.ts',
        'src/main/applications/mobileaccess/acp/mobile/interaction/message-mapper.ts',
        'src/main/applications/mobileaccess/acp/mobile/remote-session-service/service.ts'
    ]) {
        assert.doesNotMatch(read(relative), /permission-delivery-options/);
    }
});

test('formal PC dependency direction stays platform-neutral', () => {
    for (const relative of filesBelow('src/main/applications/mobileaccess/acp/mobile').filter((file) => file.endsWith('.ts'))) {
        const source = read(relative);
        assert.doesNotMatch(source, /src\/main\/testing\/opendesk-mobile|from ['"].*(?:react|react-native)/i);
    }

    const profile = read('src/main/applications/mobileaccess/acp/mobile/interaction/message-mapper.ts');
    const delivery = read('src/main/aikernel/interaction/delivery.ts');
    assert.doesNotMatch(profile, /aikernel\/interaction\/(?:tools|exitPlanMode)\.js|security\/permission\.js/);
    assert.doesNotMatch(delivery, /aikernel\/interaction\/(?:tools|exitPlanMode)\.js|security\/permission\.js/);
});

test('stdio interaction providers do not import the mobile endpoint', () => {
    for (const relative of [
        'src/main/server/acp/askUser.ts',
        'src/main/server/acp/exitPlanMode.ts',
        'src/main/server/acp/permission.ts'
    ]) {
        assert.doesNotMatch(read(relative), /server\/acp\/mobile|acp\/mobile/);
    }
});
