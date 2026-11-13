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

import { serializeAppError } from '../../../packages/app-sdk/src/index.js';
import { BaseToolset } from '../aikernel/tool.js';
import type { TaskState } from '../aikernel/states/tasks.js';
import { BaseApplication } from './base';
import { Setting, getOpendeskDirectory } from '../utils/setting.js';
import { logger, LogStream } from '../utils/logger.js';
import { addLine as addCliLogLine } from '../utils/cliLogStore.js';
import { NotificationManager } from '../utils/notificationmgr.js';
import { getPlatform, type PlatformFetchOptions } from '../../platforms/base.js';
import { Worker } from 'worker_threads';
import { SkillRegistry } from '../aikernel/skill.js';
import { AgentRegistry } from '../aikernel/agents/registry.js';
import { type Privileges, type ProtocolRequest } from 'electron';
import { AppManagerStore } from './appmgr/manager.js';
import { ExternalManifestApplication } from './appmgr/external.js';
import { WorkerRestartController, type WorkerRestartDecision } from './worker-restart.js';
import { toErrorMessage } from '../../common/utils/error.js';
import { getFeatureManager } from '../../common/features/manager.js';
import { t } from '../../locale/index.js';
import path from 'path';

export type ProtocolHandlerEntry = {
    scheme: string;
    privileges?: Privileges;
    handler: (request: ProtocolRequest) => Response | Promise<Response>;
};

type WorkerRuntimeOptions = {
    preferredSystemLanguages?: readonly string[];
    /** 启动时已被插件禁用的特性列表，随 workerData 注入 worker 线程（如 filemgr 的 AI 索引门控） */
    disabledFeatures?: readonly string[];
    /** 启动时已被插件禁用的应用列表，随 workerData 注入（被禁用的应用要停掉自身后台资源） */
    disabledApplications?: readonly string[];
    /** Hosts can supply a live source so a restarted worker gets the latest language snapshot. */
    getPreferredSystemLanguages?: () => readonly string[];
};

const DATABASE_KIT_METHODS = new Set([
    'available',
    'execSql',
    'execSqlParams',
    'querySqlShort',
    'openStore',
    'deleteStore',
    'bm25Query',
    'closeStore',
    'executePrepared',
    'executePreparedMany',
    'queryPrepared',
    'beginTransaction',
    'commitTransaction',
    'rollbackTransaction'
]);

export class ApplicationRegistry {
    private static applicationEventListeners = new Set<
        (bundleName: string, eventName: string, args: unknown[]) => void | Promise<void>
    >();

    static onApplicationEvent(
        listener: (bundleName: string, eventName: string, args: unknown[]) => void | Promise<void>
    ): () => void {
        this.applicationEventListeners.add(listener);
        return () => this.applicationEventListeners.delete(listener);
    }

    private static notifyApplicationEventListeners(bundleName: string, eventName: string, args: unknown[]): void {
        for (const listener of this.applicationEventListeners) {
            Promise.resolve()
                .then(() => listener(bundleName, eventName, args))
                .catch((error) => {
                    logger.error(`Application event listener failed: ${bundleName}:${eventName}`, error);
                });
        }
    }
    static applications: Map<string, BaseApplication> = new Map();
    static externalApplicationBundles: Set<string> = new Set();
    static pendingRequests: Map<
        string,
        {
            resolve: (value: any) => void;
            reject: (reason?: any) => void;
        }
    > = new Map();
    static pendingStreamRequests: Map<string, (chunk: any, error?: string) => void> = new Map();
    static activeFetchReaders: Map<string, ReadableStreamDefaultReader<Uint8Array>> = new Map();
    static globalWorker: Worker | null = null;
    private static applicationListChangedCallbacks: Array<() => void> = [];

    /** 应用注册表是否已就绪 */
    private static isReady: boolean = false;

    /** 就绪回调队列 */
    private static readyCallbacks: (() => void)[] = [];

    /** 所有应用延迟资源完成加载后 resolved；所有调用方共享同一个启动屏障。 */
    private static fullyLoadedPromise?: Promise<void>;

    /** 单个应用的延迟资源加载状态（bundleName -> 加载 Promise），供按应用加载复用。 */
    private static applicationLoadPromises = new Map<string, Promise<void>>();

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

