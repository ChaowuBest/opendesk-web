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

import { BaseToolset } from '../aikernel/tool.js';
import { BaseApplication } from './base';
import { Setting, getOpendeskDirectory } from '../utils/setting.js';
import { logger, LogStream } from '../utils/logger.js';
import { addLine as addCliLogLine } from '../utils/cliLogStore.js';
import { NotificationManager } from '../utils/notificationmgr.js';
import { getPlatform, type PlatformFetchOptions } from '../../platforms/base.js';
import { Worker } from 'worker_threads';
import { SkillRegistry } from '../aikernel/skill.js';
import { AgentRegistry } from '../aikernel/agents/registry.js';
import type { AgentDecl } from '../aikernel/agents/common.js';
import { type Privileges, type ProtocolRequest } from 'electron';
import { AppManagerStore } from './appmgr/manager.js';
import { ExternalManifestApplication } from './appmgr/external.js';
import path from 'path';

export type ProtocolHandlerEntry = {
    scheme: string;
    privileges?: Privileges;
    handler: (request: ProtocolRequest) => Response | Promise<Response>;
};

type WorkerRuntimeOptions = {
    preferredSystemLanguages?: readonly string[];
};

const DATABASE_KIT_METHODS = new Set([
    'available',
    'execSql',
    'execSqlParams',
    'querySqlShort',
    'openStore',
    'closeStore',
    'executePrepared',
    'executePreparedMany',
    'queryPrepared',
    'beginTransaction',
    'commitTransaction',
    'rollbackTransaction'
]);

