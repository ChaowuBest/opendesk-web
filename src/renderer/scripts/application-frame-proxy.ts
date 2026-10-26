/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * 子应用 guest 页在 preload 未注入时，经主窗口 postMessage 代理 IPC。
 */

const CHANNEL = 'OD_FRAME_API' as const;

/**
 * 注入式全局 API 在 CLI / 测试环境并不存在，类型上是可选的。
 * 统一收敛成显式访问函数：缺失时抛出带说明的错误，由调用方的 try/catch 统一回复 guest，
 * 避免满屏的非空断言。
 */
function requireApplicationRegistryAPI(): NonNullable<Window['applicationRegistryAPI']> {
    const api = window.applicationRegistryAPI;
    if (!api) {
        throw new Error('window.applicationRegistryAPI 未注入，无法代理应用调用');
    }
    return api;
}

function requireThemeAPI(): NonNullable<Window['themeAPI']> {
    const api = window.themeAPI;
    if (!api) {
        throw new Error('window.themeAPI 未注入，无法代理主题调用');
    }
    return api;
}

type ProxyRequest = {
    channel: typeof CHANNEL;
    requestId: string;
    api: 'application' | 'taskManager' | 'theme' | 'fs' | 'workspace';
    method: string;
    args: unknown[];
    bundleName?: string;
    /** 请求报文不带 type 字段；声明为 never 以便与 ProxyToolCallResult 构成可判别联合 */
    type?: never;
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

type ProxyTaskUpdate = {
    channel: typeof CHANNEL;
    type: 'taskUpdate';
    requestId: string;
    progress: unknown;
};

type ProxyToolCall = {
    channel: typeof CHANNEL;
    type: 'toolCall';
    callbackId: string;
    callId: string;
    toolName: string;
    args: unknown;
};

type ProxyToolCallResult = {
    channel: typeof CHANNEL;
    type: 'toolCallResult';
    callId: string;
    result?: unknown;
    error?: string;
};

const pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timeoutId: number }>();
const pendingStreams = new Map<
    string,
    { callback: (chunk: unknown) => void; resolve: () => void; reject: (e: Error) => void; timeoutId: number }
>();
const taskUpdateCallbacks = new Map<string, (progress: unknown) => void>();
const taskSubscriptionRequests = new Map<string, string>();
const toolsetCallbacks = new Map<string, (toolName: string, args: unknown) => unknown>();
const toolsetCallbackIds = new Map<string, string>();
const pendingToolCalls = new Map<
    string,
    { resolve: (result: unknown) => void; reject: (error: Error) => void; timeoutId: number }
>();

let currentBundleName: string | null = null;
/**
 * 事件名 → 本地 handler 列表。刻意用数组而不是 Set：与 preload 暴露的 applicationAPI
 * 契约保持一致 —— 同一个 callback 订阅两次就是两个订阅，各自退订只移除自己那一条
 * （用 Set 去重会让「订阅两次、退订一次」在两种 API 面上表现相反）。
 */
const eventHandlers = new Map<string, Array<(...args: unknown[]) => void>>();