    /**
     * 返回所有应用延迟资源的共享加载屏障。
     * 首个调用方触发加载，后续调用方复用同一个 Promise。
     */
    static ensureFullyLoaded(): Promise<void> {
        if (!this.fullyLoadedPromise) {
            this.fullyLoadedPromise = this.loadAllApplicationResources();
        }
        return this.fullyLoadedPromise;
    }

    /**
     * 只等待单个应用的延迟资源（Agent、插件、Skill 列表等）。
     *
     * 打开应用只需要目标应用自身就绪，不必等其它应用、遥测或浏览器初始化；
     * 每个应用最多加载一次，重复调用复用同一个 Promise，加载失败只记日志不抛出
     * （与全量加载屏障的容错行为保持一致）。
     */
    static ensureApplicationLoaded(bundleName: string): Promise<void> {
        // 被插件禁用的应用不再加载延迟资源（图标已隐藏、工具集/事件已停用）
        if (getFeatureManager().isApplicationDisabled(bundleName)) {
            return Promise.resolve();
        }

        const loaded = this.applicationLoadPromises.get(bundleName);
        if (loaded) return loaded;

        const application = this.applications.get(bundleName);
        if (!application) return Promise.resolve();

        const promise = (async () => {
            try {
                await application.ensureLoaded();
            } catch (err) {
                logger.error(`Lazy load failed for ${bundleName}: ${err}`);
            }
        })();
        this.applicationLoadPromises.set(bundleName, promise);
        return promise;
    }

    private static async loadAllApplicationResources(): Promise<void> {
        // 这里不整体卸载应用 Agent：应用只在各自 ensureLoaded() 里用 replaceApplicationAgent
        // 覆盖注册，而 ensureLoaded() 是记忆化的。卸载若晚于某个应用的个体加载（打开应用的
        // 窄屏障会先加载目标应用），就会把它刚注册的 Agent 抹掉且不会重新注册。
        await Promise.all(
            Array.from(this.applications.keys()).map((bundleName) => this.ensureApplicationLoaded(bundleName))
        );
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
        // 同一 bundleName 换了新实例后必须重新走一遍延迟加载，丢弃旧实例的加载结果
        this.applicationLoadPromises.delete(application.bundleName);

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
            this.applicationLoadPromises.delete(bundleName);
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
        const featureManager = getFeatureManager();
        return Array.from(this.applications.values()).map((application) => {
            const json = application.toJSON() as { bundleName: string; showIcon?: boolean };
            // 被插件禁用/隐藏的应用对渲染进程表现为不显示图标（菜单/侧栏弹层、桌面图标据此隐藏）。
            // 只有禁用会停掉工具集与事件，故单独给一个 disabledByPlugin 标记：桌面据此关掉已打开
            // 的浮动窗口，而仅隐藏入口的应用（hideApplication）仍在后台运行，窗口保持不变
            const disabled = featureManager.isApplicationDisabled(json.bundleName);
            if (disabled || featureManager.isApplicationHidden(json.bundleName)) {
                return { ...json, showIcon: false, disabledByPlugin: disabled };
            }
            return json;
        });
    }

    static getApplication(bundleName: string): BaseApplication | undefined {
        return this.applications.get(bundleName);
    }

    static async listAvailableToolsets(taskState?: TaskState): Promise<BaseToolset[]> {
        const result: BaseToolset[] = [];
        const featureManager = getFeatureManager();
        for (const application of this.applications.values()) {
            // 被插件禁用的应用不向任务提供工具集
            if (featureManager.isApplicationDisabled(application.bundleName)) {
                continue;
            }
            // 部分应用实现接受可选 taskState（超集签名），按宽签名转发。
            // 实现内部普遍读取 this（如 SearchApplication.getToolsets 调 this.normalizeConfig()），
            // 必须以 application 为 this 调用，摘成裸函数会把 this 丢成 undefined
            const getToolsets = application.getToolsets as (
                this: BaseApplication,
                taskState?: TaskState
            ) => Promise<BaseToolset[]>;
            try {
                result.push(...(await getToolsets.call(application, taskState)));
            } catch (error) {
                // 单个应用（含插件提供的后装应用）构建工具集失败时不能让整轮任务失败：
                // 其余应用的工具集照常可用，缺失的这部分由错误日志追踪。
                logger.error(
                    `[registry] application ${application.bundleName} failed to provide toolsets: ${toErrorMessage(error)}`
                );
            }
        }

        return result;
    }

