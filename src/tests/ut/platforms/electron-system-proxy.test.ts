import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const setProxy = jest.fn(async () => undefined);
const sessionFetch = jest.fn(async () => new Response('system-proxy'));
const fromPartition = jest.fn(() => ({
    setProxy,
    fetch: sessionFetch,
    setCertificateVerifyProc: jest.fn()
}));
const netFetch = jest.fn(async () => new Response('default-session'));
const resolveProxyUrl = jest.fn(async () => 'http://environment-proxy:7890');

const settingData = {
    network_config: {
        no_ssl: false,
        use_proxy: 'system',
        custom_proxy_addr: '',
        no_proxy: ''
    }
};

jest.unstable_mockModule('electron', () => ({
    net: { fetch: netFetch },
    session: { fromPartition },
    systemPreferences: {}
}));

jest.unstable_mockModule('../../../platforms/worker.js', () => ({
    WorkerPlatform: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/states/tasks.js', () => ({
    BaseTaskManagerUpdateSubscriber: class {},
    BaseTaskUpdateSubscriber: class {
        subscription_id = 'test-subscription';
        wantsHtmlRender = false;
    }
}));

jest.unstable_mockModule('../../../main/aikernel/security/electronPrompt.js', () => ({
    ElectronPermissionPromptProvider: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/interaction/electronAskUser.js', () => ({
    ElectronAskUserProvider: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/interaction/electronExitPlanMode.js', () => ({
    ElectronExitPlanModeProvider: class {}
}));

jest.unstable_mockModule('../../../main/aikernel/interaction/tools.js', () => ({
    createInteractionToolset: jest.fn()
}));

jest.unstable_mockModule('../../../main/aikernel/task/mode.js', () => ({
    switchTaskMode: jest.fn()
}));

jest.unstable_mockModule('../../../platforms/bridges/main.js', () => ({
    resolveNativeBridge: jest.fn(() => null)
}));

jest.unstable_mockModule('../../../utils/electron.js', () => ({
    electron: jest.fn(() => ({ shell: {} }))
}));

jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: jest.fn(),
    safeSendToWebFrame: jest.fn()
}));

jest.unstable_mockModule('../../../main/applications/slides/app.js', () => ({
    SlidesApplication: class {}
}));

jest.unstable_mockModule('../../../main/applications/slides/provider.js', () => ({
    configureSlidesCapabilityProvider: jest.fn()
}));

jest.unstable_mockModule('../../../main/office/openDeskOfficeHost.js', () => ({
    executeOpenDeskSlidesCapability: jest.fn(),
    getOpenDeskSlidesCapabilities: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/proxy.js', () => ({
    isHostInNoProxy: jest.fn(() => false),
    resolveProxyUrl
}));

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/proxy.js', () => ({
    getHarmonyOSSystemProxy: jest.fn(async () => null),
    invalidateHarmonyOSSystemProxyCache: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    Setting: {
        getInstance: () => ({
            getData: () => settingData
        })
    }
}));

const { ElectronPlatform } = await import('../../../platforms/electron.js');

describe('Electron system proxy', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        settingData.network_config.use_proxy = 'system';
        settingData.network_config.custom_proxy_addr = '';
    });

    test('system mode uses the Windows system proxy instead of HTTP_PROXY', async () => {
        const platform = new ElectronPlatform();

        const response = await platform.fetch('https://model.example.com/v1/models', undefined, {
            forceEnvironmentProxy: true
        });

        expect(await response.text()).toBe('system-proxy');
        expect(resolveProxyUrl).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
        expect(sessionFetch).toHaveBeenCalledWith('https://model.example.com/v1/models', undefined);
        expect(netFetch).not.toHaveBeenCalled();
    });

    test('none mode bypasses both Windows and environment proxies', async () => {
        settingData.network_config.use_proxy = 'none';
        const platform = new ElectronPlatform();

        await platform.fetch('https://model.example.com/v1/models', undefined, {
            forceEnvironmentProxy: true
        });

        expect(resolveProxyUrl).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    });

    test('custom mode uses the configured proxy address', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://custom-proxy:8080';
        const platform = new ElectronPlatform();

        await platform.fetch('https://model.example.com/v1/models', undefined, {
            forceEnvironmentProxy: true
        });

        expect(resolveProxyUrl).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({
            mode: 'fixed_servers',
            proxyRules: 'http=custom-proxy:8080;https=custom-proxy:8080',
            proxyBypassRules: '<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
        });
    });
});
