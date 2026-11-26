import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

function filesBelow(relative: string): string[] {
    const absolute = path.join(sourceRoot, relative);
    return readdirSync(absolute).flatMap((name) => {
        if (name === 'testing') return [];
        const child = path.join(relative, name);
        return statSync(path.join(sourceRoot, child)).isDirectory() ? filesBelow(child) : [child];
    });
}

function source(relative: string): string {
    return readFileSync(path.join(sourceRoot, relative), 'utf8');
}

const MOBILE_TREE = 'main/applications/mobileaccess/acp/mobile';

/**
 * The scan range is established independently of the layer lists: the whole mobile tree except its test
 * infrastructure, plus the two related files outside that tree. A file nobody classifies fails the check.
 */
function discoverScannedFiles(): string[] {
    const walk = (relative: string): string[] =>
        readdirSync(path.join(sourceRoot, relative)).flatMap((name) => {
            const child = path.join(relative, name);
            if (statSync(path.join(sourceRoot, child)).isDirectory()) {
                return child === `${MOBILE_TREE}/testing` ? [] : walk(child);
            }
            return child.endsWith('.ts') ? [child] : [];
        });
    return [...walk('main/applications/mobileaccess'), 'main/main.ts', 'main/aikernel/interaction/delivery.ts'].sort();
}

const layers = {
    networkRegistration: ['main/applications/mobileaccess/remote-access/registration-runtime.ts'],
    networkCoordination: [
        'main/applications/mobileaccess/remote-access/connection-runtime.ts',
        'main/applications/mobileaccess/remote-access/network-protocol.ts'
    ],
    // 数据通道的协议核心与 main 侧宿主桥。真实的 Electron 对象只存在于 main.ts（宿主装配边界），
    // 这一层只接受注入的 DesktopRendererPort，因此不得出现实际的 electron 导入。
    networkTransport: [
        'main/applications/mobileaccess/remote-access/webrtc-transport.ts',
        'main/applications/mobileaccess/remote-access/node-network-bridge.ts'
    ],
    composition: [`${MOBILE_TREE}/host-composition.ts`],
    business: [
        `${MOBILE_TREE}/transport/acp-message-stream.ts`,
        `${MOBILE_TREE}/acp-endpoint/connection-host.ts`,
        `${MOBILE_TREE}/acp-endpoint/agent-adapter.ts`,
        `${MOBILE_TREE}/acp-endpoint/session-message-mapper.ts`,
        `${MOBILE_TREE}/acp-endpoint/session-notification-encoder.ts`,
        `${MOBILE_TREE}/acp-endpoint/prompt-update-gate.ts`,
        `${MOBILE_TREE}/remote-session-service/service.ts`,
        `${MOBILE_TREE}/remote-session-service/host-binding.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session.ts`,
        `${MOBILE_TREE}/remote-session-service/session-projector.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session-sync.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session-identifiers.ts`,
        `${MOBILE_TREE}/interaction/message-mapper.ts`,
        `${MOBILE_TREE}/interaction/delivery-endpoint.ts`
    ],
    taskBridge: [`${MOBILE_TREE}/hosts/task-subscriptions.ts`, `${MOBILE_TREE}/hosts/tui-capabilities.ts`],
    hostLifecycle: [
        `${MOBILE_TREE}/hosts/lifecycle.ts`,
        `${MOBILE_TREE}/hosts/electron-lifecycle.ts`,
        'main/applications/mobileaccess/acp/mobile/hosts/tui-diagnostics.ts'
    ],
    hostWiring: [
        'main/main.ts',
        'main/applications/mobileaccess/app.ts',
        'main/applications/mobileaccess/locale.ts',
        'main/applications/mobileaccess/renderer/remote-network-runtime.ts',
        'main/applications/mobileaccess/electron.ts',
        'main/applications/mobileaccess/acp/mobile/hosts/renderer-port.ts',
        'main/applications/mobileaccess/tui.ts',
        'main/applications/mobileaccess/acp/mobile/hosts/model-source.ts',
        'main/applications/mobileaccess/acp/mobile/hosts/tui-network.ts'
    ],
    interactionRuntime: ['main/aikernel/interaction/delivery.ts']
} as const;

