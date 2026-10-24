import { describe, expect, test, beforeEach, afterEach } from '@jest/globals';
import { ApplicationRegistry, dispatchWorkerMessage } from '../../../main/applications/registry.js';
import { handleWorkerRequest } from '../../../main/applications/worker.js';
import type { BaseWorker } from '../../../main/applications/base.js';

/**
 * Issue #125 回归测试：
 * 流式 Worker 请求抛错时，worker 侧必须发送 response_complete 终帧（而不是普通
 * response），主进程必须清理 pendingStreamRequests 并把错误传递给 renderer，
 * renderer 侧的 streamCall() Promise 必须 settle。
 */

type RecordedFrame = {
    type: string;
    id?: string;
    chunk?: unknown;
    status?: string;
    message?: string;
    data?: unknown;
};

function makeAppWorkers(appWorker: Partial<BaseWorker>): Map<string, BaseWorker> {
    return new Map([['stream-test-app', appWorker as BaseWorker]]);
}

/** 先 yield 一帧再抛错的流式方法（issue 描述的最小复现场景） */
function makeThrowingStreamWorker(): Partial<BaseWorker> {
    return {
        handleStreamMessage: async function* () {
            yield { index: 1 };
            throw new Error('boom');
        }
    };
}

/** 正常完成的流式方法 */
function makeHealthyStreamWorker(): Partial<BaseWorker> {
    return {
        handleStreamMessage: async function* () {
            yield { index: 1 };
            yield { index: 2 };
        }
    };
}

describe('worker handleWorkerRequest stream terminal frames', () => {
    test('stream generator that throws sends exactly one response_complete error terminal', async () => {
        const frames: RecordedFrame[] = [];
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId: 'req-stream-error',
                methodName: 'chat',
                args: [],
                stream: true
            },
            makeAppWorkers(makeThrowingStreamWorker()),
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        const chunks = frames.filter((frame) => frame.type === 'response_chunk');
        const terminals = frames.filter((frame) => frame.type === 'response_complete');
        const plainResponses = frames.filter((frame) => frame.type === 'response');

        expect(chunks).toEqual([{ type: 'response_chunk', id: 'req-stream-error', chunk: { index: 1 } }]);
        expect(terminals).toEqual([
            { type: 'response_complete', id: 'req-stream-error', status: 'error', message: 'boom' }
        ]);
        expect(plainResponses).toEqual([]);
    });

    test('successful stream still ends with a single response_complete terminal without error status', async () => {
        const frames: RecordedFrame[] = [];
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId: 'req-stream-ok',
                methodName: 'chat',
                args: [],
                stream: true
            },
            makeAppWorkers(makeHealthyStreamWorker()),
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        const terminals = frames.filter((frame) => frame.type === 'response_complete');
        expect(terminals).toEqual([{ type: 'response_complete', id: 'req-stream-ok' }]);
    });

    test('stream request whose initialization fails still sends a response_complete error terminal', async () => {
        const frames: RecordedFrame[] = [];
        const failingInit = new Map<string, Promise<void>>([
            ['stream-test-app', Promise.reject(new Error('init failed'))]
        ]);
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId: 'req-init-error',
                methodName: 'chat',
                args: [],
                stream: true
            },
            makeAppWorkers(makeHealthyStreamWorker()),
            failingInit,
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(frames).toEqual([
            { type: 'response_complete', id: 'req-init-error', status: 'error', message: 'init failed' }
        ]);
    });

    test('stream generator that throws a non-Error value still sends a terminal with a message', async () => {
        const frames: RecordedFrame[] = [];
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId: 'req-stream-string-error',
                methodName: 'chat',
                args: [],
                stream: true
            },
            makeAppWorkers({
                handleStreamMessage: async function* () {
                    yield { index: 1 };
                    throw 'plain string failure';
                }
            }),
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(frames[frames.length - 1]).toEqual({
            type: 'response_complete',
            id: 'req-stream-string-error',
            status: 'error',
            message: 'plain string failure'
        });
    });

    test('non-stream method error keeps replying with a plain response frame', async () => {
        const frames: RecordedFrame[] = [];
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId: 'req-call-error',
                methodName: 'doWork',
                args: [],
                stream: false
            },
            makeAppWorkers({
                handleMessage: async () => {
                    throw new Error('boom');
                }
            }),
            new Map(),
            (frame) => frames.push(frame as RecordedFrame)
        );

        expect(frames).toEqual([{ type: 'response', id: 'req-call-error', status: 'error', message: 'boom' }]);
    });
});