    /**
     * 从主进程侧派发应用事件，同时通知 renderer 订阅者和 todomgr worker（触发器匹配）
     * 注意：此方法不进行事件校验，仅用于内部转发
     */
    static dispatchEvent(bundleName: string, eventName: string, ...args: any[]): void {
        // 被插件禁用的应用不再派发事件（订阅者与 todomgr 触发器均不感知）
        if (getFeatureManager().isApplicationDisabled(bundleName)) {
            return;
        }
        const application = this.getApplication(bundleName);
        if (application) {
            application.sendEventToSubscribers(eventName, ...args);
        }
        this.notifyApplicationEventListeners(bundleName, eventName, args);
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
        // 与 dispatchEvent 一致：被插件禁用的应用事件不再向订阅者/插件/todomgr 转发
        if (getFeatureManager().isApplicationDisabled(bundleName)) {
            return;
        }
        const application = ApplicationRegistry.getApplication(bundleName);
        if (!application) {
            logger.warn(`application ${bundleName} not found`);
            return;
        }

        // 校验事件名是否已声明，未声明只报 warning，业务流程继续执行
        await application.validateEventName(eventName);

        // 发送事件给订阅者
        application.sendEventToSubscribers(eventName, ...args);
        ApplicationRegistry.notifyApplicationEventListeners(bundleName, eventName, args);

        // 转发给 todomgr worker 进行事件触发器匹配（避免自身事件循环）
        // worker 崩溃/重启窗口内 globalWorker 为 null，getGlobalWorker() 会抛错，而这个 async
        // 方法的拒绝只在调用侧被收走（见 dispatchWorkerMessage）。窗口内的事件无法转发，只能丢弃，
        // 但要留日志：否则用户只会看到"事件触发了但待办没动"却查不到任何痕迹。
        if (bundleName !== 'todomgr') {
            if (!ApplicationRegistry.hasGlobalWorker()) {
                logger.warn(`global worker unavailable, event ${bundleName}:${eventName} not forwarded to todomgr`);
            } else {
                ApplicationRegistry.getGlobalWorker().postMessage({
                    bundleName: 'todomgr',
                    requestId: crypto.randomUUID(),
                    methodName: 'handleApplicationEvent',
                    args: [bundleName, eventName, args]
                });
            }
        }
    }

    /**
     * 获取所有应用注册的事件清单
     * @returns 返回一个 Map，key 为 bundleName，value 为该应用声明的事件列表
     */
    static async getAllSupportedEvents(): Promise<Map<string, { eventName: string; eventDescription: string }[]>> {
        const result = new Map<string, { eventName: string; eventDescription: string }[]>();
        const featureManager = getFeatureManager();
        for (const [bundleName, application] of this.applications) {
            if (featureManager.isApplicationDisabled(bundleName)) {
                continue;
            }
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

        // 被插件禁用的应用不再响应 worker 方法调用（如语义搜索、事件订阅查询）
        if (getFeatureManager().isApplicationDisabled(bundleName)) {
            return { status: 'error', message: t('feature.application.disabled', { bundleName }) };
        } else if (application === undefined) {
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
            return { status: 'error', ...serializeAppError(error), message: String(error) };
        }
    }
}

/**
 * 等待 Worker 回执的上限。
 * Worker 是单线程，若消息在 Worker 侧异常路径上丢失（没有回执），无超时会让调用方永久挂起，
 * 进而把设置面板的保存队列一起卡住，因此这里必须有兜底。
 */
const WORKER_SYNC_TIMEOUT_MS = 10_000;

/** 发送一条系统级（bundleName='__system'）Worker 消息并等待回执 */
async function requestSystemWorker(methodName: string, args: unknown[], timeoutMessage: string): Promise<void> {
    const requestId = crypto.randomUUID();
    const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ApplicationRegistry.pendingRequests.delete(requestId);
            reject(new Error(timeoutMessage));
        }, WORKER_SYNC_TIMEOUT_MS);
        timer.unref?.();
        ApplicationRegistry.pendingRequests.set(requestId, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (reason) => {
                clearTimeout(timer);
                reject(reason);
            }
        });
    });
    ApplicationRegistry.getGlobalWorker().postMessage({
        bundleName: '__system',
        requestId,
        methodName,
        args
    });
    try {
        await promise;
    } finally {
        ApplicationRegistry.pendingRequests.delete(requestId);
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
    const preferredSystemLanguages =
        runtimeOptions.getPreferredSystemLanguages?.() ?? runtimeOptions.preferredSystemLanguages;
    const args: unknown[] = [settingData];
    if (preferredSystemLanguages) {
        args.push([...preferredSystemLanguages]);
    }
    await requestSystemWorker('__updateGlobalSetting', args, 'worker settings sync timed out');
}

