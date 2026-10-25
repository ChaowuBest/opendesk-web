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
import { getOpendeskDirectory, Setting } from '../utils/setting';
import { getPlatform } from '../../platforms/base';
import { toErrorMessage } from '../../common/utils/error.js';
import { setRuntimePreferredSystemLanguages } from '../../locale/index.js';

import { parentPort, workerData } from 'worker_threads';
import path from 'path';

const appWorkers: Map<string, BaseWorker> = new Map();
// 记录各个worker的初始化状态
const workerInitPromises: Map<string, Promise<void>> = new Map();

/* 这里我们不直接使用Setting类，而是传object进来，因为Setting类的Schema中ApplicationSchema
 * 在worker线程中无法使用 */
// workerData.setting 由主进程注入，形态为 { applications: { [bundleName]: config } }
const setting = (workerData?.setting ?? {}) as { applications?: Record<string, object> };
setRuntimePreferredSystemLanguages(workerData?.preferredSystemLanguages ?? null);

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
        workerInitPromises.set(name, initPromise);
    }

    parentPort?.on('message', (message) => {
        handleWorkerRequest(message, appWorkers, workerInitPromises, (frame) => parentPort?.postMessage(frame));
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
        Setting.updateInstanceData(newSettingData);
        postMessage({ type: 'response', id: requestId, status: 'ok', data: null });
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
                    message: toErrorMessage(error)
                });
            } else {
                postMessage({
                    type: 'response',
                    id: requestId,
                    status: 'error',
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
