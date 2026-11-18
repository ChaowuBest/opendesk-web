import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import { ApplicationRegistry, notifyWorkerFeatureUpdate } from '../../../main/applications/registry.js';
import { applyDisabledFeatures, handleWorkerRequest } from '../../../main/applications/worker.js';
import { getFeatureManager, resetFeatureManagerForTests } from '../../../common/features/manager.js';
import type { BaseWorker } from '../../../main/applications/base.js';

/**
 * worker 线程的 FeatureManager 只镜像主进程推送的特性级禁用状态：
 * workerData 注入（启动）+ __updateDisabledFeatures 系统消息（运行时）两条路径，
 * 并把特性 + 应用两份列表转发给实现了 setDisabledFeatures 的 worker
 * （如 filemgr 的 AI 索引门控：filesystem 特性被禁用、或 filemgr 应用自身被禁用都要停索引）。
 */

type RecordedFrame = {
    type: string;
    id?: string;
    status?: string;
    data?: unknown;
    message?: string;
};

function makeWorker(overrides: Record<string, unknown> = {}): BaseWorker {
    return overrides as unknown as BaseWorker;
}

describe('worker 特性门控镜像', () => {
    beforeEach(() => {
        resetFeatureManagerForTests();
    });

    afterEach(() => {
        resetFeatureManagerForTests();
    });

    test('applyDisabledFeatures 镜像禁用状态并转发给支持门控的 worker', async () => {
        const setDisabledFeatures = jest.fn(async () => {});
        const workers = new Map<string, BaseWorker>([
            ['filemgr', makeWorker({ setDisabledFeatures })],
            ['terminal', makeWorker()]
        ]);

        await applyDisabledFeatures(workers, ['filesystem'], []);
        expect(getFeatureManager().isFeatureDisabled('filesystem')).toBe(true);
        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(false);
        expect(setDisabledFeatures).toHaveBeenCalledWith(['filesystem'], []);

        // 列表回退时镜像同步移除
        await applyDisabledFeatures(workers, [], []);
        expect(getFeatureManager().isFeatureDisabled('filesystem')).toBe(false);
        expect(setDisabledFeatures).toHaveBeenLastCalledWith([], []);
    });

    test('应用级禁用随同一消息转发给 worker，但不进特性镜像', async () => {
        const setDisabledFeatures = jest.fn(async () => {});
        const workers = new Map<string, BaseWorker>([['filemgr', makeWorker({ setDisabledFeatures })]]);

        await applyDisabledFeatures(workers, [], ['filemgr']);
        expect(setDisabledFeatures).toHaveBeenCalledWith([], ['filemgr']);
        // worker 线程只镜像特性级禁用，应用级列表只用于 worker 自我门控
        expect(getFeatureManager().getDisabledApplications()).toEqual([]);
        expect(getFeatureManager().isApplicationDisabled('filemgr')).toBe(false);
    });

    test('applyDisabledFeatures 返回前已同步把门控状态交给 worker（initialize 之前就位）', async () => {
        const order: string[] = [];
        const workers = new Map<string, BaseWorker>([
            [
                'filemgr',
                makeWorker({
                    setDisabledFeatures: (features: string[]) => {
                        order.push(`gate:${features.join(',')}`);
                        return Promise.resolve();
                    }
                })
            ]
        ]);

        const pending = applyDisabledFeatures(workers, ['filesystem'], []);
        // 模拟 initializeAppWorkers 紧接着同步调用 worker.initialize()
        order.push('initialize');
        await pending;

        // setDisabledFeatures 内部第一行就要设置门控标志，晚于 initialize 会让扫描先跑起来
        expect(order).toEqual(['gate:filesystem', 'initialize']);
    });

    test('转发失败向调用方抛出，由调用方捕获（不产生未处理拒绝）', async () => {
        const workers = new Map<string, BaseWorker>([
            [
                'filemgr',
                makeWorker({
                    setDisabledFeatures: jest.fn(async () => {
                        throw new Error('teardown failed');
                    })
                })
            ]
        ]);

        await expect(applyDisabledFeatures(workers, ['filesystem'], [])).rejects.toThrow('teardown failed');
    });

    test('__updateDisabledFeatures 消息应用状态并回执 ok', async () => {
        const frames: RecordedFrame[] = [];
        const setDisabledFeatures = jest.fn(async () => {});
        const workers = new Map<string, BaseWorker>([['filemgr', makeWorker({ setDisabledFeatures })]]);

        await handleWorkerRequest(
            {
                bundleName: '__system',
                requestId: 'req-feature',
                methodName: '__updateDisabledFeatures',
                args: [['memory'], ['filemgr']]
            },
            workers,
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(getFeatureManager().isFeatureDisabled('memory')).toBe(true);
        expect(setDisabledFeatures).toHaveBeenCalledWith(['memory'], ['filemgr']);
        expect(frames).toEqual([{ type: 'response', id: 'req-feature', status: 'ok', data: null }]);
    });

    test('__updateDisabledFeatures 缺少应用列表时按空列表处理', async () => {
        const frames: RecordedFrame[] = [];
        const setDisabledFeatures = jest.fn(async () => {});
        const workers = new Map<string, BaseWorker>([['filemgr', makeWorker({ setDisabledFeatures })]]);

        await handleWorkerRequest(
            {
                bundleName: '__system',
                requestId: 'req-feature-legacy',
                methodName: '__updateDisabledFeatures',
                args: [['filesystem']]
            },
            workers,
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(setDisabledFeatures).toHaveBeenCalledWith(['filesystem'], []);
        expect(frames).toEqual([{ type: 'response', id: 'req-feature-legacy', status: 'ok', data: null }]);
    });

    test('__updateDisabledFeatures 应用失败时回执 error', async () => {
        const frames: RecordedFrame[] = [];
        const workers = new Map<string, BaseWorker>([
            [
                'filemgr',
                makeWorker({
                    setDisabledFeatures: jest.fn(async () => {
                        throw new Error('index teardown failed');
                    })
                })
            ]
        ]);

        await handleWorkerRequest(
            {
                bundleName: '__system',
                requestId: 'req-feature-error',
                methodName: '__updateDisabledFeatures',
                args: [['filesystem'], []]
            },
            workers,
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(frames).toEqual([
            { type: 'response', id: 'req-feature-error', status: 'error', message: 'index teardown failed' }
        ]);
    });

    test('notifyWorkerFeatureUpdate 发送 __system 系统消息并等待回执', async () => {
        const postMessage = jest.fn((message: { requestId?: string }) => {
            const requestId = message?.requestId;
            if (requestId) {
                ApplicationRegistry.pendingRequests.get(requestId)?.resolve(undefined);
            }
        });
        jest.spyOn(ApplicationRegistry, 'hasGlobalWorker').mockReturnValue(true);
        jest.spyOn(ApplicationRegistry, 'getGlobalWorker').mockReturnValue({ postMessage } as never);

        try {
            await expect(notifyWorkerFeatureUpdate(['memory', 'filesystem'], ['filemgr'])).resolves.toBeUndefined();
            expect(postMessage).toHaveBeenCalledWith({
                bundleName: '__system',
                requestId: expect.any(String),
                methodName: '__updateDisabledFeatures',
                args: [['memory', 'filesystem'], ['filemgr']]
            });
        } finally {
            jest.restoreAllMocks();
        }
    });
});