/**
 * 把主进程维护的禁用状态同步到 Worker 线程。
 *
 * Worker 线程的 FeatureManager 只镜像特性级状态（worker.ts 的 applyDisabledFeatures），
 * 不自行产生禁用状态；需要停止自身资源的 Worker（如 filemgr 的 AI 索引）由同一消息
 * 拿到特性 + 应用两份列表后自行判断（feature 禁用或应用自身被禁用都要停索引）。
 */
export async function notifyWorkerFeatureUpdate(
    disabledFeatures: readonly string[],
    disabledApplications: readonly string[] = []
): Promise<void> {
    if (!ApplicationRegistry.hasGlobalWorker()) {
        logger.warn('global worker not initialized, cannot notify feature update');
        return;
    }
    await requestSystemWorker(
        '__updateDisabledFeatures',
        [[...disabledFeatures], [...disabledApplications]],
        'worker feature sync timed out'
    );
}

/** 上一次成功推给 Worker 的禁用状态签名，用于按内容去重 */
let lastPushedDisabledStateKey: string | null = null;

/**
 * 当前禁用状态推给 Worker（fire-and-forget，失败只记日志）。
 * 特性级与应用级任一变化都会走到这里，但隐藏入口（hideApplication）不改变 Worker 关心的状态，
 * 故按内容去重；Worker 重启时用 force 强制补推，新实例只带了启动值。
 */
function pushDisabledStateToWorker(options: { force?: boolean } = {}): void {
    const manager = getFeatureManager();
    const features = manager.getDisabledFeatures();
    const applications = manager.getDisabledApplications();
    const key = JSON.stringify([features, applications]);
    if (!options.force && key === lastPushedDisabledStateKey) return;
    lastPushedDisabledStateKey = key;
    void notifyWorkerFeatureUpdate(features, applications).catch((error) => {
        // 推送失败时清掉签名，让下一次状态变化能重新尝试
        lastPushedDisabledStateKey = null;
        logger.warn(`push disabled features to worker failed: ${error}`);
    });
}

let featureWorkerSyncRegistered = false;

/**
 * 订阅禁用状态变更并同步到 Worker 线程（线程内 FeatureManager 镜像 + 门控 worker 转发）。
 *
 * main 与 cli 共用：两者都在 initializeRegistryWorker 之前完成插件 setup，启动值随
 * workerData 注入，运行时变更（插件启停）由这里推送；worker 崩溃重启出的新实例只携带
 * 启动值，也由这里在重启回调里补推。由 initializeRegistryWorker 调用；测试可单独触发。
 */
export function ensureFeatureWorkerSync(): void {
    if (featureWorkerSyncRegistered) return;
    featureWorkerSyncRegistered = true;
    const manager = getFeatureManager();
    manager.onFeaturesChanged(() => pushDisabledStateToWorker());
    manager.onApplicationsChanged(() => pushDisabledStateToWorker());
    onGlobalWorkerRestarted(() => pushDisabledStateToWorker({ force: true }));
}

/**
 * 初始化应用注册表和协议处理
 * 在 app.whenReady() 之前调用，用于注册应用实例和协议 schemes
 */
let featureApplicationListenerRegistered = false;

/**
 * 订阅插件特性禁用变更：ctx.features.disableApplication / hideApplication 生效/回退时
 * 向渲染进程推送刷新后的应用列表。由 initializeRegistry 调用；测试可单独触发。
 */