export class ApplicationRegistry {
    static applications: Map<string, BaseApplication> = new Map();
    static externalApplicationBundles: Set<string> = new Set();
    static pendingRequests: Map<
        string,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
        }
    > = new Map();
    static pendingStreamRequests: Map<string, (chunk: any) => void> = new Map();
    static activeFetchReaders: Map<string, ReadableStreamDefaultReader<Uint8Array>> = new Map();
    static globalWorker: Worker | null = null;
    private static applicationListChangedCallbacks: Array<() => void> = [];

    /** 应用注册表是否已就绪 */
    private static isReady: boolean = false;

    /** 就绪回调队列 */
    private static readyCallbacks: (() => void)[] = [];

    /**
     * 注册就绪回调。如果应用注册表已就绪，则立即执行；否则加入队列等待。
     * @param callback 就绪后执行的回调函数
     */
    static onReady(callback: () => void): void {
        if (this.isReady) {
            callback();
        } else {
            this.readyCallbacks.push(callback);
        }
    }

    /**
     * 标记应用注册表为已就绪，并执行所有等待中的回调。
     */
    static markAsReady(): void {
        this.isReady = true;
        for (const callback of this.readyCallbacks) {
            try {
                callback();
            } catch (err) {
                logger.error('Error in ApplicationRegistry ready callback:', err);
            }
        }
        this.readyCallbacks = [];
    }

    /**
     * 检查应用注册表是否已就绪
     */
    static isRegistryReady(): boolean {
        return this.isReady;
    }

    static hasGlobalWorker(): boolean {
        return this.globalWorker !== null;
    }

    static getGlobalWorker(): Worker {
        if (this.globalWorker === null) {
            throw new Error('global worker not initialized yet');
        }
        return this.globalWorker;
    }

    private static hasApplicationWorker(application: BaseApplication): boolean {
        const ApplicationClass = Object.getPrototypeOf(application).constructor as typeof BaseApplication;
        return ApplicationClass.getWorkerClass() !== undefined;
    }

    static registerApplication(application: BaseApplication) {
        this.applications.set(application.bundleName, application);

        // 先注册应用的配置 Schema，确保后续 getConfig() 能正确解析
        if ((application as any).source !== 'user') {
            Setting.registerApplicationSettings(application, () => {
                application.onConfigChanged();
                if (this.hasApplicationWorker(application)) {
                    this.globalWorker?.postMessage({
                        bundleName: application.bundleName,
                        methodName: 'applicationConfigChanged',
                        args: [application.getConfig()]
                    });
                }
            });
        }

        // 刷新 Setting 缓存，使 Setting.getInstance() 用已扩展的 Schema 重新加载
        // 解决 setRegistry() → startGateway() 时读不到 devicemgr 等应用配置的问题
        Setting.clearCache();

        application.setRegistry(this);

        // 注册Skill
        const skillRegistry = SkillRegistry.getInstance();
        skillRegistry.registerSkillProvider(application.bundleName, application);
    }

    static registerExternalApplication(application: BaseApplication) {
        this.externalApplicationBundles.add(application.bundleName);
        this.registerApplication(application);
    }

    static reloadExternalApplications(): void {
        const skillRegistry = SkillRegistry.getInstance();
        for (const bundleName of this.externalApplicationBundles) {
            this.applications.delete(bundleName);
            skillRegistry.unregisterSkillProvider(bundleName);
        }
        this.externalApplicationBundles.clear();

        for (const appRecord of AppManagerStore.listActiveApps()) {
            if (this.applications.has(appRecord.bundleName)) {
                logger.warn(`[appmgr] skip user app ${appRecord.bundleName}: bundleName conflicts with system app`);
                continue;
            }
            this.registerExternalApplication(new ExternalManifestApplication(appRecord));
        }
    }

    static notifyApplicationListChanged(): void {
        for (const application of this.applications.values()) {
            application.sendEventToSubscribers('applicationListChanged', this.getApplicationList());
        }
        for (const callback of this.applicationListChangedCallbacks) {
            try {
                callback();
            } catch (error) {
                logger.error('Error in application list changed callback:', error);
            }
        }
    }

    static onApplicationListChanged(callback: () => void): void {
        this.applicationListChangedCallbacks.push(callback);
    }

    static getApplicationGUIConfig(bundleName: string): object | undefined {
        const application = this.getApplication(bundleName);
        if (!application) {
            return undefined;
        }
        return application.toJSON();
    }

    static collectProtocolHandlerEntries(): ProtocolHandlerEntry[] {
        const entries: ProtocolHandlerEntry[] = [];
        for (const application of this.applications.values()) {
            entries.push(...application.getProtocolHandlers());
        }
        return entries;
    }

    static getApplicationList(): object[] {
        return Array.from(this.applications.values()).map((application) => application.toJSON());
    }

    static getApplication(bundleName: string): BaseApplication | undefined {
        return this.applications.get(bundleName);
    }

    static async listAvailableToolsets(): Promise<BaseToolset[]> {
        const result: BaseToolset[] = [];
        for (const application of this.applications.values()) {
            result.push(...(await application.getToolsets()));
        }

        return result;
    }

    /**
     * 重新收集应用提供的 Agent，并交给 AIKernel 注册表管理。
     */
    static async loadAvailableAgents(): Promise<void> {
        await AgentRegistry.unloadCustomAgents();
        const agents: AgentDecl[] = [];
        for (const application of this.applications.values()) {
            try {
                agents.push(...((await application.getAgents()) as AgentDecl[]));
            } catch (error) {
                logger.warn(`Failed to load agents from ${application.bundleName}: ${error}`);
            }
        }
        await AgentRegistry.replaceCustomAgents(agents);
    }

    /**
     * 从主进程侧派发应用事件，同时通知 renderer 订阅者和 todomgr worker（触发器匹配）
     * 注意：此方法不进行事件校验，仅用于内部转发
     */
    static dispatchEvent(bundleName: string, eventName: string, ...args: any[]): void {
        const application = this.getApplication(bundleName);
        if (application) {
            application.sendEventToSubscribers(eventName, ...args);
        }
        // 转发给 todomgr worker 进行触发器匹配
        if (this.hasGlobalWorker() && bundleName !== 'todomgr') {
            this.getGlobalWorker().postMessage({
                bundleName: 'todomgr',
                requestId: crypto.randomUUID(),
                methodName: 'handleApplicationEvent',
                args: [bundleName, eventName, args]
            });
        }
    }

    /**
     * 处理 Worker 侧发出的事件（带事件名校验）
     */
    static async handleWorkerEmitEvent(bundleName: string, eventName: string, args: any[]): Promise<void> {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (!application) {
            logger.warn(`application ${bundleName} not found`);
            return;
        }

        // 校验事件名是否已声明，未声明只报 warning，业务流程继续执行
        await application.validateEventName(eventName);

        // 发送事件给订阅者
        application.sendEventToSubscribers(eventName, ...args);

        // 转发给 todomgr worker 进行事件触发器匹配（避免自身事件循环）
        if (bundleName !== 'todomgr') {
            ApplicationRegistry.getGlobalWorker().postMessage({
                bundleName: 'todomgr',
                requestId: crypto.randomUUID(),
                methodName: 'handleApplicationEvent',
                args: [bundleName, eventName, args]
            });
        }
    }

    /**
     * 获取所有应用注册的事件清单
     * @returns 返回一个 Map，key 为 bundleName，value 为该应用声明的事件列表
     */
    static async getAllSupportedEvents(): Promise<Map<string, { eventName: string; eventDescription: string }[]>> {
        const result = new Map<string, { eventName: string; eventDescription: string }[]>();
        for (const [bundleName, application] of this.applications) {
            try {
                const events = await application.getSupportedEvents();
                if (events.length > 0) {
                    result.set(bundleName, events);
                }
            } catch (error) {
                logger.warn(`Failed to get supported events for ${bundleName}: ${error}`);
            }
        }
        return result;
    }

    static async callWorker(bundleName: string, methodName: string, ...args: any[]): Promise<any> {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        } else if (!ApplicationRegistry.hasGlobalWorker()) {
            return { status: 'error', message: 'global worker not initialized yet' };
        } else if (!ApplicationRegistry.hasApplicationWorker(application)) {
            return { status: 'error', message: `worker ${bundleName} not found` };
        }

        try {
            const promise = new Promise((resolve, reject) => {
                ApplicationRegistry.pendingRequests.set(requestId, { resolve, reject });
            });

            ApplicationRegistry.getGlobalWorker().postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args
            });

            const data = await promise;
            ApplicationRegistry.pendingRequests.delete(requestId);
            return { status: 'ok', data: data };
        } catch (error) {
            return { status: 'error', message: String(error) };
        }
    }
}

