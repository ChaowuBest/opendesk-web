import { beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const handlers = new Map<string, (event: unknown, ...args: any[]) => unknown>();
const broadcasts: Array<[string, unknown]> = [];
const settingData: { builtin_models: Array<{ alias: string }> } = { builtin_models: [] };
const session = {
    backendId: 'opendesk',
    kind: 'personal' as const,
    baseUrl: 'https://personal.example.com/api/v1',
    user: { id: 'u-1', username: 'alice' }
};

jest.unstable_mockModule('electron', () => ({
    BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: {} }] },
    ipcMain: {
        handle: (name: string, handler: (event: unknown, ...args: any[]) => unknown) => handlers.set(name, handler)
    }
}));
jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: (_webContents: unknown, channel: string, payload: unknown) => {
        broadcasts.push([channel, payload]);
    }
}));
jest.unstable_mockModule('../../../main/aikernel/llm.js', () => ({
    LLM: { clearAdapterCache: jest.fn() }
}));
jest.unstable_mockModule('../../../locale/index.js', () => {
    // 包装层 t 经 translateWithDomain 走统一查找链；这里按 zh-CN 内联等价实现，保持用例断言稳定
    const translateWithDomain = (
        key: string,
        domain: Record<string, Record<string, string>>,
        params?: Record<string, string | number>
    ): string => {
        let text = domain['zh-CN']?.[key] ?? key;
        if (params) {
            for (const [name, value] of Object.entries(params)) {
                text = text.replace(new RegExp(`\\$\\{${name}\\}`, 'g'), String(value));
            }
        }
        return text;
    };
    return { getLocale: () => 'zh-CN', translateWithDomain };
});
jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: { getInstance: () => ({ getData: () => settingData }) }
}));
jest.unstable_mockModule('../../../main/applications/account/backend-registry.js', () => ({
    accountBackendRegistry: { onBackendsChanged: () => () => undefined }
}));
jest.unstable_mockModule('../../../main/applications/account/factory.js', () => ({
    getAccountRuntime: () => ({
        config: {
            get: () => ({ mode: 'personal', default_base_url: '', enterprise_base_url: '' }),
            configure: (patch: unknown) => patch,
            isSetupComplete: () => true,
            isAvailable: () => true
        },
        getService: () => ({
            getSession: () => session,
            getUserInfo: async () => null,
            getLoginMethods: async () => [],
            startLogin: async () => ({ flowId: 'flow-1', state: { status: 'ready' } }),
            submitLogin: async () => ({ status: 'completed', session }),
            pollLogin: async () => ({ status: 'completed', session }),
            cancelLogin: async () => undefined,
            updateDisplayName: async () => null,
            refreshToken: async () => session,
            logout: async () => undefined
        })
    })
}));
jest.unstable_mockModule('../../../main/applications/account/model-provider.js', () => ({
    refreshBuiltinModels: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        settingData.builtin_models = [{ alias: 'opendesk/auto' }];
    }
}));

describe('account electron integration builtin model refresh', () => {
    beforeAll(async () => {
        await import('../../../main/applications/account/electron.js');
    });

    beforeEach(() => {
        handlers.clear();
        broadcasts.length = 0;
        settingData.builtin_models = [];
    });

    test('broadcasts setting:changed after builtin models are refreshed on login completion', async () => {
        const { registerElectronAccountIntegration } = await import('../../../main/applications/account/electron.js');
        registerElectronAccountIntegration();

        const poll = handlers.get('account:pollLogin');
        expect(poll).toBeDefined();
        await poll!({}, 'flow-1');

        await new Promise((resolve) => setTimeout(resolve, 40));

        expect(broadcasts[0]?.[0]).toBe('account:sessionChanged');
        const settingChanged = broadcasts.filter(([channel]) => channel === 'setting:changed');
        expect(settingChanged).toHaveLength(1);
        expect((settingChanged[0][1] as { builtin_models: unknown[] }).builtin_models).toEqual([
            { alias: 'opendesk/auto' }
        ]);
    });
});