export function ensureFeatureDisableSubscription(): void {
    if (featureApplicationListenerRegistered) return;
    featureApplicationListenerRegistered = true;
    getFeatureManager().onApplicationsChanged(() => {
        ApplicationRegistry.notifyApplicationListChanged();
    });
}

let applicationFeatureFiltersRegistered = false;

/**
 * 把「应用被插件禁用」注入到 Skill / Agent 的可见性判断。
 *
 * disableApplication 停用应用的全部贡献：图标、工具集、事件、Skill、Agent、TUI 斜杠命令与
 * worker 调用。SkillRegistry / AgentRegistry 属于 aikernel 层，保持与 applications 层解耦，
 * 因此这里注入过滤函数而不是让它们直接依赖 FeatureManager。
 * hideApplication 不参与：它只收起入口，应用的 Skill / Agent / 工具集照常工作。
 */
function ensureApplicationFeatureFilters(): void {
    if (applicationFeatureFiltersRegistered) return;
    applicationFeatureFiltersRegistered = true;
    const isDisabled = (bundleName: string) => getFeatureManager().isApplicationDisabled(bundleName);
    SkillRegistry.registerProviderFilter((bundleName) => !isDisabled(bundleName));
    AgentRegistry.registerVisibilityFilter((agent) => {
        const scope = agent.applicationScope;
        return scope === undefined || !isDisabled(scope);
    });
}

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
    ensureApplicationFeatureFilters();

    // 应用注册的时候会改变设置的Schema，所以这里需要清空一下重新载入
    Setting.clearCache();

    // 标记应用注册表已就绪，执行所有等待中的回调
    ApplicationRegistry.markAsReady();

    // 插件通过 ctx.features.disableApplication 禁用应用后，向渲染进程推送刷新后的应用列表
    ensureFeatureDisableSubscription();
}

// Worker 重启相关状态
let cachedRuntimeOptions: WorkerRuntimeOptions = {};
const MAX_WORKER_RESTARTS = 5;
const WORKER_STABLE_RESET_DELAY_MS = 30000;
const workerRestartController = new WorkerRestartController(MAX_WORKER_RESTARTS);
let settingUpdateCallbackRegistered = false;

/**
 * 全局 worker 崩溃重启后的回调：重启出的新 worker 不携带任何运行时注入状态
 * （agent 专属 server、插件技能内部 MCP server 等），宿主借此补齐。
 */
type GlobalWorkerRestartListener = () => void | Promise<void>;
const globalWorkerRestartListeners = new Set<GlobalWorkerRestartListener>();

export function onGlobalWorkerRestarted(listener: GlobalWorkerRestartListener): () => void {
    globalWorkerRestartListeners.add(listener);
    return () => globalWorkerRestartListeners.delete(listener);
}

/** 触发重启回调并汇聚异步结果；仅供 worker 重启路径与测试使用 */
export function notifyGlobalWorkerRestarted(): Promise<void> {
    const results: unknown[] = [];
    for (const listener of globalWorkerRestartListeners) {
        try {
            results.push(listener());
        } catch (error) {
            logger.warn('global worker restart listener failed', error);
        }
    }
    const promises = results.filter((result): result is Promise<void> => result instanceof Promise);
    return promises.length > 0 ? Promise.all(promises).then(() => undefined) : Promise.resolve();
}

/**
 * 初始化 Worker 和协议 handlers
 * 在 app.whenReady() 之后调用
 */
export function initializeRegistryWorker(runtimeOptions: WorkerRuntimeOptions = {}) {
    cachedRuntimeOptions = runtimeOptions;
    workerRestartController.reset();
    // 特性禁用的启动值随 workerData 注入；运行时变更的推送订阅在这里统一注册（main/cli 共用）
    ensureFeatureWorkerSync();
    spawnGlobalWorker(runtimeOptions);
}

