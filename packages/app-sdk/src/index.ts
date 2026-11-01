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

import { z } from 'zod';
import { parentPort } from 'worker_threads';
import PQueue from 'p-queue';
import { randomUUID } from 'crypto';

export { z };

export interface CliOption {
    name: string;
    description?: string;
    boolean?: boolean;
    defaultValue?: string | boolean;
    parse?: (value: string) => string | boolean;
    /** 是否允许在 CLI 上重复指定多次（如 --opt a --opt b），Commander 会收集为数组 */
    repeated?: boolean;
}

export interface EventDecl {
    eventName: string;
    eventDescription: string;
}

export interface ProtocolHandlerConfig {
    scheme: string;
    privileges?: any;
    handler: (request: any) => Promise<Response> | Response;
}

export interface OpenDeskAppManifest {
    schemaVersion: 1;
    bundleName: string;
    displayName: string;
    versionName: string;
    entry: string;
    icon?: string;
    description?: string;
    skills?: string[];
    permissions?: string[];
}

export type OpenDeskAppPackageManifest = OpenDeskAppManifest;

export type OpenDeskNotificationType = 'info' | 'warning' | 'error';

export interface OpenDeskAppHost {
    getConfig?: (bundleName: string) => unknown;
    setConfig?: (bundleName: string, config: unknown, schema: z.ZodObject<any>) => void;
    getDataDirectory?: (bundleName: string) => string;
    callWorker?: (bundleName: string, methodName: string, ...args: any[]) => Promise<any>;
    logInfo?: (message: string) => void;
    logWarn?: (message: string) => void;
    /** 把应用侧的结果反馈交给 OpenDesk 的通知中枢（系统通知/通知中心） */
    notify?: (type: OpenDeskNotificationType, source: string, title: string, message: string) => void;
}

let host: OpenDeskAppHost | undefined;

export function setOpenDeskAppHost(nextHost: OpenDeskAppHost): void {
    host = nextHost;
}

export function getOpenDeskAppHost(): OpenDeskAppHost | undefined {
    return host;
}

/** Clone-safe diagnostic metadata for worker RPC; these are protocol fields. */
export function serializeAppError(error: unknown): {
    message: string;
    code?: string;
    category?: string;
    details?: unknown;
} {
    const value = error as { message?: string; code?: string; category?: string; details?: unknown } | null;
    let details: unknown;
    try {
        details = structuredClone(value?.details);
    } catch {
        /* Diagnostics must not break error delivery. */
    }
    return {
        message: value?.message || String(error),
        code: typeof value?.code === 'string' ? value.code : undefined,
        category: typeof value?.category === 'string' ? value.category : undefined,
        details
    };
}

