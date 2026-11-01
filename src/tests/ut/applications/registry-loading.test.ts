import { describe, expect, jest, test } from '@jest/globals';
import { BaseApplication } from '../../../main/applications/base.js';
import { ApplicationRegistry } from '../../../main/applications/registry.js';
import { AgentRegistry } from '../../../main/aikernel/agents/registry.js';

class DeferredApplication extends BaseApplication {
    loadCount = 0;
    private readonly waitUntilReleased: Promise<void>;

    constructor(waitUntilReleased: Promise<void>) {
        super('deferred-test', false);
        this.waitUntilReleased = waitUntilReleased;
    }

    getName(): string {
        return 'Deferred Test';
    }

    async ensureLoaded(): Promise<void> {
        this.loadCount += 1;
        await this.waitUntilReleased;
    }
}

describe('ApplicationRegistry full loading barrier', () => {
    test('shares one loading promise across concurrent and later callers', async () => {
        const originalApplications = ApplicationRegistry.applications;
        const originalPromise = (ApplicationRegistry as any).fullyLoadedPromise;
        const originalApplicationPromises = (ApplicationRegistry as any).applicationLoadPromises;
        let release: (() => void) | undefined;
        const waitUntilReleased = new Promise<void>((resolve) => {
            release = resolve;
        });
        const application = new DeferredApplication(waitUntilReleased);

        try {
            ApplicationRegistry.applications = new Map([[application.bundleName, application]]);
            (ApplicationRegistry as any).fullyLoadedPromise = undefined;
            (ApplicationRegistry as any).applicationLoadPromises = new Map();

            const first = ApplicationRegistry.ensureFullyLoaded();
            const second = ApplicationRegistry.ensureFullyLoaded();

            expect(second).toBe(first);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(application.loadCount).toBe(1);

            release?.();
            await first;

            expect(ApplicationRegistry.ensureFullyLoaded()).toBe(first);
            expect(application.loadCount).toBe(1);
        } finally {
            release?.();
            ApplicationRegistry.applications = originalApplications;
            (ApplicationRegistry as any).fullyLoadedPromise = originalPromise;
            (ApplicationRegistry as any).applicationLoadPromises = originalApplicationPromises;
        }
    });

    test('loads only the requested application and memoizes it', async () => {
        const originalApplications = ApplicationRegistry.applications;
        const originalApplicationPromises = (ApplicationRegistry as any).applicationLoadPromises;
        const target = new DeferredApplication(Promise.resolve());
        const other = new DeferredApplication(Promise.resolve());

        try {
            ApplicationRegistry.applications = new Map([
                ['target-app', target],
                ['other-app', other]
            ]);
            (ApplicationRegistry as any).applicationLoadPromises = new Map();

            const first = ApplicationRegistry.ensureApplicationLoaded('target-app');
            const second = ApplicationRegistry.ensureApplicationLoaded('target-app');
            expect(second).toBe(first);

            await first;
            expect(target.loadCount).toBe(1);
            // 打开单个应用不该顺带加载其它应用（首次打开插件中心慢的根因）
            expect(other.loadCount).toBe(0);

            await ApplicationRegistry.ensureApplicationLoaded('target-app');
            expect(target.loadCount).toBe(1);
        } finally {
            ApplicationRegistry.applications = originalApplications;
            (ApplicationRegistry as any).applicationLoadPromises = originalApplicationPromises;
        }
    });

    test('full barrier keeps the agents registered by an earlier individual load', async () => {
        const originalApplications = ApplicationRegistry.applications;
        const originalPromise = (ApplicationRegistry as any).fullyLoadedPromise;
        const originalApplicationPromises = (ApplicationRegistry as any).applicationLoadPromises;
        const application = new DeferredApplication(Promise.resolve());
        const unloadSpy = jest.spyOn(AgentRegistry, 'unloadApplicationAgents');

        try {
            ApplicationRegistry.applications = new Map([[application.bundleName, application]]);
            (ApplicationRegistry as any).fullyLoadedPromise = undefined;
            (ApplicationRegistry as any).applicationLoadPromises = new Map();

            // 模拟 openApplication 先把该应用单独加载过（Agent 已注册）
            await ApplicationRegistry.ensureApplicationLoaded(application.bundleName);
            expect(application.loadCount).toBe(1);

            // 全量屏障不能整体卸载应用 Agent：卸载发生在个体加载之后时，被卸载的 Agent
            // 不会随记忆化的 ensureLoaded() 重新注册，等于把应用 Agent 弄丢
            await ApplicationRegistry.ensureFullyLoaded();
            expect(unloadSpy).not.toHaveBeenCalled();
            expect(application.loadCount).toBe(1);
        } finally {
            unloadSpy.mockRestore();
            ApplicationRegistry.applications = originalApplications;
            (ApplicationRegistry as any).fullyLoadedPromise = originalPromise;
            (ApplicationRegistry as any).applicationLoadPromises = originalApplicationPromises;
        }
    });

    test('swallows per-application load failures so opening an app keeps working', async () => {
        const originalApplications = ApplicationRegistry.applications;
        const originalApplicationPromises = (ApplicationRegistry as any).applicationLoadPromises;
        class FailingApplication extends DeferredApplication {
            constructor() {
                super(Promise.resolve());
            }

            async ensureLoaded(): Promise<void> {
                throw new Error('boom');
            }
        }
        // 非 async 实现可以同步抛出：不能被吞成未捕获异常，也不能让打开应用直接失败
        class SyncThrowingApplication extends DeferredApplication {
            constructor() {
                super(Promise.resolve());
            }

            ensureLoaded(): Promise<void> {
                throw new Error('sync boom');
            }
        }
        const application = new FailingApplication();
        const syncThrowing = new SyncThrowingApplication();

        try {
            ApplicationRegistry.applications = new Map([
                [application.bundleName, application],
                ['sync-throwing-app', syncThrowing]
            ]);
            (ApplicationRegistry as any).applicationLoadPromises = new Map();

            await expect(ApplicationRegistry.ensureApplicationLoaded(application.bundleName)).resolves.toBeUndefined();
            await expect(ApplicationRegistry.ensureApplicationLoaded('sync-throwing-app')).resolves.toBeUndefined();
        } finally {
            ApplicationRegistry.applications = originalApplications;
            (ApplicationRegistry as any).applicationLoadPromises = originalApplicationPromises;
        }
    });
});