describe('dispatchWorkerMessage stream request termination', () => {
    let originalPendingRequests: typeof ApplicationRegistry.pendingRequests;
    let originalPendingStreamRequests: typeof ApplicationRegistry.pendingStreamRequests;

    beforeEach(() => {
        originalPendingRequests = ApplicationRegistry.pendingRequests;
        originalPendingStreamRequests = ApplicationRegistry.pendingStreamRequests;
        ApplicationRegistry.pendingRequests = new Map();
        ApplicationRegistry.pendingStreamRequests = new Map();
    });

    afterEach(() => {
        ApplicationRegistry.pendingRequests = originalPendingRequests;
        ApplicationRegistry.pendingStreamRequests = originalPendingStreamRequests;
    });

    test('plain response error frame for a pending stream id terminates the stream request', () => {
        const received: Array<{ chunk: unknown; error?: string }> = [];
        ApplicationRegistry.pendingStreamRequests.set('stream-1', (chunk, error) => {
            received.push({ chunk, error });
        });

        dispatchWorkerMessage({ type: 'response', id: 'stream-1', status: 'error', message: 'boom' }, {
            postMessage: () => undefined
        } as any);

        expect(received).toEqual([{ chunk: undefined, error: 'boom' }]);
        expect(ApplicationRegistry.pendingStreamRequests.size).toBe(0);
    });

    test('response_complete with error status forwards the error and clears the map entry', () => {
        const received: Array<{ chunk: unknown; error?: string }> = [];
        ApplicationRegistry.pendingStreamRequests.set('stream-2', (chunk, error) => {
            received.push({ chunk, error });
        });

        dispatchWorkerMessage({ type: 'response_complete', id: 'stream-2', status: 'error', message: 'boom' }, {
            postMessage: () => undefined
        } as any);

        expect(received).toEqual([{ chunk: undefined, error: 'boom' }]);
        expect(ApplicationRegistry.pendingStreamRequests.size).toBe(0);
    });

    test('successful response_complete keeps resolving the stream callback without error', () => {
        const received: Array<{ chunk: unknown; error?: string }> = [];
        ApplicationRegistry.pendingStreamRequests.set('stream-3', (chunk, error) => {
            received.push({ chunk, error });
        });

        dispatchWorkerMessage({ type: 'response_complete', id: 'stream-3' }, { postMessage: () => undefined } as any);

        expect(received).toEqual([{ chunk: undefined, error: undefined }]);
        expect(ApplicationRegistry.pendingStreamRequests.size).toBe(0);
    });

    test('response_chunk still delivers chunks without terminating the stream request', () => {
        const received: Array<{ chunk: unknown; error?: string }> = [];
        ApplicationRegistry.pendingStreamRequests.set('stream-4', (chunk, error) => {
            received.push({ chunk, error });
        });

        dispatchWorkerMessage({ type: 'response_chunk', id: 'stream-4', chunk: { index: 1 } }, {
            postMessage: () => undefined
        } as any);

        expect(received).toEqual([{ chunk: { index: 1 }, error: undefined }]);
        expect(ApplicationRegistry.pendingStreamRequests.size).toBe(1);
    });

    test('plain response still settles non-stream pendingRequests', () => {
        let resolved: unknown;
        let rejected: unknown;
        ApplicationRegistry.pendingRequests.set('call-1', {
            resolve: (value: unknown) => {
                resolved = value;
            },
            reject: (reason: unknown) => {
                rejected = reason;
            }
        });

        dispatchWorkerMessage({ type: 'response', id: 'call-1', status: 'ok', data: 42 }, {
            postMessage: () => undefined
        } as any);

        expect(resolved).toBe(42);
        expect(rejected).toBeUndefined();

        ApplicationRegistry.pendingRequests.set('call-2', {
            resolve: () => undefined,
            reject: (reason: unknown) => {
                rejected = reason;
            }
        });
        dispatchWorkerMessage({ type: 'response', id: 'call-2', status: 'error', message: 'boom' }, {
            postMessage: () => undefined
        } as any);
        expect((rejected as Error).message).toBe('boom');
    });

    test('unknown request id in a plain response frame is ignored without throwing', () => {
        expect(() =>
            dispatchWorkerMessage({ type: 'response', id: 'missing', status: 'error', message: 'boom' }, {
                postMessage: () => undefined
            } as any)
        ).not.toThrow();
    });
});

describe('stream request end-to-end: yield one frame then throw', () => {
    let originalPendingStreamRequests: typeof ApplicationRegistry.pendingStreamRequests;

    beforeEach(() => {
        originalPendingStreamRequests = ApplicationRegistry.pendingStreamRequests;
        ApplicationRegistry.pendingStreamRequests = new Map();
    });

    afterEach(() => {
        ApplicationRegistry.pendingStreamRequests = originalPendingStreamRequests;
    });

    test('worker error terminal reaches the renderer callback and the map returns to baseline', async () => {
        const requestId = 'req-e2e';
        // worker 侧：流式方法先 yield 一帧再 throw
        const workerFrames: RecordedFrame[] = [];
        await handleWorkerRequest(
            {
                bundleName: 'stream-test-app',
                requestId,
                methodName: 'chat',
                args: [],
                stream: true
            },
            makeAppWorkers(makeThrowingStreamWorker()),
            new Map(),
            (frame) => workerFrames.push(frame as RecordedFrame)
        );

        // 主进程侧：按 registry_electron.ts streamCall 的方式注册回调，
        // 回调把帧转发给 renderer（这里用数组记录代替 senderFrame.send）
        const sentToRenderer: Array<{ chunk: unknown; error?: string }> = [];
        ApplicationRegistry.pendingStreamRequests.set(requestId, (chunk, error) => {
            sentToRenderer.push({ chunk, error });
        });

        for (const frame of workerFrames) {
            dispatchWorkerMessage(frame, { postMessage: () => undefined } as any);
        }

        // renderer 收到一帧业务数据后收到携带错误的终帧，
        // preload 侧据此 reject，streamCall() Promise 得以 settle
        expect(sentToRenderer).toEqual([
            { chunk: { index: 1 }, error: undefined },
            { chunk: undefined, error: 'boom' }
        ]);
        expect(ApplicationRegistry.pendingStreamRequests.size).toBe(0);
    });
});
