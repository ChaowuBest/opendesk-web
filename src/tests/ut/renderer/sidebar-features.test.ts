import { beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { parseHTML } from 'linkedom';

/**
 * 插件通过 ctx.features.disableFeature 禁用 memory / filesystem 特性后，
 * 侧边栏底部工具栏的记忆与文件系统入口必须隐藏；禁用解除后恢复。
 *
 * 状态统一走 features:changed 推送路径驱动（与生产一致：features.js 只在首次
 * 初始化时拉取一次 getState，之后的变更全部依赖主进程推送）。
 */
describe('侧边栏底部工具栏特性门控', () => {
    let sidebar: HTMLElement;

    interface FeatureStateFixture {
        disabledFeatures: string[];
        disabledApplications: string[];
    }

    let featuresState: FeatureStateFixture;
    let featuresPushListeners: Set<(state: FeatureStateFixture) => void>;

    const findToolbarButton = (id: string) => sidebar.querySelector<HTMLElement>(`[id^="${id}-"]`);

    beforeAll(async () => {
        const { window } = parseHTML('<!doctype html><html><body></body></html>');
        Object.assign(globalThis, {
            window,
            document: window.document,
            HTMLElement: window.HTMLElement,
            CustomEvent: window.CustomEvent,
            Event: window.Event,
            customElements: window.customElements,
            MutationObserver: class {
                observe() {}
                disconnect() {}
            },
            ResizeObserver: class {
                observe() {}
                unobserve() {}
                disconnect() {}
            },
            localStorage: {
                getItem: () => null,
                setItem: () => undefined,
                removeItem: () => undefined
            }
        });
        featuresPushListeners = new Set();
        featuresState = { disabledFeatures: [], disabledApplications: [] };
        window.featuresAPI = {
            getState: async () => featuresState,
            onChanged: (listener: (state: FeatureStateFixture) => void) => {
                featuresPushListeners.add(listener);
                return () => featuresPushListeners.delete(listener);
            }
        } as never;
        window.taskManagerAPI = {
            getTaskList: async () => [],
            subscribeTaskListUpdate: async () => () => undefined,
            log: () => undefined
        } as never;
        window.applicationRegistryAPI = {
            getApplicationList: async () => [],
            call: async () => undefined,
            callMainWorld: async () => undefined,
            subscribeEvent: async () => () => undefined,
            onApplicationListChanged: () => () => undefined
        } as never;
        window.settingAPI = {
            loadSettingObject: async () => ({}),
            onSettingChanged: () => () => undefined
        } as never;
        window.globalControlAPI = {
            openMemory: () => undefined,
            openApplication: () => undefined,
            openSettingEditor: () => undefined
        } as never;
        await import('../../../renderer/components/sidebar.js');
    });

    beforeEach(() => {
        document.body.innerHTML = '';
        featuresState = { disabledFeatures: [], disabledApplications: [] };
        sidebar = document.createElement('main-sidebar') as typeof sidebar;
        document.body.appendChild(sidebar);
    });

    /** 模拟主进程 features:changed 推送 */
    function pushFeaturesState(state: FeatureStateFixture) {
        featuresState = state;
        for (const listener of [...featuresPushListeners]) {
            listener(state);
        }
    }

    it('特性禁用时隐藏记忆与文件系统入口，保留设置入口', async () => {
        // 先让初始 getState（空状态）落地，再模拟推送禁用状态
        await Promise.resolve();
        pushFeaturesState({ disabledFeatures: ['memory', 'filesystem'], disabledApplications: [] });

        expect(findToolbarButton('open-memory-btn')).toBeNull();
        expect(findToolbarButton('open-file-system-btn')).toBeNull();
        expect(findToolbarButton('open-setting-editor-btn')).not.toBeNull();
    });

    it('特性恢复后入口重新出现', async () => {
        await Promise.resolve();
        pushFeaturesState({ disabledFeatures: ['memory', 'filesystem'], disabledApplications: [] });
        expect(findToolbarButton('open-memory-btn')).toBeNull();

        // 主进程推送 features:changed（禁用解除）
        pushFeaturesState({ disabledFeatures: [], disabledApplications: [] });

        expect(findToolbarButton('open-memory-btn')).not.toBeNull();
        expect(findToolbarButton('open-file-system-btn')).not.toBeNull();
    });

    it('filesystem 特性未禁用但 filemgr 应用被禁用时隐藏文件系统入口', async () => {
        await Promise.resolve();
        pushFeaturesState({ disabledFeatures: [], disabledApplications: ['filemgr'] });

        expect(findToolbarButton('open-memory-btn')).not.toBeNull();
        expect(findToolbarButton('open-file-system-btn')).toBeNull();
        expect(findToolbarButton('open-setting-editor-btn')).not.toBeNull();
    });
});
