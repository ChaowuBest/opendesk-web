/**
 * 子应用 guest 页在 preload 未注入时，经主窗口 postMessage 代理 IPC。
 */

const CHANNEL = 'OD_FRAME_API' as const;

type ProxyRequest = {
    channel: typeof CHANNEL;
    requestId: string;
    api: 'application' | 'taskManager' | 'theme' | 'fs';
    method: string;
    args: unknown[];
    bundleName?: string;
};

type ProxyReply = {
    channel: typeof CHANNEL;
    requestId: string;
    result?: unknown;
    error?: string;
};

type ProxyEvent = {
    channel: typeof CHANNEL;
    type: 'event';
    api: 'application';
    eventName: string;
    args: unknown[];
};

type ProxyStreamMessage = {
    channel: typeof CHANNEL;
    type: 'streamChunk' | 'streamComplete';
    requestId: string;
    chunk?: unknown;
    error?: string;
};

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
const pendingStreams = new Map<
    string,
    { callback: (chunk: unknown) => void; resolve: () => void; reject: (e: Error) => void }
>();

let currentBundleName: string | null = null;
const eventHandlers = new Map<string, Set<(args: unknown[]) => void>>();

function dispatchProxyEvent(msg: ProxyEvent): void {
    const set = eventHandlers.get(msg.eventName);
    if (!set) {
        return;
    }
    for (const cb of set) {
        try {
            cb(msg.args);
        } catch (err) {
            console.error('[application-frame-proxy] event handler failed', err);
        }
    }
}

function dispatchProxyStreamMessage(msg: ProxyStreamMessage): void {
    const pendingStream = pendingStreams.get(msg.requestId);
    if (!pendingStream) {
        return;
    }
    if (msg.type === 'streamChunk') {
        try {
            pendingStream.callback(msg.chunk);
        } catch {
            // Ignore callback failures so stream completion can still be delivered.
        }
        return;
    }

    pendingStreams.delete(msg.requestId);
    if (msg.error) {
        pendingStream.reject(new Error(msg.error));
    } else {
        pendingStream.resolve();
    }
}

function installProxyListener(): void {
    if ((window as Window & { __odFrameProxyListener?: boolean }).__odFrameProxyListener) {
        return;
    }
    (window as Window & { __odFrameProxyListener?: boolean }).__odFrameProxyListener = true;
    window.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as ProxyReply | ProxyEvent | ProxyStreamMessage | undefined;
        if (data?.channel !== CHANNEL) {
            return;
        }
        if ('type' in data) {
            if (data.type === 'event') {
                dispatchProxyEvent(data as ProxyEvent);
                return;
            }
            if (data.type === 'streamChunk' || data.type === 'streamComplete') {
                dispatchProxyStreamMessage(data as ProxyStreamMessage);
                return;
            }
        }
        const reply = data as ProxyReply;
        if (!reply.requestId) {
            return;
        }
        const p = pending.get(reply.requestId);
        if (!p) {
            return;
        }
        pending.delete(reply.requestId);
        if (reply.error) {
            p.reject(new Error(reply.error));
        } else {
            p.resolve(reply.result);
        }
    });
}

function proxyInvoke(api: ProxyRequest['api'], method: string, args: unknown[], bundleName?: string): Promise<unknown> {
    installProxyListener();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
        window.parent.postMessage(
            {
                channel: CHANNEL,
                requestId,
                api,
                method,
                args,
                bundleName: bundleName ?? currentBundleName ?? undefined
            } satisfies ProxyRequest,
            '*'
        );
        window.setTimeout(() => {
            if (pending.has(requestId)) {
                pending.delete(requestId);
                reject(new Error(`主窗口代理超时: ${api}.${method}`));
            }
        }, 120_000);
    });
}

function proxyStreamInvoke(
    method: 'streamCall' | 'streamCallMainWorld',
    callback: (chunk: unknown) => void,
    args: unknown[],
    bundleName?: string
): Promise<void> {
    installProxyListener();
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
        pendingStreams.set(requestId, { callback, resolve, reject });
        window.parent.postMessage(
            {
                channel: CHANNEL,
                requestId,
                api: 'application',
                method,
                args,
                bundleName: bundleName ?? currentBundleName ?? undefined
            } satisfies ProxyRequest,
            '*'
        );
        window.setTimeout(() => {
            if (pendingStreams.has(requestId)) {
                pendingStreams.delete(requestId);
                reject(new Error(`主窗口代理超时: application.${method}`));
            }
        }, 120_000);
    });
}