export class BaseWorker {
    static pendingAppRequests: Map<
        string,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
            timer: NodeJS.Timeout;
        }
    > = new Map();

    /** Settle the original RPC only; late responses after timeout are ignored. */
    static handleAppResponse(message: {
        id: string;
        status: string;
        data?: unknown;
        message?: string;
        code?: string;
        category?: string;
        details?: unknown;
    }): void {
        const pending = this.pendingAppRequests.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingAppRequests.delete(message.id);
        if (message.status === 'ok') pending.resolve(message.data);
        else
            pending.reject(
                Object.assign(new Error(message.message || 'unknown callAppWithResponse error'), {
                    code: message.code,
                    category: message.category,
                    details: message.details
                })
            );
    }

    bundleName: string;
    config: object;
    appDataDirectory: string;
    taskQueue: PQueue;

    constructor(bundleName: string, appDataDirectory: string) {
        this.bundleName = bundleName;
        this.config = {};
        this.appDataDirectory = appDataDirectory;
        this.taskQueue = new PQueue({ concurrency: 1 });
    }

    async handleMessage(methodName: string, ...args: any[]): Promise<any> {
        if (typeof (this as any)[methodName] === 'function') {
            return await (this as any)[methodName](...args);
        }
        throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
    }

    async *handleStreamMessage(methodName: string, ...args: any[]): AsyncGenerator<any> {
        if (typeof (this as any)[methodName] === 'function') {
            yield* (this as any)[methodName](...args);
            return;
        }
        throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
    }

    async initialize(): Promise<void> {}

    async finalize(): Promise<void> {}

    async applicationConfigChanged(config: object): Promise<void> {
        this.config = config;
    }

    async emitEvent(eventName: string, ...args: any[]): Promise<void> {
        parentPort?.postMessage({
            type: 'emitEvent',
            bundleName: this.bundleName,
            eventName,
            args
        });
    }

    callApp(methodName: string, ...args: any[]): void {
        parentPort?.postMessage({
            type: 'callApp',
            bundleName: this.bundleName,
            methodName,
            args
        });
    }

    callAppWithResponse<R>(methodName: string, ...args: any[]): Promise<R> {
        const requestId = randomUUID();
        const timeoutMs = 60_000;
        const promise = new Promise<R>((resolve, reject) => {
            const timer = setTimeout(() => {
                BaseWorker.pendingAppRequests.delete(requestId);
                reject(
                    Object.assign(new Error(`callAppWithResponse ${methodName} timed out after ${timeoutMs}ms`), {
                        code: 'rpc_timeout',
                        category: 'bridge'
                    })
                );
            }, timeoutMs);
            BaseWorker.pendingAppRequests.set(requestId, { resolve, reject, timer });
        });

        parentPort?.postMessage({
            type: 'callApp',
            bundleName: this.bundleName,
            requestId,
            methodName,
            args
        });

        return promise;
    }

    async runSequentially(task: () => Promise<void>): Promise<void> {
        return await this.taskQueue.add(task);
    }
}

export abstract class BaseApplication {
    bundleName: string;
    showIcon: boolean;
    eventSubscribers: Map<string, Map<any, number>>;
    registry?: any;
    private _declaredEventsCache: Set<string> | null = null;
    private _tuiStatusUpdateCallback?: () => void;

    constructor(bundleName: string, showIcon: boolean = true) {
        this.bundleName = bundleName;
        this.showIcon = showIcon;
        this.eventSubscribers = new Map();
    }

    abstract getName(): string;

    static getWorkerClass(): typeof BaseWorker | undefined {
        return undefined;
    }

    static registerCliSubcommands(_prog: any): void {}

    static getCliOptions(): CliOption[] {
        return [];
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({});
    }

    /**
     * 返回 true 表示该应用是试验性应用。
     * 当系统设置中未启用该应用的独立开关时，该应用的图标将被隐藏。
     */
    isExperimental(): boolean {
        return false;
    }

    toJSON(): {
        bundleName: string;
        name: string;
        showIcon: boolean;
        isExperimental: boolean;
        needAgentBar: boolean;
    } {
        return {
            bundleName: this.bundleName,
            name: this.getName(),
            showIcon: this.showIcon,
            isExperimental: this.isExperimental(),
            needAgentBar: this.needAgentBar()
        };
    }

    /**
     * 推一条系统通知（界面通知中心 / 系统通知）。
     *
     * 应用内的一次性结果反馈（如启用、禁用、保存成功）走这里，不要占应用页面里的提示区域。
     * 宿主未注入通知通道时静默丢弃：通知只是反馈，不该影响调用方的业务流程。
     */
    sendNotification(type: OpenDeskNotificationType, source: string, title: string, message: string): void {
        getOpenDeskAppHost()?.notify?.(type, source, title, message);
    }

    addSubscriber(eventName: string, senderFrame: any): void {
        if (!this.eventSubscribers.has(eventName)) {
            this.eventSubscribers.set(eventName, new Map());
        }
        const subscribers = this.eventSubscribers.get(eventName)!;
        subscribers.set(senderFrame, (subscribers.get(senderFrame) ?? 0) + 1);
    }

    removeSubscriber(eventName: string, senderFrame: any): void {
        const subscribers = this.eventSubscribers.get(eventName);
        if (!subscribers) return;
        const count = subscribers.get(senderFrame);
        if (count === undefined) return;
        if (count <= 1) {
            subscribers.delete(senderFrame);
        } else {
            subscribers.set(senderFrame, count - 1);
        }
        if (subscribers.size === 0) {
            this.eventSubscribers.delete(eventName);
        }
    }

