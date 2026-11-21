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
 * 工作线程入口文件
 * 当前设计上整个OpenDesk只保留一个工作线程。这主要是考虑到：
 * 1️⃣ 工作线程过多导致内存开销变大
 * 2️⃣ 原始设计中，由各个应用自行动态导入的工作线程会导致Electron Vite打包识别困难
 *
 * 因此现在每个应用如果需要在工作线程中执行任务，那么必须自己提供worker.ts/js文件，
 * 并在本文件中import这些Worker类，并注册到appWorkers中统一进行初始化和任务分发操作。
 */

import { logger } from '../utils/logger';
import { BaseWorker } from '../applications/base';
import { serializeAppError } from '../../../packages/app-sdk/src/index.js';
import { getOpendeskDirectory, Setting } from '../utils/setting';
import { getPlatform } from '../../platforms/base';
import { toErrorMessage } from '../../common/utils/error.js';
import { setRuntimePreferredSystemLanguages } from '../../locale/index.js';
import { getFeatureManager } from '../../common/features/manager.js';

import { parentPort, workerData } from 'worker_threads';
import path from 'path';

const appWorkers: Map<string, BaseWorker> = new Map();
// 记录各个worker的初始化状态
const workerInitPromises: Map<string, Promise<void>> = new Map();

/* 这里我们不直接使用Setting类，而是传object进来，因为Setting类的Schema中ApplicationSchema
 * 在worker线程中无法使用 */
// workerData.setting 由主进程注入，形态为 { applications: { [bundleName]: config } }
const setting = (workerData?.setting ?? {}) as { applications?: Record<string, object> };
// workerData.disabledFeatures 由主进程注入：插件通过 ctx.features.disableFeature 已禁用的特性列表，
// 供支持特性门控的 worker（如 filemgr 的 AI 索引）在 initialize() 前就位
const disabledFeatures = (workerData?.disabledFeatures ?? []) as string[];
// workerData.disabledApplications 由主进程注入：插件通过 ctx.features.disableApplication 已禁用的
// 应用列表。只在需要自我门控的 worker（如 filemgr 被禁用时停索引）里消费，不进 FeatureManager 镜像。
const disabledApplications = (workerData?.disabledApplications ?? []) as string[];
setRuntimePreferredSystemLanguages(workerData?.preferredSystemLanguages ?? null);

/**
 * 特性禁用状态在 worker 线程 FeatureManager 里的持有者标识。
 * 状态真源始终在主进程，worker 线程只镜像主进程推送的列表，不能自行产生禁用状态。
 */
const WORKER_FEATURE_OWNER = '__worker_host__';

/**
 * 把主进程维护的禁用状态应用到 worker 线程：先镜像特性级禁用到本线程 FeatureManager
 * （供 worker 内被实例化的应用类读取），再把特性 + 应用两份列表转发给实现了
 * setDisabledFeatures 的 worker（如 filemgr 的 AI 索引门控，需要停止扫描/释放索引）。
 *
 * 应用级禁用的多数消费方（图标列表、延迟加载、工具集、事件、callWorker）在主进程；
 * 这里仍下发应用列表，是因为「禁用整个应用」同样应当停掉该应用自己的后台资源
 * （如 filemgr 的索引），否则界面上看不到应用、后台还在扫描写索引。
 *
 * 转发调用在返回前同步进入 worker 的 setDisabledFeatures（该函数第一行设置内部标志），
 * 才能保证随后同步执行的 initialize() 读到正确的门控状态。
 */
export async function applyDisabledFeatures(
    workers: Map<string, BaseWorker>,
    features: readonly string[],
    applications: readonly string[] = []
): Promise<void> {
    const manager = getFeatureManager();
    const next = new Set(features);
    for (const featureId of manager.getDisabledFeatures()) {
        if (!next.has(featureId)) {
            manager.setFeatureDisabled(featureId, WORKER_FEATURE_OWNER, false);
        }
    }
    for (const featureId of next) {
        manager.setFeatureDisabled(featureId, WORKER_FEATURE_OWNER, true);
    }

    const pending: Promise<void>[] = [];
    for (const appWorker of workers.values()) {
        const featureAwareWorker = appWorker as unknown as {
            setDisabledFeatures?: (ids: string[], applications: string[]) => void | Promise<void>;
        };
        if (typeof featureAwareWorker.setDisabledFeatures !== 'function') continue;
        // 同步调用：标志就位后 initialize() 才跑，之后才等待可能的异步拆除
        const result = featureAwareWorker.setDisabledFeatures([...features], [...applications]);
        pending.push(Promise.resolve(result).then(() => undefined));
    }
    await Promise.all(pending);
}