/** 在 application.html guest 中安装 API 代理（preload 缺失时） */
export function installApplicationFrameProxies(applicationBundleName: string): boolean {
    if (window.parent === window) {
        return false;
    }

    installProxyListener();
    currentBundleName = applicationBundleName;

    if (!window.applicationAPI?.setApplicationBundleName) {
        window.applicationAPI = {
            setApplicationBundleName: async (bundleName: string) => {
                currentBundleName = bundleName;
            },
            call: async (methodName: string, ...args: unknown[]) => {
                return proxyInvoke('application', 'call', [methodName, ...args]);
            },
            callMainWorld: async (methodName: string, ...args: unknown[]) => {
                return proxyInvoke('application', 'callMainWorld', [methodName, ...args]);
            },
            streamCall: async (methodName: string, callback: (chunk: unknown) => void, ...args: unknown[]) => {
                await proxyStreamInvoke('streamCall', callback, [methodName, ...args]);
            },
            streamCallMainWorld: async (methodName: string, callback: (chunk: unknown) => void, ...args: unknown[]) => {
                await proxyStreamInvoke('streamCallMainWorld', callback, [methodName, ...args]);
            },
            subscribe: async (eventName: string, callback: (args: unknown[]) => void) => {
                if (!eventHandlers.has(eventName)) {
                    eventHandlers.set(eventName, new Set());
                    await proxyInvoke('application', 'subscribe', [eventName], currentBundleName ?? undefined);
                }
                eventHandlers.get(eventName)!.add(callback);
            },
            unsubscribe: async (eventName: string) => {
                eventHandlers.delete(eventName);
                await proxyInvoke('application', 'unsubscribe', [eventName], currentBundleName ?? undefined);
            }
        };
    }

    if (!window.taskManagerAPI?.createTask) {
        window.taskManagerAPI = new Proxy({} as Window['taskManagerAPI'], {
            get(_target, method: string) {
                return (...args: unknown[]) => proxyInvoke('taskManager', method, args);
            }
        }) as Window['taskManagerAPI'];
    }

    if (!window.themeAPI?.getResolvedTheme) {
        window.themeAPI = {
            getResolvedTheme: () =>
                proxyInvoke('theme', 'getResolvedTheme', []) as ReturnType<
                    NonNullable<Window['themeAPI']>['getResolvedTheme']
                >,
            setPreference: (preference: string) =>
                proxyInvoke('theme', 'setPreference', [preference]) as ReturnType<
                    NonNullable<Window['themeAPI']>['setPreference']
                >,
            onThemeChanged: (callback) => {
                const handler = (e: MessageEvent) => {
                    if (e.data?.channel === CHANNEL && e.data?.type === 'themeChanged') {
                        callback(e.data.resolved);
                    }
                };
                window.addEventListener('message', handler);
                void proxyInvoke('theme', 'registerThemeListener', []);
                return () => window.removeEventListener('message', handler);
            }
        };
    }

    if (!window.fsAPI?.selectFile) {
        window.fsAPI = new Proxy({} as Window['fsAPI'], {
            get(_target, method: string) {
                return (...args: unknown[]) => proxyInvoke('fs', method, args);
            }
        }) as Window['fsAPI'];
    }

    return Boolean(window.applicationAPI?.setApplicationBundleName);
}