function dispatchProxyEvent(msg: ProxyEvent): void {
    const handlers = eventHandlers.get(msg.eventName);
    if (!handlers) {
        return;
    }
    // 快照遍历：handler 内部退订/新增订阅不应影响本轮分发
    for (const cb of [...handlers]) {
        try {
            // 与 preload 的 ipcRenderer.on(..., (event, ...args) => callback(...args)) 保持一致
            cb(...msg.args);
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
    window.clearTimeout(pendingStream.timeoutId);
    if (msg.error) {
        pendingStream.reject(new Error(msg.error));
    } else {
        pendingStream.resolve();
    }
}

function dispatchTaskUpdate(msg: ProxyTaskUpdate): void {
    try {
        taskUpdateCallbacks.get(msg.requestId)?.(msg.progress);
    } catch (err) {
        console.error('[application-frame-proxy] task update handler failed', err);
    }
}

async function dispatchToolCall(msg: ProxyToolCall): Promise<void> {
    const callback = toolsetCallbacks.get(msg.callbackId);
    const reply: ProxyToolCallResult = {
        channel: CHANNEL,
        type: 'toolCallResult',
        callId: msg.callId
    };
    try {
        if (!callback) {
            throw new Error('Application toolset callback is unavailable');
        }
        reply.result = await callback(msg.toolName, msg.args);
    } catch (err) {
        reply.error = err instanceof Error ? err.message : String(err);
    }
    window.parent.postMessage(reply, '*');
}

function installProxyListener(): void {
    if ((window as Window & { __odFrameProxyListener?: boolean }).__odFrameProxyListener) {
        return;
    }
    (window as Window & { __odFrameProxyListener?: boolean }).__odFrameProxyListener = true;
    window.addEventListener('message', (e: MessageEvent) => {
        const data = e.data as
            ProxyReply | ProxyEvent | ProxyStreamMessage | ProxyTaskUpdate | ProxyToolCall | undefined;
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
            if (data.type === 'taskUpdate') {
                dispatchTaskUpdate(data as ProxyTaskUpdate);
                return;
            }
            if (data.type === 'toolCall') {
                void dispatchToolCall(data as ProxyToolCall);
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
        window.clearTimeout(p.timeoutId);
        if (reply.error) {
            p.reject(new Error(reply.error));
        } else {
            p.resolve(reply.result);
        }
    });
}

function proxyInvoke(
    api: ProxyRequest['api'],
    method: string,
    args: unknown[],
    bundleName?: string,
    requestId = crypto.randomUUID()
): Promise<unknown> {
    installProxyListener();
    return new Promise((resolve, reject) => {
        const timeoutId = window.setTimeout(() => {
            if (pending.has(requestId)) {
                pending.delete(requestId);
                reject(new Error(`主窗口代理超时: ${api}.${method}`));
            }
        }, 120_000);
        pending.set(requestId, { resolve, reject, timeoutId });
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
    });
}

async function proxySubscribeTaskUpdate(taskId: string, callback: (progress: unknown) => void): Promise<string> {
    const requestId = crypto.randomUUID();
    taskUpdateCallbacks.set(requestId, callback);
    try {
        const subscriptionId = (await proxyInvoke(
            'taskManager',
            'subscribeTaskUpdate',
            [taskId],
            undefined,
            requestId
        )) as string;
        taskSubscriptionRequests.set(subscriptionId, requestId);
        return subscriptionId;
    } catch (error) {
        taskUpdateCallbacks.delete(requestId);
        throw error;
    }
}

async function proxyUnsubscribeTaskUpdate(taskId: string, subscriptionId: string): Promise<void> {
    await proxyInvoke('taskManager', 'unsubscribeTaskUpdate', [taskId, subscriptionId]);
    const requestId = taskSubscriptionRequests.get(subscriptionId);
    if (requestId) {
        taskSubscriptionRequests.delete(subscriptionId);
        taskUpdateCallbacks.delete(requestId);
    }
}

async function proxyAttachToolset(
    taskId: string,
    toolset: { name?: string },
    callback: (toolName: string, args: unknown) => unknown
): Promise<unknown> {
    const callbackId = crypto.randomUUID();
    const toolsetKey = `${taskId}:${toolset?.name ?? ''}`;
    const previousCallbackId = toolsetCallbackIds.get(toolsetKey);
    toolsetCallbacks.set(callbackId, callback);
    try {
        const result = await proxyInvoke('taskManager', 'attachToolset', [taskId, toolset], undefined, callbackId);
        if (previousCallbackId) {
            toolsetCallbacks.delete(previousCallbackId);
        }
        toolsetCallbackIds.set(toolsetKey, callbackId);
        return result;
    } catch (error) {
        toolsetCallbacks.delete(callbackId);
        throw error;
    }
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
        const timeoutId = window.setTimeout(() => {
            if (pendingStreams.has(requestId)) {
                pendingStreams.delete(requestId);
                reject(new Error(`主窗口代理超时: application.${method}`));
            }
        }, 120_000);
        pendingStreams.set(requestId, { callback, resolve, reject, timeoutId });
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
    });
}

/** 在 application.html guest 中安装 API 代理（preload 缺失时） */
export function installApplicationFrameProxies(applicationBundleName: string): boolean {
    if (window.parent === window) {
        return false;
    }

    installProxyListener();
    currentBundleName = applicationBundleName;

    // Built-in application frames are same-origin. Reuse the host's callback-oriented APIs so
    // prompts, model selectors, skills and notifications keep the same behavior as a full TaskView.
    try {
        const child = window as unknown as Record<string, unknown>;
        const host = window.parent as unknown as Record<string, unknown>;
        for (const apiName of [
            'permissionAPI',
            'askUserAPI',
            'exitPlanModeAPI',
            'settingAPI',
            'modeAPI',
            'nodeAPI',
            'applicationRegistryAPI',
            'notificationAPI',
            'globalControlAPI',
            'quickpassAPI'
        ]) {
            if (!child[apiName] && host[apiName]) {
                child[apiName] = host[apiName];
            }
        }
    } catch {
        // Cross-origin user applications continue through the postMessage proxies below.
    }

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
            subscribe: async (eventName: string, callback: (...args: unknown[]) => void) => {
                let handlers = eventHandlers.get(eventName);
                const needsHostSubscription = handlers === undefined;
                if (handlers === undefined) {
                    handlers = [];
                    eventHandlers.set(eventName, handlers);
                }
                // 先登记再等 IPC 往返：等待期间 frame 被销毁时，按事件名退订仍能命中这条登记
                handlers.push(callback);
                if (needsHostSubscription) {
                    try {
                        await proxyInvoke('application', 'subscribe', [eventName], currentBundleName ?? undefined);
                    } catch (error) {
                        const index = handlers.indexOf(callback);
                        if (index >= 0) handlers.splice(index, 1);
                        if (handlers.length === 0) eventHandlers.delete(eventName);
                        throw error;
                    }
                }
                // 与 preload 暴露的同名 API 一致：返回只退订该 callback 的函数
                return () => {
                    const current = eventHandlers.get(eventName);
                    if (current === undefined) return;
                    const index = current.indexOf(callback);
                    if (index < 0) return;
                    current.splice(index, 1);
                    if (current.length > 0) return;
                    eventHandlers.delete(eventName);
                    void proxyInvoke('application', 'unsubscribe', [eventName], currentBundleName ?? undefined);
                };
            },
            unsubscribe: async (eventName: string) => {
                // 与 preload 契约一致：只清理本 guest 在该事件上的登记；没有登记就不动宿主的
                // 引用计数（否则会连带减掉别的订阅者），精确退订仍用 subscribe 的返回值
                if (eventHandlers.delete(eventName) === false) return;
                await proxyInvoke('application', 'unsubscribe', [eventName], currentBundleName ?? undefined);
            }
        };
    }

    if (!window.taskManagerAPI?.createTask) {
        window.taskManagerAPI = new Proxy({} as Window['taskManagerAPI'], {
            get(_target, method: string) {
                if (method === 'subscribeTaskUpdate') {
                    return proxySubscribeTaskUpdate;
                }
                if (method === 'unsubscribeTaskUpdate') {
                    return proxyUnsubscribeTaskUpdate;
                }
                if (method === 'attachToolset') {
                    return proxyAttachToolset;
                }
                return (...args: unknown[]) => proxyInvoke('taskManager', method, args);
            }
        }) as Window['taskManagerAPI'];
    }

    if (!window.themeAPI?.getResolvedTheme) {
        // iframe 回退代理只覆盖主题三件套；字体预设接口在宿主 preload 缺失时不可用
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
        } as Window['themeAPI'];
    }

    if (!window.fsAPI?.selectFile) {
        window.fsAPI = new Proxy({} as Window['fsAPI'], {
            get(_target, method: string) {
                return (...args: unknown[]) => proxyInvoke('fs', method, args);
            }
        }) as Window['fsAPI'];
    }

    if (!(window as any).workspaceAPI?.getEffectiveWorkspace) {
        (window as any).workspaceAPI = new Proxy({} as any, {
            get(_target: unknown, method: string) {
                return (...args: unknown[]) => proxyInvoke('workspace', method, args);
            }
        });
    }

    return Boolean(window.applicationAPI?.setApplicationBundleName);
}