    getProtocolHandlers(): ProtocolHandlerConfig[] {
        return [];
    }

    sendEventToSubscribers(eventName: string, ...args: any[]): void {
        const subscribers = this.eventSubscribers.get(eventName);
        if (!subscribers) return;

        for (const subscriber of [...subscribers.keys()]) {
            if (typeof subscriber.isDestroyed === 'function' && subscriber.isDestroyed()) {
                subscribers.delete(subscriber);
                continue;
            }
            subscriber.send(`applicationRegistry:event:${eventName}`, ...args);
        }
    }

    clearDeclaredEventsCache(): void {
        this._declaredEventsCache = null;
    }

    private async _getDeclaredEvents(): Promise<Set<string>> {
        if (this._declaredEventsCache !== null) {
            return this._declaredEventsCache;
        }
        const events = await this.getSupportedEvents();
        this._declaredEventsCache = new Set(events.map((event) => event.eventName));
        return this._declaredEventsCache;
    }

    async validateEventName(eventName: string): Promise<boolean> {
        const declaredEvents = await this._getDeclaredEvents();
        if (!declaredEvents.has(eventName)) {
            host?.logWarn?.(
                `Event "${eventName}" is not declared in getSupportedEvents() for application "${this.bundleName}".`
            );
            return false;
        }
        return true;
    }

    async emitEvent(eventName: string, ...args: any[]): Promise<void> {
        await this.validateEventName(eventName);
        this.sendEventToSubscribers(eventName, ...args);
        this.registry?.dispatchEvent?.(this.bundleName, eventName, ...args);
    }

    setRegistry(registry: any): void {
        this.registry = registry;
    }

    getCliOptions(): Record<string, string | boolean | undefined> {
        return {};
    }

    setCliOptions(_options: Record<string, string | boolean | undefined>): void {}

    needAgentBar(): boolean {
        return false;
    }

    getConfig(): z.output<z.ZodObject<any>> | undefined {
        return host?.getConfig?.(this.bundleName) as z.output<z.ZodObject<any>> | undefined;
    }

    setConfig(config: any): void {
        const schema: z.ZodObject<any> = Object.getPrototypeOf(this).constructor.getConfigSchema();
        host?.setConfig?.(this.bundleName, config, schema);
    }

    onConfigChanged(): void {
        host?.logInfo?.(`application ${this.bundleName} config changed`);
    }

    async getToolsets(): Promise<any[]> {
        return [];
    }

    async getSkills(): Promise<any[]> {
        return [];
    }

    async getAgents(): Promise<any[]> {
        return [];
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [];
    }

    getCliSlashCommands(_tui: any): any[] {
        return [];
    }

    async getTUIStatusBlock(): Promise<string | null> {
        return null;
    }

    async beforeExit(): Promise<void> {}

    /**
     * 确保应用已完成延迟加载（Agent、插件等资源）。
     * 默认实现为空操作；支持延迟加载的应用覆写此方法。
     * 调用方在打开应用或访问其资源前应 await ensureLoaded()。
     */
    async ensureLoaded(): Promise<void> {}

    setTUIStatusUpdateCallback(cb: () => void): void {
        this._tuiStatusUpdateCallback = cb;
    }

    noticeTUIStatusUpdate(): void {
        this._tuiStatusUpdateCallback?.();
    }

    getDataDirectory(): string {
        const directory = host?.getDataDirectory?.(this.bundleName);
        if (!directory) {
            throw new Error('OpenDesk app host does not provide getDataDirectory');
        }
        return directory;
    }

    async callWorker(methodName: string, ...args: any[]): Promise<any> {
        if (this.registry?.callWorker) {
            return await this.registry.callWorker(this.bundleName, methodName, ...args);
        }
        if (host?.callWorker) {
            return await host.callWorker(this.bundleName, methodName, ...args);
        }
        throw new Error(`application's registry is not configured`);
    }
}
