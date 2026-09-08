import { jest } from '@jest/globals';

// ── 可变状态 ────────────────────────────────────────────────

const bridgeState = {
    running: false,
    startCalls: 0,
    stopCalls: 0,
    updateConfigCalls: 0
};

let agentGateRuntimeAvailable = true;

const settingData: any = {
    applications: {
        agentgate: {
            enabled: false,
            securityLevel: 'medium',
            floatingWindowEnabled: false,
            maliciousSkillDetection: true
        }
    },
    debug: {},
    models: [],
    providers: []
};

const mockBridge = {
    start: jest.fn(() => {
        bridgeState.running = true;
        bridgeState.startCalls++;
    }),
    stop: jest.fn(() => {
        bridgeState.running = false;
        bridgeState.stopCalls++;
    }),
    isRunning: jest.fn(() => bridgeState.running),
    setLocalRuntimeUnavailable: jest.fn(() => {
        bridgeState.running = false;
    }),
    updateConfig: jest.fn(() => {
        if (!settingData.applications?.agentgate?.enabled) return;
        bridgeState.updateConfigCalls++;
    }),
    getStatus: jest.fn(() => ({
        running: bridgeState.running,
        lastError: null,
        mossPort: 9090,
        gatePort: 9100,
        mossRunning: bridgeState.running,
        gateRunning: bridgeState.running,
        llmAvailable: bridgeState.running
    }))
};

const mockEventsCache = {
    setPushCallback: jest.fn(),
    startPolling: jest.fn(),
    stopPolling: jest.fn(),
    isPolling: jest.fn(() => false),
    shouldPoll: jest.fn(() => false),
    getRecentEvents: jest.fn(() => []),
    getInstance: jest.fn(() => mockEventsCache)
};

// ── ESM mock（unstable_mockModule 不提升，变量已初始化） ─────

jest.unstable_mockModule('../../../../packages/app-sdk/src/index.js', () => ({
    BaseApplication: class {
        bundleName: string;
        showIcon: boolean;
        eventSubscribers = new Map();
        registry: any;
        constructor(b: string, s = true) {
            this.bundleName = b;
            this.showIcon = s;
        }
        getName() {
            return this.bundleName;
        }
        static getWorkerClass() {
            return undefined;
        }
        static getConfigSchema() {
            return { parse: (v: any) => v, extend: () => ({ parse: (v: any) => v }) };
        }
        isExperimental() {
            return false;
        }
        toJSON() {
            return {
                bundleName: this.bundleName,
                name: this.getName(),
                showIcon: this.showIcon,
                isExperimental: false,
                needAgentBar: false
            };
        }
        getConfig() {
            return settingData.applications?.[this.bundleName];
        }
        onConfigChanged() {}
        async beforeExit() {}
        async getToolsets() {
            return [];
        }
        async getSkills() {
            return [];
        }
        async getSupportedEvents() {
            return [];
        }
        needAgentBar() {
            return false;
        }
        setRegistry(r: any) {
            this.registry = r;
        }
        getDataDirectory() {
            return '/tmp/opendesk-test/apps/' + this.bundleName;
        }
        async callWorker() {
            throw new Error('no worker');
        }
        sendEventToSubscribers() {}
    },
    BaseWorker: class {},
    setOpenDeskAppHost: jest.fn()
}));

jest.unstable_mockModule('../../../main/applications/agentgate/agent-gate-bridge.js', () => ({
    AgentGateBridge: { getInstance: () => mockBridge }
}));

jest.unstable_mockModule('../../../main/applications/agentgate/events-cache.js', () => ({
    AgentGateEventsCache: mockEventsCache
}));

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/local-runtime.js', () => ({
    getHarmonyLocalRuntimeFeatureAvailability: jest.fn(() => ({
        available: agentGateRuntimeAvailable,
        reason: agentGateRuntimeAvailable ? null : 'tablet-local-runtime-disabled',
        missing: agentGateRuntimeAvailable ? [] : ['node']
    }))
}));

jest.unstable_mockModule('../../../main/applications/agentgate/worker.js', () => ({
    default: class {
        static getWorkerClass() {
            return undefined;
        }
    }
}));

jest.unstable_mockModule('../../../main/applications/skillmgr/blacklist.js', () => ({
    readInterceptionRecords: jest.fn(() => []),
    saveInterceptionRecord: jest.fn(),
    updateInterceptionAttribution: jest.fn(),
    isBlacklisted: jest.fn(() => false),
    isSkillNameBlacklisted: jest.fn(() => false),
    getBlacklistedSkillDirectories: jest.fn(() => [])
}));

jest.unstable_mockModule('../../../main/applications/agentgate/skillAttribution.js', () => ({
    attributeBatchInterceptions: jest.fn(),
    attributeInterception: jest.fn(),
    confidenceWeight: jest.fn((c: string) => ['certain', 'high', 'medium', 'low', 'contextual'].indexOf(c)),
    sortByConfidenceDesc: jest.fn()
}));