/**
 * 通知 Worker 线程更新全局设置
 * @param settingData - 新的设置数据
 */
export async function notifyWorkerSettingUpdate(
    settingData: object,
    runtimeOptions: WorkerRuntimeOptions = {}
): Promise<void> {
    if (!ApplicationRegistry.hasGlobalWorker()) {
        logger.warn('global worker not initialized, cannot notify setting update');
        return;
    }
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
        ApplicationRegistry.pendingRequests.set(requestId, { resolve, reject });
    });
    const args: unknown[] = [settingData];
    if (runtimeOptions.preferredSystemLanguages) {
        args.push([...runtimeOptions.preferredSystemLanguages]);
    }
    ApplicationRegistry.getGlobalWorker().postMessage({
        bundleName: '__system',
        requestId,
        methodName: '__updateGlobalSetting',
        args
    });
    try {
        await promise;
    } finally {
        ApplicationRegistry.pendingRequests.delete(requestId);
    }
}

/**
 * 初始化应用注册表和协议处理
 * 在 app.whenReady() 之前调用，用于注册应用实例和协议 schemes
 */
export function initializeRegistry() {
    // 注册所有应用实例
    for (const APPLICATION_CLASS of getPlatform().getApplicationClasses()) {
        // @ts-ignore 这个地方后边再改 ...
        const appInstance = new APPLICATION_CLASS();
        if (!ApplicationRegistry.applications.has(appInstance.bundleName)) {
            ApplicationRegistry.registerApplication(appInstance);
        }
    }
    ApplicationRegistry.reloadExternalApplications();

    // 应用注册的时候会改变设置的Schema，所以这里需要清空一下重新载入
    Setting.clearCache();

    // 标记应用注册表已就绪，执行所有等待中的回调
    ApplicationRegistry.markAsReady();
}

