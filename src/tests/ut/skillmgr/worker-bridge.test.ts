import { jest } from '@jest/globals';
import { BaseWorker } from '../../../../packages/app-sdk/src/index.js';
import {
    callAppFromWorker,
    isWorkerThread,
    setWorkerBridgePortForTests
} from '../../../main/applications/skillmgr/registry/worker-bridge.js';

/**
 * worker-bridge 协议测试：验证桥接消息与 applications/registry.ts 'callApp' 分支、
 * applications/worker.ts 的响应路由（BaseWorker.pendingAppRequests）之间的契约。
 * 主进程 jest 环境中 parentPort 为 null，通过 setWorkerBridgePortForTests 注入假端口。
 */

interface CapturedMessage {
    type: string;
    bundleName: string;
    requestId?: string;
    methodName: string;
    args: unknown[];
}

function createFakePort() {
    const sent: CapturedMessage[] = [];
    const respond = (requestId: string, response: { status: 'ok' | 'error'; data?: unknown; message?: string }) => {
        // 模拟 applications/worker.ts 的响应路由：查 pending 表 → clearTimeout → resolve/reject
        const pending = BaseWorker.pendingAppRequests.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timer);
        BaseWorker.pendingAppRequests.delete(requestId);
        if (response.status === 'ok') pending.resolve(response.data);
        else pending.reject(new Error(response.message || 'unknown callAppWithResponse error'));
        return true;
    };
    return {
        sent,
        respond,
        postMessage: (message: CapturedMessage) => {
            sent.push(message);
        }
    };
}

describe('skillmgr registry worker-bridge 协议', () => {
    afterEach(() => {
        setWorkerBridgePortForTests(null);
    });

    test('主进程/测试环境下 isWorkerThread 为 false，调用直接拒绝', () => {
        expect(isWorkerThread()).toBe(false);
        expect(callAppFromWorker('getPluginSkillRegistries')).rejects.toThrow('only available in the worker thread');
    });

    test('消息形状与主进程 callApp 处理器期望一致，响应经 pendingAppRequests 路由', async () => {
        const port = createFakePort();
        setWorkerBridgePortForTests(port as unknown as MessagePort);

        const pending = callAppFromWorker<{ skills: unknown[] }>('searchPluginSkillRegistry', 'matrix', {
            query: 'demo'
        });

        expect(port.sent).toHaveLength(1);
        const message = port.sent[0];
        expect(message.type).toBe('callApp');
        expect(message.bundleName).toBe('skillmgr');
        expect(typeof message.requestId).toBe('string');
        expect(message.methodName).toBe('searchPluginSkillRegistry');
        expect(message.args).toEqual(['matrix', { query: 'demo' }]);
        expect(BaseWorker.pendingAppRequests.has(message.requestId as string)).toBe(true);

        expect(port.respond(message.requestId as string, { status: 'ok', data: { skills: [] } })).toBe(true);
        await expect(pending).resolves.toEqual({ skills: [] });
    });

    test('主进程返回 error 响应时桥接调用按消息拒绝', async () => {
        const port = createFakePort();
        setWorkerBridgePortForTests(port as unknown as MessagePort);

        const pending = callAppFromWorker('getPluginSkillRegistries');
        const captured = port.sent[0];

        port.respond(captured.requestId as string, { status: 'error', message: '未知 Registry: nope' });

        await expect(pending).rejects.toThrow('未知 Registry: nope');
    });

    test('无 pending 的响应消息不产生任何影响（幂等）', async () => {
        const port = createFakePort();
        setWorkerBridgePortForTests(port as unknown as MessagePort);

        const pending = callAppFromWorker('getPluginSkillRegistries');
        const captured = port.sent[0];
        // 主进程对已超时/已删除的请求回响应时不应抛错
        expect(port.respond('not-a-real-request-id', { status: 'ok', data: null })).toBe(false);

        port.respond(captured.requestId as string, { status: 'ok', data: [] });
        await expect(pending).resolves.toEqual([]);
    });

    test('setWorkerBridgePortForTests(null) 后调用回到拒绝状态', () => {
        setWorkerBridgePortForTests({ postMessage: () => undefined } as unknown as MessagePort);
        setWorkerBridgePortForTests(null);
        expect(callAppFromWorker('getPluginSkillRegistries')).rejects.toThrow('only available in the worker thread');
    });
});