jest.unstable_mockModule('../../../main/aikernel/hooks.js', () => ({
    // registry.ts → aikernel/skill.js 顶层会调 GlobalHooks.afterToolcallParse 注册钩子，
    // mock 必须提供全部被顶层调用的方法，否则模块加载即 TypeError
    GlobalHooks: {
        beforeToolCall: jest.fn(),
        afterFinishTurn: jest.fn(),
        afterToolcallParse: jest.fn()
    }
}));

jest.unstable_mockModule('../../../main/aikernel/states/tasks.js', () => ({
    TaskState: class {}
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
    // ESM loader 对命名导入严格校验：app.ts → ApplicationRegistry 的 import 链会连带
    // 加载 aikernel/messages.ts（import { logger, getDebugMode }）等模块，
    // mock 必须覆盖真实模块的全部被引用导出，否则 SyntaxError: does not provide an export
    getDebugMode: jest.fn().mockReturnValue(false),
    setDebugMode: jest.fn(),
    LogStream: class {}
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => {
    class Setting {
        static getInstance() {
            return {
                getData: () => settingData,
                setData: (d: any) => {
                    Object.assign(settingData, d);
                },
                getApplicationConfig: (name: string) => settingData.applications?.[name],
                getModelInstance: () => undefined
            };
        }
        static clearCache() {}
        static updateInstanceData(d: any) {
            Object.assign(settingData, d);
        }
    }
    return { Setting, getOpendeskDirectory: () => '/tmp/opendesk-test' };
});

// ── 动态导入（在 mock 注册和变量初始化之后） ──────────────────

const { AgentGateApplication } = await import('../../../main/applications/agentgate/app');
const { Setting } = await import('../../../main/utils/setting.js');

// ── 辅助 ────────────────────────────────────────────────────

function setSettingData(enabled: boolean, extra?: Record<string, any>) {
    Setting.getInstance().setData({
        applications: {
            agentgate: {
                enabled,
                securityLevel: 'medium',
                floatingWindowEnabled: false,
                maliciousSkillDetection: true,
                ...extra
            }
        },
        debug: {},
        models: [],
        providers: []
    });
}

// ── 测试 ────────────────────────────────────────────────────

describe('AgentGateApplication 启停逻辑', () => {
    let app: InstanceType<typeof AgentGateApplication>;

    beforeEach(() => {
        agentGateRuntimeAvailable = true;
        bridgeState.running = false;
        bridgeState.startCalls = 0;
        bridgeState.stopCalls = 0;
        bridgeState.updateConfigCalls = 0;
        jest.clearAllMocks();

        Setting.updateInstanceData({
            applications: { agentgate: { enabled: false, securityLevel: 'medium' } }
        });

        app = new AgentGateApplication();
    });

    test('enabled 默认 false 时 startRuntime 不启动 bridge', () => {
        app.startRuntime();
        expect(bridgeState.running).toBe(false);
        expect(bridgeState.startCalls).toBe(0);
    });

    test('enabled=true 时 _syncBridgeState 启动 bridge', () => {
        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);
        expect(bridgeState.startCalls).toBe(1);
    });

    test('tablet 本地运行时不可用时不启动 bridge', () => {
        agentGateRuntimeAvailable = false;
        setSettingData(true);

        app.syncRuntimeState();

        expect(bridgeState.running).toBe(false);
        expect(bridgeState.startCalls).toBe(0);
    });

    test('enabled=false 时 _syncBridgeState 停止 bridge', () => {
        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);

        setSettingData(false);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(false);
        expect(bridgeState.stopCalls).toBe(1);
    });

    test('onConfigChanged 在 enabled=false 时不调用 updateConfig', () => {
        setSettingData(false);
        app.onConfigChanged();
        expect(bridgeState.updateConfigCalls).toBe(0);
    });

    test('onConfigChanged 在 enabled=true 时调用 updateConfig', () => {
        setSettingData(true);
        app.onConfigChanged();
        expect(bridgeState.updateConfigCalls).toBe(1);
    });

    test('用户关闭 enabled 后 onConfigChanged 不触发重启', () => {
        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);

        setSettingData(false);
        app.onConfigChanged();
        expect(bridgeState.updateConfigCalls).toBe(0);
        expect(bridgeState.running).toBe(false);
    });

    test('beforeExit 停止 bridge', async () => {
        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);

        await app.beforeExit();
        expect(bridgeState.running).toBe(false);
        expect(bridgeState.stopCalls).toBeGreaterThanOrEqual(1);
    });

    test('从 enabled=true 切换到 enabled=false 再切回 true，bridge 正确启停', () => {
        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);

        setSettingData(false);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(false);

        setSettingData(true);
        app.syncRuntimeState();
        expect(bridgeState.running).toBe(true);
        expect(bridgeState.startCalls).toBe(2);
    });

    test('enabled=false 时修改其他配置不启动 bridge', () => {
        setSettingData(false, { securityLevel: 'high' });
        app.onConfigChanged();
        expect(bridgeState.running).toBe(false);
        expect(bridgeState.startCalls).toBe(0);
        expect(bridgeState.updateConfigCalls).toBe(0);
    });
});
