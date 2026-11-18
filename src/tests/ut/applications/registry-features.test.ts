import { describe, expect, jest, test } from '@jest/globals';
import { BaseApplication } from '../../../main/applications/base.js';
import {
    ApplicationRegistry,
    ensureFeatureDisableSubscription,
    ensureFeatureWorkerSync
} from '../../../main/applications/registry.js';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';

class StubApplication extends BaseApplication {
    loadCount = 0;

    constructor(bundleName: string, showIcon = true) {
        super(bundleName, showIcon);
    }

    getName(): string {
        return this.bundleName;
    }

    async ensureLoaded(): Promise<void> {
        this.loadCount += 1;
    }

    async getSupportedEvents() {
        return [{ eventName: 'onStatusChanged', eventDescription: 'status' }];
    }
}

describe('ApplicationRegistry feature-disable gating', () => {
    let originalApplications: Map<string, BaseApplication>;

    beforeEach(() => {
        resetFeatureManagerForTests();
        originalApplications = ApplicationRegistry.applications;
        ApplicationRegistry.applications = new Map([
            ['filemgr', new StubApplication('filemgr')],
            ['other', new StubApplication('other')]
        ]);
    });

    afterEach(() => {
        ApplicationRegistry.applications = originalApplications;
        resetFeatureManagerForTests();
    });

    test('禁用应用在列表中表现为 showIcon=false', () => {
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);

        const list = ApplicationRegistry.getApplicationList() as Array<{
            bundleName: string;
            showIcon?: boolean;
        }>;
        const filemgr = list.find((app) => app.bundleName === 'filemgr');
        const other = list.find((app) => app.bundleName === 'other');
        expect(filemgr?.showIcon).toBe(false);
        // 其它应用的 showIcon 保持原值（构造时默认 true）
        expect(other?.showIcon).toBe(true);

        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', false);
        const restored = ApplicationRegistry.getApplicationList() as Array<{
            bundleName: string;
            showIcon?: boolean;
        }>;
        expect(restored.find((app) => app.bundleName === 'filemgr')?.showIcon).toBe(true);
    });

    test('禁用应用不再触发延迟加载', async () => {
        const application = ApplicationRegistry.applications.get('filemgr') as StubApplication;
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);

        await ApplicationRegistry.ensureApplicationLoaded('filemgr');
        expect(application.loadCount).toBe(0);

        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', false);
        await ApplicationRegistry.ensureApplicationLoaded('filemgr');
        expect(application.loadCount).toBe(1);
    });

    test('禁用应用的工具集不进入任务', async () => {
        const application = ApplicationRegistry.applications.get('filemgr') as StubApplication;
        const toolset = { name: 'filemgr' };
        application.getToolsets = jest.fn(async () => [toolset as any]);
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);

        const result = await ApplicationRegistry.listAvailableToolsets();
        expect(result).toEqual([]);
        expect(application.getToolsets).not.toHaveBeenCalled();
    });

    test('禁用应用的事件不派发给订阅者', async () => {
        const events: string[] = [];
        const unsubscribe = ApplicationRegistry.onApplicationEvent((bundleName, eventName) => {
            events.push(`${bundleName}:${eventName}`);
        });
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);

        ApplicationRegistry.dispatchEvent('filemgr', 'onStatusChanged', { status: 'running' });
        // notifyApplicationEventListeners 经 Promise.resolve 异步派发，先 flush 再断言
        await Promise.resolve();
        expect(events).toEqual([]);

        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', false);
        ApplicationRegistry.dispatchEvent('filemgr', 'onStatusChanged', { status: 'running' });
        await Promise.resolve();
        expect(events).toEqual(['filemgr:onStatusChanged']);
        unsubscribe();
    });

    test('禁用应用不响应 callWorker', async () => {
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);
        const result = await ApplicationRegistry.callWorker('filemgr', 'searchIndexedFiles', 'query');
        expect(result.status).toBe('error');
        // 面向用户的错误文案走 locale（中文环境回落中文），这里只断言带上了应用名
        expect(String(result.message)).toContain('filemgr');
    });

    test('禁用应用不进入支持事件清单', async () => {
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);
        const events = await ApplicationRegistry.getAllSupportedEvents();
        expect(events.has('filemgr')).toBe(false);
        expect(events.has('other')).toBe(true);
    });

    test('应用禁用变更触发应用列表变更通知', () => {
        ensureFeatureDisableSubscription();
        const notifications: number[] = [];
        // onApplicationListChanged 只接收回调、不返回注销函数，测试后需手动移除
        const callback = () => notifications.push(1);
        ApplicationRegistry.onApplicationListChanged(callback);
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', true);
        expect(notifications.length).toBe(1);
        getFeatureManager().setApplicationDisabled('filemgr', 'plugin-a', false);
        expect(notifications.length).toBe(2);
        ApplicationRegistry['applicationListChangedCallbacks'] = ApplicationRegistry[
            'applicationListChangedCallbacks'
        ].filter((candidate: unknown) => candidate !== callback);
    });

    // 放在最后：ensureFeatureWorkerSync 的订阅是模块级幂等的，注册后本文件其余用例
    // 触发的特性变更也会走推送路径
    test('特性禁用变更同步到 worker 线程', async () => {
        ensureFeatureWorkerSync();
        const postMessage = jest.fn((message: { requestId?: string }) => {
            const requestId = message?.requestId;
            if (requestId) {
                ApplicationRegistry.pendingRequests.get(requestId)?.resolve(undefined);
            }
        });
        jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
        jest.spyOn(ApplicationRegistry, 'getGlobalWorker').mockReturnValue({ postMessage } as never);

        try {
            getFeatureManager().setFeatureDisabled('filesystem', 'plugin-a', true);
            // 订阅回调是 fire-and-forget，等微任务与 IO 回调清空后断言
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(postMessage).toHaveBeenCalledWith(
                expect.objectContaining({
                    bundleName: '__system',
                    methodName: '__updateDisabledFeatures',
                    args: [['filesystem'], []]
                })
            );
        } finally {
            jest.restoreAllMocks();
        }
    });
});
