import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * 渲染进程特性状态助手（renderer/features.js）的拉取与推送行为。
 *
 * 关键回归点：主进程的 features:getState handler 可能比渲染进程首次调用稍晚就绪，
 * 首次拉取失败必须重试，不能把状态永久钉在「无禁用」上。
 */

type FeatureSnapshot = {
    disabledFeatures?: string[];
    disabledApplications?: string[];
    features?: unknown[];
};

type FeaturesModule = {
    initFeatureState: () => void;
    whenFeatureStateReady: () => Promise<void>;
    isFeatureDisabled: (id: string) => boolean;
    isApplicationDisabledByFeature: (name: string) => boolean;
    onFeaturesChanged: (listener: (state: FeatureSnapshot) => void) => () => void;
};

describe('renderer feature state', () => {
    let pushListeners: Array<(state: FeatureSnapshot) => void>;
    let getState: jest.Mock<() => Promise<FeatureSnapshot>>;

    beforeEach(() => {
        jest.resetModules();
        pushListeners = [];
        getState = jest.fn<() => Promise<FeatureSnapshot>>();
        const fakeWindow = {
            featuresAPI: {
                getState,
                onChanged: (listener: (state: FeatureSnapshot) => void) => {
                    pushListeners.push(listener);
                    return () => undefined;
                }
            }
        };
        Object.assign(globalThis, { window: fakeWindow });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    async function loadModule(): Promise<FeaturesModule> {
        return (await import('../../../renderer/features.js')) as unknown as FeaturesModule;
    }

    it('首次 getState 失败后按退避重试并最终就绪', async () => {
        getState
            .mockRejectedValueOnce(new Error("No handler registered for 'features:getState'"))
            .mockResolvedValueOnce({ disabledFeatures: ['memory'], disabledApplications: [] });

        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const features = await loadModule();
        await features.whenFeatureStateReady();
        // 首次失败：状态保持默认，不阻塞组件渲染
        expect(features.isFeatureDisabled('memory')).toBe(false);

        // 重试成功后状态生效
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(getState).toHaveBeenCalledTimes(2);
        expect(features.isFeatureDisabled('memory')).toBe(true);
        expect(features.isFeatureDisabled('filesystem')).toBe(false);
        expect(warn).not.toHaveBeenCalled();
    });

    it('重试耗尽后保持默认状态并告警', async () => {
        getState.mockRejectedValue(new Error('features ipc unavailable'));
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const features = await loadModule();
        await new Promise((resolve) => setTimeout(resolve, 1200));

        expect(features.isFeatureDisabled('memory')).toBe(false);
        expect(warn).toHaveBeenCalled();
    });

    it('features:changed 推送更新特性与应用禁用状态并通知订阅者', async () => {
        getState.mockResolvedValue({ disabledFeatures: [], disabledApplications: [] });
        const features = await loadModule();
        await features.whenFeatureStateReady();

        const changes: FeatureSnapshot[] = [];
        const unsubscribe = features.onFeaturesChanged((state) => changes.push(state));

        for (const listener of pushListeners) {
            listener({ disabledFeatures: ['filesystem'], disabledApplications: ['filemgr'] });
        }
        expect(features.isFeatureDisabled('filesystem')).toBe(true);
        expect(features.isApplicationDisabledByFeature('filemgr')).toBe(true);
        expect(changes.length).toBe(1);

        unsubscribe();
        for (const listener of pushListeners) {
            listener({ disabledFeatures: [], disabledApplications: [] });
        }
        expect(features.isApplicationDisabledByFeature('filemgr')).toBe(false);
        // 已注销的订阅者不再收到通知
        expect(changes.length).toBe(1);
    });

    it('缺失或异常载荷按空状态处理', async () => {
        getState.mockResolvedValue({ disabledFeatures: null, disabledApplications: 'oops' } as never);
        const features = await loadModule();
        await features.whenFeatureStateReady();

        expect(features.isFeatureDisabled('memory')).toBe(false);
        expect(features.isApplicationDisabledByFeature('filemgr')).toBe(false);
    });
});