export function initializeAppWorkers() {
    for (const APPLICATION_CLASS of getPlatform().getApplicationClasses()) {
        const WORKER_CLASS = APPLICATION_CLASS.getWorkerClass();
        if (!WORKER_CLASS) {
            continue;
        }

        const app = new (APPLICATION_CLASS as unknown as new () => { bundleName: string })();
        const appDataDir = path.join(getOpendeskDirectory(), 'apps', app.bundleName);
        const appWorker = new WORKER_CLASS(app.bundleName, appDataDir);
        appWorkers.set(app.bundleName, appWorker);
    }

    // 特性门控先于 applicationConfigChanged/initialize()：镜像 workerData 注入的禁用特性，
    // 并转发给支持门控的 worker（如 filemgr 的 AI 索引），被禁用的特性从一开始就不启动
    // 扫描与嵌入。启动路径 fire-and-forget：applyDisabledFeatures 在返回前已同步把门控
    // 标志写进各 worker，initialize() 读到的就是正确值，异步部分（拆除/重建）随后跑。
    void applyDisabledFeatures(appWorkers, disabledFeatures, disabledApplications).catch((error) => {
        logger.error(`apply disabled features to workers failed: ${toErrorMessage(error)}`);
    });

    for (const [name, appWorker] of appWorkers.entries()) {
        logger.info(`initializing worker ${name}`);
        const appDataDirectory = path.join(getOpendeskDirectory(), 'apps', name);
        appWorker.appDataDirectory = appDataDirectory;
        appWorker.applicationConfigChanged(setting.applications?.[name] ?? {});
        // 将初始化Promise存储到Map中
        const initPromise = appWorker.initialize().catch((error) => {
            logger.error(`worker ${name} initialization failed: ${error}`);
            throw error;
        });
        // initPromise 只有在请求到来时才会被 await：初始化失败时这个拒绝会长时间无人观察，
        // 触发 worker 的 unhandledRejection（worker-errors.ts 直接重抛，整个 worker 会被杀掉重启）。
        // 这里先标记为已处理，await 它的请求方仍会正常拿到初始化错误。
        initPromise.catch(() => undefined);
        workerInitPromises.set(name, initPromise);
    }

    parentPort?.on('message', (message) => {
        // handleWorkerRequest 是 async：这里必须消费它的拒绝，否则一次逃逸就会变成
        // worker 级 unhandledRejection，整个 worker 被当作致命错误重启。
        handleWorkerRequest(message, appWorkers, workerInitPromises, (frame) => parentPort?.postMessage(frame)).catch(
            (error) => {
                const reason = toErrorMessage(error);
                logger.error(
                    `failed to handle worker message ${message?.methodName ?? message?.type ?? '?'}: ${reason}`
                );
                // 兜底回执：主进程按 requestId 等待响应，不回执会让调用方永久挂起
                if (message?.type === 'response' || !message?.requestId) return;
                parentPort?.postMessage({
                    type: message.stream ? 'response_complete' : 'response',
                    id: message.requestId,
                    status: 'error',
                    message: reason
                });
            }
        );
    });

    logger.info('worker initialized successfully');
}

/**
 * 处理主进程转发来的单条请求消息。
 * appWorkers / workerInitPromises / postMessage 均由调用方注入，便于单元测试；
 * 生产环境下 postMessage 绑定 parentPort.postMessage。
 */
