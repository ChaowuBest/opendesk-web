import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import os from 'os';
import path from 'path';

const setProxy = jest.fn(async () => undefined);
const sessionFetch = jest.fn(async () => new Response('harmonyos-proxy'));
const fromPartition = jest.fn(() => ({
    setProxy,
    fetch: sessionFetch,
    setCertificateVerifyProc: jest.fn()
}));

const settingData = {
    network_config: {
        no_ssl: false,
        use_proxy: 'system',
        custom_proxy_addr: '',
        no_proxy: ''
    }
};

const getHarmonyOSSystemProxyMock = jest.fn(async () => null);

jest.unstable_mockModule('electron', () => ({
    net: { fetch: jest.fn() },
    session: { fromPartition }
}));

jest.unstable_mockModule('../../../platforms/worker.js', () => ({
    WorkerPlatform: class {}
}));

jest.unstable_mockModule('../../../platforms/applications.js', () => ({
    getGuiApplicationClasses: () => []
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
    isOpenDeskPresentationProgramAvailable: jest.fn(async () => false),
    openOpenDeskSlidesPresentation: jest.fn(),
    runOpenDeskPresentationProgram: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/proxy.js', () => ({
    isHostInNoProxy: jest.fn(() => false),
    resolveProxyUrl: jest.fn(async () => null)
}));

jest.unstable_mockModule('../../../main/utils/setting.js', () => ({
    // electron.ts 间接依赖 logger（openPath 兜底诊断），其顶层初始化需要日志目录
    getLogDirectory: () => path.join(os.tmpdir(), 'opendesk-test-logs'),
    Setting: {
        getInstance: () => ({
            getData: () => settingData
        })
    }
}));

jest.unstable_mockModule('../../../platforms/bridges/harmonyos/proxy.js', () => ({
    getHarmonyOSSystemProxy: getHarmonyOSSystemProxyMock,
    invalidateHarmonyOSSystemProxyCache: jest.fn()
}));

const originalPlatform = process.platform;

function setPlatform(p: string): void {
    Object.defineProperty(process, 'platform', {
        value: p,
        configurable: true
    });
}

describe('HarmonyOS system proxy bridge', () => {
    let ElectronPlatform: any;

    beforeEach(async () => {
        jest.resetModules();
        setProxy.mockClear();
        sessionFetch.mockClear();
        fromPartition.mockClear();
        getHarmonyOSSystemProxyMock.mockReset();
        setPlatform('openharmony');
        settingData.network_config.use_proxy = 'system';
        settingData.network_config.custom_proxy_addr = '';

        const mod = await import('../../../platforms/electron.js');
        ElectronPlatform = mod.ElectronPlatform;
    });

    afterEach(() => {
        setPlatform(originalPlatform);
    });

    test('system mode bridges to ArkTS and uses fixed_servers on OpenHarmony', async () => {
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'proxy.example.com',
            port: 8080,
            exclusionList: ['intranet.example.com']
        });

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(getHarmonyOSSystemProxyMock).toHaveBeenCalledTimes(1);
        expect(setProxy).toHaveBeenCalledWith({
            mode: 'fixed_servers',
            proxyRules: 'http=proxy.example.com:8080;https=proxy.example.com:8080',
            proxyBypassRules: 'intranet.example.com;<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
        });
    });

    test('degrades to system mode when bridge returns no proxy', async () => {
        getHarmonyOSSystemProxyMock.mockResolvedValue(null);

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(getHarmonyOSSystemProxyMock).toHaveBeenCalledTimes(1);
        expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
    });

    test('degrades to system mode when bridge throws', async () => {
        getHarmonyOSSystemProxyMock.mockRejectedValue(new Error('ArkTS bridge unavailable'));

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
    });

    test('does not call bridge when use_proxy is none', async () => {
        settingData.network_config.use_proxy = 'none';

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(getHarmonyOSSystemProxyMock).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    });

    test('does not call bridge when use_proxy is custom', async () => {
        settingData.network_config.use_proxy = 'custom';
        settingData.network_config.custom_proxy_addr = 'http://custom-proxy:9090';

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(getHarmonyOSSystemProxyMock).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({
            mode: 'fixed_servers',
            proxyRules: 'http=custom-proxy:9090;https=custom-proxy:9090',
            proxyBypassRules: '<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
        });
    });

    test('does not call bridge on non-OpenHarmony platforms', async () => {
        setPlatform('win32');

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(getHarmonyOSSystemProxyMock).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({ mode: 'system' });
    });

    test('exclusionList is omitted when empty', async () => {
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'proxy.example.com',
            port: 3128,
            exclusionList: []
        });

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(setProxy).toHaveBeenCalledWith({
            mode: 'fixed_servers',
            proxyRules: 'http=proxy.example.com:3128;https=proxy.example.com:3128',
            proxyBypassRules: '<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
        });
    });

    test('strips protocol prefix from host when HarmonyOS returns it', async () => {
        getHarmonyOSSystemProxyMock.mockResolvedValue({
            host: 'http://124.70.231.74',
            port: 8080,
            exclusionList: []
        });

        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models');

        expect(setProxy).toHaveBeenCalledWith({
            mode: 'fixed_servers',
            proxyRules: 'http=124.70.231.74:8080;https=124.70.231.74:8080',
            proxyBypassRules: '<local>;localhost;*.localhost;127.0.0.1;127.*;[::1]'
        });
    });

    test('bypassProxy option skips bridge and uses direct mode', async () => {
        const platform = new ElectronPlatform();
        await platform.fetch('https://model.example.com/v1/models', undefined, {
            bypassProxy: true
        });

        expect(getHarmonyOSSystemProxyMock).not.toHaveBeenCalled();
        expect(setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    });
});