/** 主窗口：处理子应用 guest 的 IPC 代理请求 */
export function registerApplicationFrameProxyHost(): void {
    if ((window as Window & { __odFrameProxyHost?: boolean }).__odFrameProxyHost) {
        return;
    }
    (window as Window & { __odFrameProxyHost?: boolean }).__odFrameProxyHost = true;

    const themeListeners = new Set<(resolved: unknown) => void>();
    let themeUnsubscribe: (() => void) | null = null;

    window.addEventListener('message', async (event: MessageEvent) => {
        const data = event.data as ProxyRequest | undefined;
        if (data?.channel !== CHANNEL || !data.requestId || !event.source) {
            return;
        }
        const reply = (payload: Omit<ProxyReply, 'channel' | 'requestId'>) => {
            (event.source as Window).postMessage({ channel: CHANNEL, requestId: data.requestId, ...payload }, '*');
        };

        try {
            let result: unknown;
            const bundle = data.bundleName;

            if (data.api === 'application') {
                if (!bundle) {
                    throw new Error('application bundle name is not set');
                }
                if (data.method === 'call') {
                    const [methodName, ...args] = data.args as [string, ...unknown[]];
                    result = await window.applicationRegistryAPI.call(bundle, methodName, ...args);
                } else if (data.method === 'callMainWorld') {
                    const [methodName, ...args] = data.args as [string, ...unknown[]];
                    result = await window.applicationRegistryAPI.callMainWorld(bundle, methodName, ...args);
                } else if (data.method === 'streamCall' || data.method === 'streamCallMainWorld') {
                    const [methodName, ...args] = data.args as [string, ...unknown[]];
                    const streamReply = (payload: Omit<ProxyStreamMessage, 'channel' | 'requestId'>) => {
                        (event.source as Window).postMessage(
                            { channel: CHANNEL, requestId: data.requestId, ...payload } satisfies ProxyStreamMessage,
                            '*'
                        );
                    };
                    const sendChunk = (chunk: unknown) => streamReply({ type: 'streamChunk', chunk });
                    try {
                        if (data.method === 'streamCall') {
                            await window.applicationRegistryAPI.streamCall(bundle, methodName, sendChunk, ...args);
                        } else {
                            await window.applicationRegistryAPI.streamCallMainWorld(
                                bundle,
                                methodName,
                                sendChunk,
                                ...args
                            );
                        }
                        streamReply({ type: 'streamComplete' });
                    } catch (err) {
                        streamReply({
                            type: 'streamComplete',
                            error: err instanceof Error ? err.message : String(err)
                        });
                    }
                    return;
                } else if (data.method === 'subscribe') {
                    const [eventName] = data.args as [string];
                    await window.applicationRegistryAPI.subscribeEvent(bundle, eventName, (...args: unknown[]) => {
                        (event.source as Window).postMessage(
                            {
                                channel: CHANNEL,
                                type: 'event',
                                api: 'application',
                                eventName,
                                args
                            } satisfies ProxyEvent,
                            '*'
                        );
                    });
                    result = null;
                } else if (data.method === 'unsubscribe') {
                    result = null;
                } else {
                    throw new Error(`Unsupported application proxy method: ${data.method}`);
                }
            } else if (data.api === 'taskManager') {
                const api = window.taskManagerAPI as Record<string, (...a: unknown[]) => unknown>;
                const fn = api[data.method];
                if (typeof fn !== 'function') {
                    throw new Error(`taskManagerAPI.${data.method} is not available`);
                }
                result = await fn(...data.args);
            } else if (data.api === 'theme') {
                if (data.method === 'getResolvedTheme') {
                    result = await window.themeAPI.getResolvedTheme();
                } else if (data.method === 'setPreference') {
                    result = await window.themeAPI.setPreference(data.args[0] as string);
                } else if (data.method === 'registerThemeListener') {
                    if (!themeUnsubscribe) {
                        themeUnsubscribe = window.themeAPI.onThemeChanged((resolved) => {
                            for (const frame of Object.values(window.__appFrameCache ?? {})) {
                                const win = (frame as HTMLElement & { contentWindow?: Window }).contentWindow;
                                win?.postMessage({ channel: CHANNEL, type: 'themeChanged', resolved }, '*');
                            }
                        });
                    }
                    result = null;
                } else {
                    throw new Error(`Unsupported theme proxy method: ${data.method}`);
                }
            } else if (data.api === 'fs') {
                const api = window.fsAPI as Record<string, (...a: unknown[]) => unknown>;
                const fn = api[data.method];
                if (typeof fn !== 'function') {
                    throw new Error(`fsAPI.${data.method} is not available`);
                }
                result = await fn(...data.args);
            } else {
                throw new Error(`Unknown proxy api: ${data.api}`);
            }

            reply({ result });
        } catch (err) {
            reply({ error: err instanceof Error ? err.message : String(err) });
        }
    });
}
