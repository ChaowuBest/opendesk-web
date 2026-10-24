import { jest } from '@jest/globals';

/**
 * 回归测试（issue #122 兜底）：webContents 销毁后，CDPSessionManager 缓存的
 * 对应 CDP 会话必须立即释放并移出缓存。否则持有已销毁 webContents 引用与
 * debugger listener 的会话会一直留在 Map 中（例如任务删除、webview 回收后，
 * 会话条目只增不减）。
 */

const wcById = new Map<number, any>();

jest.unstable_mockModule('electron', () => ({
    webContents: {
        fromId: (id: number) => wcById.get(id)
    }
}));

function makeDestroyableWebContents(id: number): any {
    const destroyedListeners = new Set<() => void>();
    let destroyed = false;
    let attached = true;
    const wc = {
        id,
        isDestroyed: () => destroyed,
        once: (event: string, listener: () => void) => {
            if (event === 'destroyed') destroyedListeners.add(listener);
        },
        destroy: () => {
            destroyed = true;
            for (const listener of destroyedListeners) listener();
        },
        debugger: {
            isAttached: () => attached,
            attach: () => {
                attached = true;
            },
            detach: () => {
                attached = false;
            },
            on: () => undefined,
            removeListener: () => undefined,
            sendCommand: async () => ({ result: { value: 1 } })
        }
    };
    wcById.set(id, wc);
    return wc;
}

const { CDPSession, CDPSessionManager } = await import('../cdp/session.js');

describe('CDPSessionManager cleans up sessions of destroyed webContents', () => {
    test('destroying the webContents disposes the session and evicts it from the manager', async () => {
        const manager = new CDPSessionManager();
        const wc = makeDestroyableWebContents(101);

        const session = await manager.getSession(wc.id);
        expect(session).toBeInstanceOf(CDPSession);
        expect((manager as any)._sessions.size).toBe(1);

        wc.destroy();

        // webContents 已销毁，dispose 不再调用 detach（debugger 已随之释放），
        // 但会话必须被释放并从 manager 缓存中移除
        expect((manager as any)._sessions.size).toBe(0);
        // 已销毁 webContents 的会话不得复活
        expect(session.attached).toBe(false);
        await expect(session.send('Runtime.evaluate')).rejects.toThrow();
    });

    test('a live session is untouched when a different webContents is destroyed', async () => {
        const manager = new CDPSessionManager();
        const alive = makeDestroyableWebContents(201);
        const dying = makeDestroyableWebContents(202);

        await manager.getSession(alive.id);
        await manager.getSession(dying.id);
        expect((manager as any)._sessions.size).toBe(2);

        dying.destroy();

        expect((manager as any)._sessions.size).toBe(1);
        expect((manager as any)._sessions.get(alive.id)).toBeDefined();
    });

    test('getSession after destroyed-webContents cleanup recreates a fresh session', async () => {
        const manager = new CDPSessionManager();
        const wc = makeDestroyableWebContents(301);

        const first = await manager.getSession(wc.id);
        wc.destroy();
        expect((manager as any)._sessions.size).toBe(0);

        // webContents 重建（同 id 场景在测试中以新对象模拟）
        const revived = makeDestroyableWebContents(301);
        const second = await manager.getSession(revived.id);
        expect(second).not.toBe(first);
        expect((manager as any)._sessions.size).toBe(1);
    });

    test('destroyed-cleanup tolerates a throwing debugger accessor (destroyed webContents)', async () => {
        const manager = new CDPSessionManager();
        const wc = makeDestroyableWebContents(401);
        await manager.getSession(wc.id);

        // 模拟 Electron：webContents 销毁后原生属性访问可能抛 "Object has been destroyed"
        Object.defineProperty(wc, 'debugger', {
            get() {
                throw new Error('Object has been destroyed');
            },
            configurable: true
        });

        // destroyed 兜底清理（dispose）绝不能抛出，否则会打断 destroy 事件链
        expect(() => wc.destroy()).not.toThrow();
        expect((manager as any)._sessions.size).toBe(0);
    });

    test('disposeAll tolerates sessions whose webContents has been destroyed', async () => {
        const manager = new CDPSessionManager();
        const wc = makeDestroyableWebContents(501);
        await manager.getSession(wc.id);

        Object.defineProperty(wc, 'debugger', {
            get() {
                throw new Error('Object has been destroyed');
            },
            configurable: true
        });

        // removeController → disposeAll 路径：dispose 不得打断任务删除
        expect(() => manager.disposeAll()).not.toThrow();
        expect((manager as any)._sessions.size).toBe(0);
    });
});