export async function handleWorkerRequest(
    message: {
        type?: string;
        bundleName?: string;
        requestId?: string;
        methodName?: string;
        args?: any[];
        stream?: boolean;
    },
    appWorkers: Map<string, BaseWorker>,
    workerInitPromises: Map<string, Promise<void>>,
    postMessage: (frame: object) => void
): Promise<void> {
    const { bundleName, requestId, methodName, stream } = message;
    // 业务请求的 args 可缺省（无参调用），统一归一成空数组以便展开
    const args = message.args ?? [];

    if (message.type === 'response') {
        BaseWorker.handleAppResponse(message as Parameters<typeof BaseWorker.handleAppResponse>[0]);
        return;
    }

    // 忽略非业务消息（如 __fetch_response 等由其他模块处理的消息）
    if (!bundleName) {
        return;
    }

    // 处理全局设置更新消息
    if (methodName === '__updateGlobalSetting') {
        const newSettingData = args[0];
        if (args.length > 1) {
            setRuntimePreferredSystemLanguages(args[1]);
        }
        logger.info('received global setting update');
        // 无论成功失败都必须回执：主进程按 requestId 等待响应，
        // 这里抛错却不回执会让保存设置的调用方永久挂起（设置面板会一直处于「保存中」）。
        try {
            Setting.updateInstanceData(newSettingData);
            postMessage({ type: 'response', id: requestId, status: 'ok', data: null });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error(`failed to apply global setting update: ${message}`);
            postMessage({ type: 'response', id: requestId, status: 'error', message });
        }
        return;
    }

    // 处理特性禁用状态更新消息（主进程是唯一真源，这里只做镜像与转发）
    if (methodName === '__updateDisabledFeatures') {
        const nextFeatures = Array.isArray(args[0]) ? args[0].filter((id): id is string => typeof id === 'string') : [];
        const nextApplications = Array.isArray(args[1])
            ? args[1].filter((name): name is string => typeof name === 'string')
            : [];
        try {
            await applyDisabledFeatures(appWorkers, nextFeatures, nextApplications);
            postMessage({ type: 'response', id: requestId, status: 'ok', data: null });
        } catch (error) {
            const reason = toErrorMessage(error);
            logger.error(`failed to apply disabled features: ${reason}`);
            postMessage({ type: 'response', id: requestId, status: 'error', message: reason });
        }
        return;
    }

    const appWorker = appWorkers.get(bundleName);
    // methodName 在协议上可缺省（响应/事件类消息没有方法名）；走到这里的业务请求必然带方法名。
    // 缺失时保持既有行为：交给 handleMessage 抛 "unknown message" 并由下方 catch 转成错误响应。
    const targetMethodName = methodName ?? '';

    if (appWorker) {
        try {
            // 等待worker初始化完成
            const initPromise = workerInitPromises.get(bundleName);
            if (initPromise) {
                await initPromise;
            }

            if (stream) {
                for await (const chunk of appWorker.handleStreamMessage(targetMethodName, ...args)) {
                    postMessage({
                        type: 'response_chunk',
                        id: requestId,
                        chunk: chunk
                    });
                }
                postMessage({ type: 'response_complete', id: requestId });
            } else {
                const result = await appWorker.handleMessage(targetMethodName, ...args);
                postMessage({
                    type: 'response',
                    id: requestId,
                    status: 'ok',
                    data: result
                });
            }
        } catch (error) {
            logger.error(`error calling worker ${bundleName} method ${methodName}: ${error}`);
            if (stream) {
                // 流式请求失败时必须补发 response_complete 终帧：主进程收到普通 response
                // 只查 pendingRequests，不会清理 pendingStreamRequests，renderer 侧的
                // listener 与 streamCall() Promise 也会因此永不 settle（issue #125）
                postMessage({
                    type: 'response_complete',
                    id: requestId,
                    status: 'error',
                    ...serializeAppError(error),
                    message: toErrorMessage(error)
                });
            } else {
                postMessage({
                    type: 'response',
                    id: requestId,
                    status: 'error',
                    ...serializeAppError(error),
                    message: toErrorMessage(error)
                });
            }
        }
    } else {
        logger.error(`worker ${bundleName} not found`);
        postMessage({
            type: 'response',
            id: requestId,
            status: 'error',
            message: `worker ${bundleName} not found`
        });
    }
}