/**
 * 初始化 Worker 和协议 handlers
 * 在 app.whenReady() 之后调用
 */
export function initializeRegistryWorker(runtimeOptions: WorkerRuntimeOptions = {}) {
    // 生产环境 worker 已由 electron-vite 编译为 worker.js，不可再传 execArgv: ['tsx']，
    // 否则子 Node 进程参数非法，在 OpenHarmony 等环境下会导致 Worker 创建失败、globalWorker 一直为 null。
    let worker: Worker;
    try {
        worker = new Worker(getPlatform().getWorkerPath(), {
            workerData: {
                paths: {
                    opendeskDirectory: getOpendeskDirectory(),
                    mainBundleDir: path.dirname(getPlatform().getWorkerPath())
                },
                setting: Setting.getInstance().getData(),
                preferredSystemLanguages: runtimeOptions.preferredSystemLanguages
                    ? [...runtimeOptions.preferredSystemLanguages]
                    : undefined
            }
        });
    } catch (error) {
        logger.error('initializeRegistryWorker: failed to spawn global worker', error);
        ApplicationRegistry.globalWorker = null;
        return;
    }

    ApplicationRegistry.globalWorker = worker;

    const rejectPendingWorkerRequests = (error: Error) => {
        for (const pending of ApplicationRegistry.pendingRequests.values()) {
            pending.reject(error);
        }
        ApplicationRegistry.pendingRequests.clear();
        for (const callback of ApplicationRegistry.pendingStreamRequests.values()) {
            callback(undefined);
        }
        ApplicationRegistry.pendingStreamRequests.clear();
        // 清理所有活跃的 fetch reader
        for (const [id, reader] of ApplicationRegistry.activeFetchReaders) {
            try {
                reader.cancel();
            } catch (_e) {
                /* ignore */
            }
        }
        ApplicationRegistry.activeFetchReaders.clear();
    };

    worker.on('error', (error) => {
        logger.error('global worker error:', error);
        rejectPendingWorkerRequests(error);
        if (ApplicationRegistry.globalWorker === worker) {
            ApplicationRegistry.globalWorker = null;
        }
    });

    worker.on('exit', (code) => {
        if (ApplicationRegistry.globalWorker === worker) {
            ApplicationRegistry.globalWorker = null;
        }
        if (code === 0) return;
        const error = new Error(`global worker exited with code ${code}`);
        logger.error(error.message);
        rejectPendingWorkerRequests(error);
    });

    ApplicationRegistry.globalWorker.on('message', (event) => {
        // 处理来自 worker 的日志消息
        switch (event.type) {
            case 'response': {
                const pending = ApplicationRegistry.pendingRequests.get(event.id);
                if (pending) {
                    ApplicationRegistry.pendingRequests.delete(event.id);
                    if (event.status === 'ok') {
                        pending.resolve(event.data);
                    } else {
                        pending.reject(new Error(event.message || 'unknown error'));
                    }
                }
                break;
            }
            case 'response_chunk': {
                const callback = ApplicationRegistry.pendingStreamRequests.get(event.id);
                if (callback) {
                    callback(event.chunk);
                }
                break;
            }
            case 'response_complete': {
                const callback = ApplicationRegistry.pendingStreamRequests.get(event.id);
                if (callback) {
                    callback(undefined);
                    ApplicationRegistry.pendingStreamRequests.delete(event.id);
                    break;
                }
                break;
            }
            case 'notification': {
                const { type, source, title, message } = event.payload;
                NotificationManager.getInstance().sendNotification(type, source, title, message);
                break;
            }
            case 'log': {
                const msg = event.message + '\n';
                LogStream.getStream().write(msg);
                addCliLogLine(event.message);
                break;
            }
            case 'emitEvent': {
                const { bundleName, eventName, args } = event;
                ApplicationRegistry.handleWorkerEmitEvent(bundleName, eventName, args);
                break;
            }
            case 'callApp': {
                const { bundleName: appBundle, requestId, methodName, args: callArgs } = event;
                if (requestId) {
                    (async () => {
                        try {
                            let data: unknown;
                            if (methodName === 'databaseKitCall') {
                                const [databaseKitMethod, ...databaseKitArgs] = callArgs || [];
                                if (!DATABASE_KIT_METHODS.has(databaseKitMethod)) {
                                    throw new Error(`databaseKitCall method not allowed: ${databaseKitMethod}`);
                                }
                                const { resolveNativeBridge } = await import('../../platforms/bridges/main.js');
                                const kit = await resolveNativeBridge().getDatabaseKit();
                                data = await (kit as any)[databaseKitMethod](...databaseKitArgs);
                            } else {
                                const app = ApplicationRegistry.getApplication(appBundle);
                                if (!app || typeof (app as any)[methodName] !== 'function') {
                                    throw new Error(
                                        `callApp: method ${methodName} not found on application ${appBundle}`
                                    );
                                }
                                data = await (app as any)[methodName](...(callArgs || []));
                            }
                            worker.postMessage({ type: 'response', id: requestId, status: 'ok', data });
                        } catch (error: any) {
                            logger.error(`callApp ${appBundle}.${methodName} failed:`, error);
                            worker.postMessage({
                                type: 'response',
                                id: requestId,
                                status: 'error',
                                message: error?.message || String(error)
                            });
                        }
                    })();
                    break;
                }
                const app = ApplicationRegistry.getApplication(appBundle);
                if (app && typeof (app as any)[methodName] === 'function') {
                    Promise.resolve((app as any)[methodName](...(callArgs || []))).catch((err: any) =>
                        logger.error(`callApp ${appBundle}.${methodName} failed:`, err)
                    );
                } else {
                    logger.warn(`callApp: method ${methodName} not found on application ${appBundle}`);
                }
                break;
            }
            case 'triggerTodoTask': {
                // 兼容旧消息格式：转发到 TodoMgrApplication.triggerTodoTask
                const { todoId, todoTitle, todoContent, trigger, deliver, workspace } = event;
                logger.info(`收到触发器任务请求: todo=${todoId}`);
                const todoApp = ApplicationRegistry.getApplication('todomgr');
                if (todoApp && typeof (todoApp as any).triggerTodoTask === 'function') {
                    (todoApp as any)
                        .triggerTodoTask(todoId, todoTitle, todoContent, trigger, deliver, workspace)
                        .catch((err: any) => logger.error(`triggerTodoTask failed:`, err));
                }
                break;
            }
            case 'emailListUpdated': {
                const application = ApplicationRegistry.getApplication(event.bundleName);
                if (
                    application &&
                    'onEmailListUpdated' in application &&
                    typeof (application as any).onEmailListUpdated === 'function'
                ) {
                    (application as any).onEmailListUpdated();
                }
                break;
            }
            case 'skillsRegistryChanged': {
                const skillApp = ApplicationRegistry.getApplication('skillmgr');
                if (skillApp && typeof (skillApp as any).refresh === 'function') {
                    (skillApp as any).refresh();
                }
                break;
            }
            case '__fetch_request': {
                const { id, url, init: fetchInit, options: fetchOptions } = event;
                (async () => {
                    let headersSent = false;
                    try {
                        const opts: RequestInit = {};
                        const platformOptions: PlatformFetchOptions | undefined = fetchOptions
                            ? {
                                  forceEnvironmentProxy: !!fetchOptions.forceEnvironmentProxy,
                                  bypassProxy: !!fetchOptions.bypassProxy,
                                  skipTlsVerification: !!fetchOptions.skipTlsVerification
                              }
                            : undefined;
                        if (fetchInit) {
                            if (fetchInit.method) opts.method = fetchInit.method;
                            if (fetchInit.headers) opts.headers = fetchInit.headers;
                            if (fetchInit.body !== undefined) {
                                opts.body = fetchInit.body;
                            } else if (fetchInit.bodyBuffer) {
                                opts.body = Buffer.from(fetchInit.bodyBuffer, 'base64');
                            }
                            if (fetchInit.redirect) opts.redirect = fetchInit.redirect;
                        }
                        const response = await getPlatform().fetch(url, opts, platformOptions);

                        // ① 立即发送 headers
                        const headers: Record<string, string> = {};
                        response.headers.forEach((v, k) => {
                            headers[k] = v;
                        });
                        worker.postMessage({
                            type: '__fetch_response_headers',
                            id,
                            status: 'ok',
                            statusCode: response.status,
                            statusText: response.statusText,
                            headers
                        });
                        headersSent = true;

                        // ② 流式发送 body
                        if (response.body) {
                            const reader = response.body.getReader();
                            ApplicationRegistry.activeFetchReaders.set(id, reader);
                            try {
                                while (true) {
                                    const { done, value } = await reader.read();
                                    if (done) break;
                                    worker.postMessage({
                                        type: '__fetch_response_chunk',
                                        id,
                                        chunk: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
                                            'base64'
                                        )
                                    });
                                }
                            } finally {
                                reader.releaseLock();
                                ApplicationRegistry.activeFetchReaders.delete(id);
                            }
                        }

                        // ③ 发送结束信号
                        worker.postMessage({
                            type: '__fetch_response_end',
                            id
                        });
                    } catch (err: any) {
                        if (!headersSent) {
                            worker.postMessage({
                                type: '__fetch_response_headers',
                                id,
                                status: 'error',
                                message: err.message || String(err)
                            });
                        }
                        ApplicationRegistry.activeFetchReaders.delete(id);
                        worker.postMessage({
                            type: '__fetch_response_end',
                            id,
                            error: err.message || String(err)
                        });
                    }
                })();
                break;
            }
            case '__fetch_abort': {
                const { id } = event;
                const reader = ApplicationRegistry.activeFetchReaders.get(id);
                if (reader) {
                    reader.cancel().catch(() => {
                        // ignore
                    });
                    ApplicationRegistry.activeFetchReaders.delete(id);
                }
                break;
            }
            case '__shell_request': {
                const { id, method, filePath } = event;
                (async () => {
                    try {
                        const platform = getPlatform();
                        switch (method) {
                            case 'openPath':
                                await platform.openPath(filePath);
                                break;
                            case 'openExternal':
                                await platform.openExternal(filePath);
                                break;
                            case 'trashItem':
                                await platform.trashItem(filePath);
                                break;
                            case 'showItemInFolder':
                                await platform.showItemInFolder(filePath);
                                break;
                            default:
                                throw new Error(`Unknown shell method: ${method}`);
                        }
                        worker.postMessage({ type: '__shell_response', id, status: 'ok' });
                    } catch (err: any) {
                        worker.postMessage({
                            type: '__shell_response',
                            id,
                            status: 'error',
                            message: err.message || String(err)
                        });
                    }
                })();
                break;
            }
            default: {
                console.info(event);
                break;
            }
        }
    });

    // 网络配置变更时同步到 Worker，确保代理/SSL 设置在 Worker 中实时生效
    Setting.afterSetDataCallbacks.push(() => {
        const nc = Setting.getInstance().getData().network_config;
        if (worker && nc) {
            worker.postMessage({
                type: '__network_config_updated',
                config: {
                    no_ssl: nc.no_ssl,
                    use_proxy: nc.use_proxy,
                    custom_proxy_addr: nc.custom_proxy_addr,
                    no_proxy: nc.no_proxy
                }
            });
        }
    });
}
