import fs from 'fs';
import os from 'os';
import path from 'path';
import FileManagerWorker from '../../../main/applications/filemgr/worker.js';

/**
 * ctx.features.disableFeature('filesystem') 的 filemgr worker 门控行为：
 * 禁用时停机进入 disabled 状态，重新启用时重建索引，初始化时跳过索引启动。
 */
describe('filemgr worker filesystem 特性门控', () => {
    function createWorker(): any {
        const appDataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-filemgr-feature-'));
        return new FileManagerWorker('filemgr-feature-test', appDataDirectory);
    }

    test('setDisabledFeatures 禁用 filesystem：停机并进入 disabled 状态', async () => {
        const worker = createWorker();
        const teardownContexts: string[] = [];
        worker._teardownRuntime = async (context: string) => {
            teardownContexts.push(context);
        };
        worker._setStatus = (next: string, reason?: string) => {
            worker.status = next;
            worker._lastStatusReason = reason;
        };
        worker.runSequentially = async (fn: () => Promise<void>) => await fn();
        let initializeCalls = 0;
        worker.initialize = async () => {
            initializeCalls += 1;
        };

        await worker.setDisabledFeatures(['filesystem']);
        expect(worker._filesystemFeatureDisabled).toBe(true);
        expect(teardownContexts).toEqual(['filesystem feature disabled']);
        expect(worker.status).toBe('disabled');
        expect(initializeCalls).toBe(0);

        // 重复下发同一状态是幂等的
        await worker.setDisabledFeatures(['filesystem']);
        expect(teardownContexts).toEqual(['filesystem feature disabled']);
        expect(initializeCalls).toBe(0);
    });

    test('setDisabledFeatures 重新启用 filesystem：重新执行 initialize', async () => {
        const worker = createWorker();
        worker._filesystemFeatureDisabled = true;
        worker._teardownRuntime = async () => {};
        worker._setStatus = (next: string) => {
            worker.status = next;
        };
        worker.runSequentially = async (fn: () => Promise<void>) => await fn();
        let initializeCalls = 0;
        worker.initialize = async () => {
            initializeCalls += 1;
        };

        await worker.setDisabledFeatures([]);
        expect(worker._filesystemFeatureDisabled).toBe(false);
        expect(initializeCalls).toBe(1);
    });

    test('initialize 在特性禁用时不做任何索引初始化', async () => {
        const worker = createWorker();
        worker._filesystemFeatureDisabled = true;
        worker._setStatus = (next: string, reason?: string) => {
            worker.status = next;
            worker._lastStatusReason = reason;
        };
        let normalizeConfigCalls = 0;
        worker._normalizeConfig = (config: unknown) => {
            normalizeConfigCalls += 1;
            return config;
        };

        await worker.initialize();
        expect(worker.status).toBe('disabled');
        expect(worker._lastStatusReason).toBe('initialize-skipped-feature-disabled');
        // 跳过配置归一化与存储创建
        expect(normalizeConfigCalls).toBe(0);
        expect(worker.storage).toBeNull();
        expect(worker._initializing).toBe(false);
    });

    test('setDisabledFeatures 忽略未包含 filesystem 的列表', async () => {
        const worker = createWorker();
        worker._teardownRuntime = async () => {
            throw new Error('disable path must not run for unrelated features');
        };
        worker.initialize = async () => {
            throw new Error('enable path must not run for unrelated features');
        };

        await worker.setDisabledFeatures(['memory']);
        expect(worker._filesystemFeatureDisabled).toBe(false);
    });

    test('整个 filemgr 应用被插件禁用时同样停掉索引', async () => {
        const worker = createWorker();
        const teardownContexts: string[] = [];
        worker._teardownRuntime = async (context: string) => {
            teardownContexts.push(context);
        };
        worker._setStatus = (next: string) => {
            worker.status = next;
        };
        worker.runSequentially = async (fn: () => Promise<void>) => await fn();

        // bundleName 由构造函数传入：禁用应用自身时才停机
        await worker.setDisabledFeatures([], [worker.bundleName]);
        expect(worker._filesystemFeatureDisabled).toBe(true);
        expect(teardownContexts).toEqual(['filesystem feature disabled']);
        expect(worker.status).toBe('disabled');
    });

    test('其它应用被禁用不影响 filemgr 索引', async () => {
        const worker = createWorker();
        worker.initialize = async () => {
            throw new Error('enable path must not run for unrelated applications');
        };

        await worker.setDisabledFeatures([], ['notes']);
        expect(worker._filesystemFeatureDisabled).toBe(false);
    });
});