function spawnGlobalWorker(runtimeOptions: WorkerRuntimeOptions) {
    // 生产环境 worker 已由 electron-vite 编译为 worker.js，不可再传 execArgv: ['tsx']，
    // 否则子 Node 进程参数非法，在 OpenHarmony 等环境下会导致 Worker 创建失败、globalWorker 一直为 null。
    const spawnAttempt = {};
    let worker: Worker;
    try {
        const preferredSystemLanguages =
            runtimeOptions.getPreferredSystemLanguages?.() ?? runtimeOptions.preferredSystemLanguages;
        worker = new Worker(getPlatform().getWorkerPath(), {
            workerData: {
                paths: {
                    opendeskDirectory: getOpendeskDirectory(),
                    mainBundleDir: path.dirname(getPlatform().getWorkerPath())
                },
                setting: Setting.getInstance().getData(),
                preferredSystemLanguages: preferredSystemLanguages ? [...preferredSystemLanguages] : undefined,
                disabledFeatures: runtimeOptions.disabledFeatures ? [...runtimeOptions.disabledFeatures] : undefined,
                disabledApplications: runtimeOptions.disabledApplications
                    ? [...runtimeOptions.disabledApplications]
                    : undefined
            }
        });
    } catch (error) {
        logger.error('spawnGlobalWorker: failed to spawn global worker', error);
        scheduleWorkerRestart(spawnAttempt);
        return;
    }

    ApplicationRegistry.globalWorker = worker;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;

    worker.once('online', () => {
        stableTimer = setTimeout(() => {
            stableTimer = undefined;
            if (ApplicationRegistry.globalWorker === worker) {
                workerRestartController.markStable();
            }
        }, WORKER_STABLE_RESET_DELAY_MS);
    });

    const rejectPendingWorkerRequests = (error: Error) => {
        for (const pending of ApplicationRegistry.pendingRequests.values()) {
            pending.reject(error);
        }
        ApplicationRegistry.pendingRequests.clear();
        const streams = Array.from(ApplicationRegistry.pendingStreamRequests.values());
        ApplicationRegistry.pendingStreamRequests.clear();
        for (const callback of streams) {
            try {
                callback(undefined, error.message);
            } catch (callbackError) {
                // A renderer may already have closed; still terminate the other clients.
                logger.warn('failed to notify a stream client after worker failure', callbackError);
            }
        }
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

    const handleWorkerFailure = (error: Error) => {
        const decision = scheduleWorkerRestart(worker);
        if (!decision.firstFailure) return;
        if (stableTimer !== undefined) {
            clearTimeout(stableTimer);
            stableTimer = undefined;
        }
        rejectPendingWorkerRequests(error);
        if (ApplicationRegistry.globalWorker === worker) {
            ApplicationRegistry.globalWorker = null;
        }
    };

    worker.on('error', (error: unknown) => {
        logger.error('global worker error:', error);
        handleWorkerFailure(error instanceof Error ? error : new Error(String(error)));
    });

    worker.on('exit', (code) => {
        if (ApplicationRegistry.globalWorker === worker) {
            ApplicationRegistry.globalWorker = null;
        }
        if (stableTimer !== undefined) {
            clearTimeout(stableTimer);
            stableTimer = undefined;
        }
        if (code === 0) return;
        const error = new Error(`global worker exited with code ${code}`);
        const decision = scheduleWorkerRestart(worker);
        if (!decision.firstFailure) return;
        logger.error(error.message);
        rejectPendingWorkerRequests(error);
    });

    ApplicationRegistry.globalWorker.on('message', (event) => {
        dispatchWorkerMessageSafely(event, worker);
    });

    // 网络配置变更时同步到 Worker，确保代理/SSL 设置在 Worker 中实时生效
    // 只注册一次回调，worker 重启后自动使用 ApplicationRegistry.globalWorker 获取新实例
    if (!settingUpdateCallbackRegistered) {
        settingUpdateCallbackRegistered = true;
        Setting.afterSetDataCallbacks.push((previousData, nextData) => {
            const nc = nextData.network_config;
            if (!nc) return;
            // 只有网络配置真的变了才发：应用配置、内置模型等内部写入也会走到这里，
            // 每次都全量同步会给 Worker 带来无谓的消息与解析开销
            if (JSON.stringify(previousData.network_config) === JSON.stringify(nc)) return;
            if (ApplicationRegistry.globalWorker) {
                ApplicationRegistry.globalWorker.postMessage({
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
}

/**
 * 处理来自全局 Worker 线程的单条消息帧（进程边界入口）。
 *
 * main.ts 把 uncaughtException / unhandledRejection 一律当作不可恢复错误并 app.exit(1)，
 * 而这里处理的都是 worker 侧事件，单个帧处理失败（事件载荷异常、应用回调同步抛错等）
 * 属于可恢复的业务失败，不能升级成进程退出。
 */
function dispatchWorkerMessageSafely(event: any, worker: Worker): void {
    try {
        dispatchWorkerMessage(event, worker);
    } catch (error) {
        logger.error(`failed to dispatch worker message ${event?.type}: ${toErrorMessage(error)}`);
    }
}

/**
 * 处理来自全局 Worker 线程的单条消息帧。
 * 拆分为独立函数，便于对帧分流与流请求终止逻辑进行单元测试。
 */
export function dispatchWorkerMessage(event: any, worker: Worker): void {
    // 处理来自 worker 的日志消息
    switch (event.type) {
        case 'response': {
            const pending = ApplicationRegistry.pendingRequests.get(event.id);
            if (pending) {
                ApplicationRegistry.pendingRequests.delete(event.id);
                if (event.status === 'ok') {
                    pending.resolve(event.data);
                } else {
                    pending.reject(
                        Object.assign(new Error(event.message || 'unknown error'), {
                            code: event.code,
                            category: event.category,
                            details: event.details
                        })
                    );
                }
                break;
            }
            // 防御：流式请求的 id 收到普通 response 帧（例如异常路径或旧版 worker）时，
            // 也必须终止流请求，否则 pendingStreamRequests 与 renderer 侧 listener 会泄漏
            const streamCallback = ApplicationRegistry.pendingStreamRequests.get(event.id);
            if (streamCallback) {
                ApplicationRegistry.pendingStreamRequests.delete(event.id);
                streamCallback(undefined, event.status === 'error' ? event.message : undefined);
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
                ApplicationRegistry.pendingStreamRequests.delete(event.id);
                if (event.status === 'error') {
                    callback(undefined, event.message);
                } else {
                    callback(undefined);
                }
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
            // handleWorkerEmitEvent 是 async：拒绝必须在这里消费。未消费会逃逸成主进程级
            // unhandledRejection，而 main.ts 把它当不可恢复错误直接 app.exit(1)。
            // 事件分发失败属于可恢复的业务失败，记日志即可。
            ApplicationRegistry.handleWorkerEmitEvent(bundleName, eventName, args).catch((error) => {
                logger.error(`emitEvent ${bundleName}:${eventName} failed: ${toErrorMessage(error)}`);
            });
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
                                throw new Error(`callApp: method ${methodName} not found on application ${appBundle}`);
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
                            ...serializeAppError(error)
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
            const { todoId, todoTitle, todoContent, trigger, deliver, workspace, model, reasoningEffort } = event;
            logger.info(`收到触发器任务请求: todo=${todoId}`);
            const todoApp = ApplicationRegistry.getApplication('todomgr');
            if (todoApp && typeof (todoApp as any).triggerTodoTask === 'function') {
                (todoApp as any)
                    .triggerTodoTask(
                        todoId,
                        todoTitle,
                        todoContent,
                        trigger,
                        deliver,
                        workspace,
                        model,
                        reasoningEffort
                    )
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
            if (skillApp) {
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
}

/**
 * 调度 worker 重启，带指数退避和最大重试次数限制
 */
function scheduleWorkerRestart(source: object): WorkerRestartDecision {
    const decision = workerRestartController.schedule(source, () => {
        // 重新读取当前设置，确保重启后的 worker 拿到最新配置
        spawnGlobalWorker(cachedRuntimeOptions);
        // 新 worker 不携带运行时注入状态，通知宿主补齐（如插件技能内部 MCP server 的配置登记）
        void notifyGlobalWorkerRestarted();
    });
    if (decision.exhausted) {
        logger.error(`global worker crashed and max restart attempts (${MAX_WORKER_RESTARTS}) exceeded, giving up`);
    } else if (decision.scheduled) {
        logger.info(
            `global worker will restart in ${decision.delayMs}ms (attempt ${decision.attempt}/${MAX_WORKER_RESTARTS})`
        );
    }
    return decision;
}