/** 主窗口：处理子应用 guest 的 IPC 代理请求 */
export function registerApplicationFrameProxyHost(): void {
    if ((window as Window & { __odFrameProxyHost?: boolean }).__odFrameProxyHost) {
        return;
    }
    (window as Window & { __odFrameProxyHost?: boolean }).__odFrameProxyHost = true;

    let themeUnsubscribe: (() => void) | null = null;

    window.addEventListener('message', async (event: MessageEvent) => {
        const rawData = event.data as ProxyRequest | ProxyToolCallResult | undefined;
        if (rawData?.channel === CHANNEL && rawData.type === 'toolCallResult') {
            const toolCall = pendingToolCalls.get(rawData.callId);
            if (!toolCall) {
                return;
            }
            pendingToolCalls.delete(rawData.callId);
            window.clearTimeout(toolCall.timeoutId);
            if (rawData.error) {
                toolCall.reject(new Error(rawData.error));
            } else {
                toolCall.resolve(rawData.result);
            }
            return;
        }

        const data = rawData as ProxyRequest | undefined;
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
                const registry = requireApplicationRegistryAPI();
                if (data.method === 'call') {
                    const [methodName, ...args] = data.args as [string, ...unknown[]];
                    result = await registry.call(bundle, methodName, ...args);
                } else if (data.method === 'callMainWorld') {
                    const [methodName, ...args] = data.args as [string, ...unknown[]];
                    result = await registry.callMainWorld(bundle, methodName, ...args);
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
                            await registry.streamCall(bundle, methodName, sendChunk, ...args);
                        } else {
                            await registry.streamCallMainWorld(bundle, methodName, sendChunk, ...args);
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
                    await registry.subscribeEvent(bundle, eventName, (...args: unknown[]) => {
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
                if (data.method === 'subscribeTaskUpdate') {
                    const [taskId] = data.args as [string];
                    result = await window.taskManagerAPI.subscribeTaskUpdate(taskId, (progress: unknown) => {
                        (event.source as Window).postMessage(
                            {
                                channel: CHANNEL,
                                type: 'taskUpdate',
                                requestId: data.requestId,
                                progress
                            } satisfies ProxyTaskUpdate,
                            '*'
                        );
                    });
                } else if (data.method === 'attachToolset') {
                    const [taskId, toolset] = data.args as [string, unknown];
                    result = await window.taskManagerAPI.attachToolset(
                        taskId,
                        toolset,
                        (toolName: string, args: unknown) => {
                            const callId = crypto.randomUUID();
                            return new Promise((resolve, reject) => {
                                const timeoutId = window.setTimeout(() => {
                                    pendingToolCalls.delete(callId);
                                    reject(new Error(`Application tool ${toolName} timed out`));
                                }, 60_000);
                                pendingToolCalls.set(callId, { resolve, reject, timeoutId });
                                (event.source as Window).postMessage(
                                    {
                                        channel: CHANNEL,
                                        type: 'toolCall',
                                        callbackId: data.requestId,
                                        callId,
                                        toolName,
                                        args
                                    } satisfies ProxyToolCall,
                                    '*'
                                );
                            });
                        }
                    );
                } else {
                    result = await fn(...data.args);
                }
            } else if (data.api === 'theme') {
                const theme = requireThemeAPI();
                if (data.method === 'getResolvedTheme') {
                    result = await theme.getResolvedTheme();
                } else if (data.method === 'setPreference') {
                    result = await theme.setPreference(data.args[0] as string);
                } else if (data.method === 'registerThemeListener') {
                    if (!themeUnsubscribe) {
                        themeUnsubscribe = theme.onThemeChanged((resolved) => {
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
            } else if (data.api === 'workspace') {
                const api = (window as any).workspaceAPI as Record<string, (...a: unknown[]) => unknown>;
                const fn = api[data.method];
                if (typeof fn !== 'function') {
                    throw new Error(`workspaceAPI.${data.method} is not available`);
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