type LayerName = keyof typeof layers;

interface Classification {
    unclassified: string[];
    duplicated: string[];
    unknown: string[];
}

/** Pure so the check can be shown to actually reject an unclassified or double-classified file. */
function classify(scanned: readonly string[], assignments: Record<string, readonly string[]>): Classification {
    const counts = new Map<string, number>();
    for (const files of Object.values(assignments)) {
        for (const file of files) counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return {
        unclassified: scanned.filter((file) => !counts.has(file)).sort(),
        duplicated: [...counts.entries()]
            .filter(([, count]) => count > 1)
            .map(([file]) => file)
            .sort(),
        unknown: [...counts.keys()].filter((file) => !scanned.includes(file)).sort()
    };
}

/** Pure so the check can be shown to actually reject a cross-layer dependency. */
function forbiddenMatches(text: string, rules: readonly RegExp[]): string[] {
    return rules.filter((rule) => rule.test(text)).map((rule) => rule.source);
}

const forbidden = {
    testingImport: /from ['"][^'"]*\/testing\//,
    electron: /(?:\bfrom\s*|\bimport\s*\(\s*)['"]electron['"]|BrowserWindow|webContents|app\.on\(/,
    tui: /\/tui\//,
    concreteNetwork: /WebSocket|ws:\/\/|127\.0\.0\.1|localhost/,
    globalPlatformState: /GlobalState|Setting\.getInstance/,
    taskCore: /from ['"][^'"]*\/aikernel\/(?:task|states)\//,
    roleBusiness: /\bcurrent\/standby\b|standbyRole|isStandby/,
    compositionAssembly: /createRemoteSessionService|new MobileAcpConnectionHost|new MobileAcpAgentAdapter/
} as const;

const layerRules: Record<LayerName, readonly RegExp[]> = {
    networkRegistration: [
        forbidden.testingImport,
        forbidden.electron,
        forbidden.tui,
        forbidden.taskCore,
        forbidden.globalPlatformState,
        forbidden.compositionAssembly,
        /(?:from\s*|import\s*\(\s*)['"](?:ws|node:crypto|[^'"]*connection-runtime(?:\.js)?)['"]/
    ],
    networkCoordination: [
        forbidden.testingImport,
        /(?:\bfrom\s*|\bimport\s*\(\s*)['"]electron['"]|BrowserWindow|app\.on\(/,
        forbidden.tui,
        forbidden.taskCore,
        forbidden.globalPlatformState,
        forbidden.compositionAssembly
    ],
    // 与 networkCoordination 同口径：owner 里的 webContentsId 只是标识字段，
    // 不是 Electron 依赖；真正的 BrowserWindow / electron 导入仍被禁止。
    networkTransport: [
        forbidden.testingImport,
        /(?:\bfrom\s*|\bimport\s*\(\s*)['"]electron['"]|BrowserWindow|app\.on\(/,
        forbidden.tui,
        forbidden.taskCore,
        forbidden.globalPlatformState,
        forbidden.compositionAssembly
    ],
    composition: [
        forbidden.testingImport,
        forbidden.electron,
        forbidden.tui,
        forbidden.concreteNetwork,
        forbidden.globalPlatformState,
        forbidden.taskCore,
        forbidden.roleBusiness
    ],
    business: [
        forbidden.testingImport,
        forbidden.electron,
        forbidden.tui,
        forbidden.concreteNetwork,
        forbidden.globalPlatformState,
        forbidden.taskCore
    ],
    // The bridge is the one mobile layer allowed to name real Task types.
    taskBridge: [
        forbidden.testingImport,
        forbidden.electron,
        forbidden.tui,
        forbidden.concreteNetwork,
        forbidden.globalPlatformState,
        forbidden.compositionAssembly
    ],
    hostLifecycle: [
        forbidden.testingImport,
        forbidden.electron,
        forbidden.tui,
        forbidden.concreteNetwork,
        forbidden.globalPlatformState,
        forbidden.taskCore,
        forbidden.compositionAssembly
    ],
    // main.ts is the real Electron wiring; only the business-duplication rule applies to it.
    hostWiring: [forbidden.compositionAssembly],
    interactionRuntime: [/applications\/mobileaccess/, forbidden.electron, forbidden.tui, forbidden.taskCore]
};

test('every scanned mobile file is classified exactly once', () => {
    const scanned = discoverScannedFiles();
    const result = classify(scanned, layers);
    assert.deepEqual(result.unclassified, []);
    assert.deepEqual(result.duplicated, []);
    assert.deepEqual(result.unknown, []);
});

test('the classification and dependency checks reject unclassified files and cross-layer imports', () => {
    const synthetic = [`${MOBILE_TREE}/host-composition.ts`, `${MOBILE_TREE}/introduced-later.ts`];
    const missed = classify(synthetic, { composition: [`${MOBILE_TREE}/host-composition.ts`] });
    assert.deepEqual(missed.unclassified, [`${MOBILE_TREE}/introduced-later.ts`]);

    const doubled = classify(synthetic, {
        composition: synthetic,
        business: [`${MOBILE_TREE}/introduced-later.ts`]
    });
    assert.deepEqual(doubled.duplicated, [`${MOBILE_TREE}/introduced-later.ts`]);

    const stale = classify([`${MOBILE_TREE}/host-composition.ts`], {
        composition: [`${MOBILE_TREE}/removed.ts`, `${MOBILE_TREE}/host-composition.ts`]
    });
    assert.deepEqual(stale.unknown, [`${MOBILE_TREE}/removed.ts`]);

    const offending =
        "import { thing } from '../testing/session-fixture-composition.js';\nconst url = 'ws://127.0.0.1:1';\n";
    assert.deepEqual(forbiddenMatches(offending, layerRules.composition), [
        forbidden.testingImport.source,
        forbidden.concreteNetwork.source
    ]);
    assert.deepEqual(forbiddenMatches("import { a } from './b.js';\n", layerRules.composition), []);
});

test('each layer keeps only the dependencies its role allows', () => {
    for (const [name, files] of Object.entries(layers) as Array<[LayerName, readonly string[]]>) {
        for (const file of files) {
            assert.deepEqual(forbiddenMatches(source(file), layerRules[name]), [], `${name}: ${file}`);
        }
    }

    const composition = source(layers.composition[0]);
    assert.doesNotMatch(composition, /hosts\/task-subscriptions|hosts\/electron-lifecycle/);
    assert.equal(composition.match(/createRemoteSessionService\(/g)?.length, 1);
    assert.equal(composition.match(/new MobileAcpConnectionHost/g)?.length, 1);

    const lifecycle = source(layers.hostLifecycle[0]);
    assert.doesNotMatch(lifecycle, /startMobileHostComposition|host-composition\.js/);
});

test('formal mobile business modules keep their approved contracts', () => {
    const sources = new Map(layers.business.map((file) => [file, source(file)]));
    for (const [file, value] of sources) {
        assert.doesNotMatch(value, /ElectronDirectory|Wf[34567]|diagnostic fixture/i, file);
    }

    const adapter = sources.get(`${MOBILE_TREE}/acp-endpoint/agent-adapter.ts`)!;
    const service = sources.get(`${MOBILE_TREE}/remote-session-service/service.ts`)!;
    const projector = sources.get(`${MOBILE_TREE}/remote-session-service/session-projector.ts`)!;
    const delivery = source(layers.interactionRuntime[0]);
    const formalCombined = [...sources.values(), delivery].join('\n');

    assert.doesNotMatch(adapter, /trustedContext|isConnectionActive|TaskManager|GlobalState/);
    assert.doesNotMatch(service, /AgentSideConnection|ClientSideConnection|AcpMessageChannel|WebSocket/);
    assert.doesNotMatch(projector, /from ['"].*service\.js['"]/);
    assert.doesNotMatch(formalCombined, /AcpConnectionSupersededError|AcpInitializeTimeoutError/);

    const hostBinding = sources.get(`${MOBILE_TREE}/remote-session-service/host-binding.ts`)!;
    assert.doesNotMatch(hostBinding, /@agentclientprotocol|from ['"]\.\/service\.js|Electron|electron|TUI|tui/);
    assert.doesNotMatch(service, /@agentclientprotocol|Electron|electron|TUI|tui/);
    assert.equal(adapter.match(/private readonly remoteSessionService\b/g)?.length, 1);
    assert.doesNotMatch(adapter, /aikernel\/task|TaskManagerState|TaskState|host-binding|createHostSessionTask/);

    // The structural Task boundary keeps its original scope: these modules may only reach the two
    // approved interaction leaves, and none of them may name a Task core type.
    const structuralTaskBoundary = [
        `${MOBILE_TREE}/transport/acp-message-stream.ts`,
        `${MOBILE_TREE}/acp-endpoint/connection-host.ts`,
        `${MOBILE_TREE}/acp-endpoint/agent-adapter.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session-sync.ts`,
        `${MOBILE_TREE}/remote-session-service/public-session-identifiers.ts`,
        `${MOBILE_TREE}/remote-session-service/session-projector.ts`,
        `${MOBILE_TREE}/remote-session-service/service.ts`
    ];
    for (const file of structuralTaskBoundary) {
        const value = source(file);
        const withoutApprovedLeaves = value.replace(
            /from ['"][^'"]*\/aikernel\/interaction\/(?:contracts|delivery)\.js['"];?/g,
            ''
        );
        assert.doesNotMatch(withoutApprovedLeaves, /aikernel\//, file);
        assert.doesNotMatch(value, /TaskManagerState|BaseTask|TaskState/, file);
    }

    const taskCoreCreationOwners = filesBelow('main/aikernel/task')
        .filter((file) => file.endsWith('.ts'))
        .filter((file) => /createHostSessionTask|HostSessionTaskCreation/.test(source(file)));
    assert.deepEqual(taskCoreCreationOwners, []);
});

test('stop ownership remains exclusively in Remote Session Service', () => {
    const owners = discoverScannedFiles()
        .filter((file) => file.startsWith(`${MOBILE_TREE}/`))
        .filter((file) => source(file).includes("stop('user')"));
    assert.deepEqual(owners, [`${MOBILE_TREE}/remote-session-service/service.ts`]);
});

test('mobile ACP owns session configuration and the Application supplies live model settings', () => {
    const candidates = filesBelow('main').filter((file) => file.endsWith('.ts'));
    const marker =
        /HostSessionModelConfiguration|setSessionModelConfiguration|OPENDESK_MODEL_EFFORT_CONFIG_ID|mobileSessionModelSource/;
    const owners = candidates.filter((file) => marker.test(source(file)));
    assert.deepEqual(
        new Set(owners),
        new Set([
            `${MOBILE_TREE}/host-composition.ts`,
            `${MOBILE_TREE}/acp-endpoint/agent-adapter.ts`,
            `${MOBILE_TREE}/acp-endpoint/session-message-mapper.ts`,
            `${MOBILE_TREE}/remote-session-service/host-binding.ts`,
            `${MOBILE_TREE}/remote-session-service/service.ts`
        ])
    );

    const taskCoreOwners = filesBelow('main/aikernel/task')
        .filter((file) => file.endsWith('.ts'))
        .filter((file) => marker.test(source(file)));
    assert.deepEqual(taskCoreOwners, []);

    const modelSource = source('main/applications/mobileaccess/acp/mobile/hosts/model-source.ts');
    assert.doesNotMatch(modelSource, /task\.(?:model|reasoningEffort)\s*=|persistLater\(|decodeModelEffortValue/);
    for (const host of ['tui', 'electron']) {
        assert.match(
            source(`main/applications/mobileaccess/${host}.ts`),
            /sessionModelSource:\s*createMobileSessionModelSource\(/
        );
    }

    for (const file of owners) {
        if (file === 'main/main.ts' || file.endsWith('/host-binding.ts')) continue;
        assert.doesNotMatch(source(file), /task\.(?:model|reasoningEffort)\s*=|persistLater\(/, file);
    }
});

test('host configuration helper has no forbidden global or platform dependency', () => {
    const value = source(`${MOBILE_TREE}/remote-session-service/host-binding.ts`);
    assert.doesNotMatch(value, /Setting|getInstance|electron|ipc|activeTask|GlobalState|stdio|tui/i);
});

test('desktop and CLI delegate phone access to the registered application', () => {
    const main = source('main/main.ts');
    const cli = source('main/cli.ts');
    const electron = source('main/applications/mobileaccess/electron.ts');
    for (const entry of [main, cli, source('main/tui/entry.ts')]) {
        assert.doesNotMatch(
            entry,
            /mobileaccess\/(?:remote-access|acp\/mobile)|startMobileHostComposition|remote-network:/
        );
    }
    const initialized = main.indexOf('GlobalState.initialize();');
    const attached = main.indexOf('electronPlatform.setInteractionDeliveryChannel(deliveryChannel)', initialized);
    const registered = main.indexOf('registerTaskManagerAPIHandlers();', initialized);
    const auth = main.indexOf('await ensureHuaweiAuthOnStartup();', registered);
    const started = main.indexOf(
        'startElectronMobileAccess(mobileAccess, () => globalMainWindow, ensureElectronFullyLoaded)',
        auth
    );
    assert.ok(initialized >= 0 && attached > initialized && registered > attached);
    assert.ok(auth > registered && started > auth);
    assert.doesNotMatch(main.slice(initialized, registered), /await/);
    assert.doesNotMatch(main.slice(started - 20, started), /await\s+$/);
    assert.match(main, /createMobileQuitBarrier\(\(\) => mobileAccess\.beforeExit\(\), \(\) => app\.quit\(\)\)/);
    assert.match(main, /if \(officeQuitApproved\) \{\s*if \(deferQuitForMobileAccess\(\)\)/);
    assert.match(
        main,
        /quitForRestart: \(\) => \{\s*officeQuitApproved = true;\s*isAppQuitting = true;\s*app\.quit\(\)/
    );
    assert.match(electron, /startMobileHostComposition\(\{/);
    assert.match(electron, /interactionRuntime: mobile\[mobileInteractionRuntime\]/);
    for (const platform of ['cli', 'electron']) {
        assert.match(source(`platforms/${platform}.ts`), /getApplicationClasses\(\)[\s\S]*MobileAccessApplication/);
    }
    assert.match(
        cli,
        /new OpenDeskTUI\(args, mobileAccess\[mobileInteractionRuntime\].deliveryChannel, closeApplications\)/
    );
    assert.match(cli, /startTuiMobileAccess\(mobileAccess, tui, args\)/);
    assert.doesNotMatch(electron, /\/testing\/|OPENDESK_MOBILE_ACP_TEST_TRANSPORT/);
});

test('account owns identity and cannot import registration runtime in either code or types', () => {
    const registrationImport = /(?:\bfrom\s*|\bimport\s*\(\s*)['"][^'"]*mobileaccess\/remote-access/;
    for (const file of filesBelow('main/applications/account').filter((file) => file.endsWith('.ts'))) {
        assert.doesNotMatch(source(file), registrationImport);
    }
    assert.match(
        "const runtime = import('../mobileaccess/remote-access/registration-runtime.js');",
        registrationImport
    );
    assert.notDeepEqual(forbiddenMatches("import {app} from 'electron';", layerRules.networkRegistration), []);
    assert.notDeepEqual(forbiddenMatches("const load = () => import('electron');", layerRules.networkRegistration), []);
    assert.notDeepEqual(
        forbiddenMatches("import type {Tui} from '../../tui/types.js';", layerRules.networkRegistration),
        []
    );
    const missed = classify(
        [...discoverScannedFiles(), 'main/applications/mobileaccess/remote-access/new/submodule.ts'],
        layers
    );
    assert.deepEqual(missed.unclassified, ['main/applications/mobileaccess/remote-access/new/submodule.ts']);
    for (const dependency of ['ws', 'node:crypto', './connection-runtime.js']) {
        assert.notDeepEqual(
            forbiddenMatches(`import { value } from '${dependency}';`, layerRules.networkRegistration),
            []
        );
    }
    for (const file of [...layers.business, ...layers.composition]) {
        assert.doesNotMatch(source(file), /(?:from\s*|import\s*\(\s*)['"][^'"]*remote-access\//);
    }
});
