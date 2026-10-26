/**
 * renderer preload 测试用的 ipcRenderer 替身：保留 channel → listener 的真实集合语义，
 * 便于断言“退订只移除自己”以及是否出现了 removeAllListeners 这类粗粒度清理。
 */
export type IpcListener = (event: unknown, ...args: unknown[]) => void;

export class FakeIpcRenderer {
    public readonly handlers = new Map<string, Set<IpcListener>>();
    public readonly removeAllListenersCalls: string[] = [];
    public readonly invokeCalls: Array<{ channel: string; args: unknown[] }> = [];
    /** invoke 会被拒绝的 channel（模拟 main 侧失败） */
    public readonly failingInvokeChannels = new Set<string>();

    on(channel: string, listener: IpcListener) {
        let listeners = this.handlers.get(channel);
        if (listeners === undefined) {
            listeners = new Set();
            this.handlers.set(channel, listeners);
        }
        listeners.add(listener);
    }

    removeListener(channel: string, listener: IpcListener) {
        this.handlers.get(channel)?.delete(listener);
    }

    removeAllListeners(channel: string) {
        this.removeAllListenersCalls.push(channel);
        this.handlers.delete(channel);
    }

    invoke(channel: string, ...args: unknown[]): Promise<{ status: string; message?: string }> {
        this.invokeCalls.push({ channel, args });
        if (this.failingInvokeChannels.has(channel)) {
            return Promise.reject(new Error(`invoke failed: ${channel}`));
        }
        return Promise.resolve({ status: 'ok' });
    }

    /** 模拟 main 进程推送事件 */
    emit(channel: string, ...args: unknown[]) {
        for (const listener of [...(this.handlers.get(channel) ?? [])]) {
            listener({}, ...args);
        }
    }

    listenerCount(channel: string) {
        return this.handlers.get(channel)?.size ?? 0;
    }

    invokeChannels() {
        return this.invokeCalls.map((call) => call.channel);
    }
}
