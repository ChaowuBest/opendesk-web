import { beforeEach, describe, expect, jest, test } from '@jest/globals';

const openPathMock = jest.fn<() => Promise<string>>();

const settingData = {
    network_config: {
        no_ssl: false,
        use_proxy: 'system',
        custom_proxy_addr: '',
        no_proxy: ''
    }
};

jest.unstable_mockModule('electron', () => ({
    shell: { openPath: openPathMock }
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
    electron: jest.fn(() => ({ shell: { openPath: openPathMock } }))
}));

jest.unstable_mockModule('../../../main/utils/electron-ipc.js', () => ({
    safeSendToWebContents: jest.fn(),
    safeSendToWebFrame: jest.fn()
}));

jest.unstable_mockModule('../../../main/utils/logger.js', () => ({
    logger: {
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    }
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
    isHostInNoProxy: jest.fn(() => false)
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
const { logger } = await import('../../../main/utils/logger.js');

describe('ElectronPlatform.openPath 挂起兜底', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        openPathMock.mockReset();
    });

    test('上游正常 settle 时立即返回，不等待超时', async () => {
        openPathMock.mockResolvedValue('');
        const platform = new ElectronPlatform();

        await platform.openPath('/tmp/a.txt');

        expect(openPathMock).toHaveBeenCalledWith('/tmp/a.txt');
        expect(logger.warn).not.toHaveBeenCalled();
    });

    test('上游 promise 永不 settle（Linux xdg-open 缺陷）时按超时放行并告警', async () => {
        jest.useFakeTimers();
        // 模拟上游缺陷：promise 永远 pending
        openPathMock.mockReturnValue(new Promise<string>(() => {}));
        const platform = new ElectronPlatform();

        const pending = platform.openPath('/tmp/hang.txt');
        // 上游挂起时不放行：即使 event loop 空转多个宏任务也保持等待
        await jest.advanceTimersByTimeAsync(4999);
        let settled = false;
        void pending.then(() => {
            settled = true;
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(settled).toBe(false);

        // 到达 5s 上限后放行调用方，且记录诊断日志
        await jest.advanceTimersByTimeAsync(1);
        await pending;
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('openPath not settled in 5000ms'));
        jest.useRealTimers();
    });

    test('超时放行后上游才 reject 不产生 unhandled rejection', async () => {
        jest.useFakeTimers();
        let rejectFn: (reason: Error) => void = () => {};
        openPathMock.mockReturnValue(
            new Promise<string>((_resolve, reject) => {
                rejectFn = reject;
            })
        );
        const platform = new ElectronPlatform();

        const pending = platform.openPath('/tmp/late-reject.txt');
        await jest.advanceTimersByTimeAsync(5000);
        await pending;

        // 放行之后上游才失败：应被兜底捕获并记日志，而非 unhandled rejection
        rejectFn(new Error('boom'));
        await jest.advanceTimersByTimeAsync(0);
        expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('openPath rejected'));
        jest.useRealTimers();
    });
});
