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
import { setRuntimePreferredSystemLanguages } from '../../locale/index.js';

import { parentPort, workerData } from 'worker_threads';
import path from 'path';

const appWorkers: Map<string, BaseWorker> = new Map();
// 记录各个worker的初始化状态
const workerInitPromises: Map<string, Promise<void>> = new Map();

/* 这里我们不直接使用Setting类，而是传object进来，因为Setting类的Schema中ApplicationSchema
 * 在worker线程中无法使用 */
const setting: object = workerData?.setting;
setRuntimePreferredSystemLanguages(workerData?.preferredSystemLanguages ?? null);

export function initializeAppWorkers() {
    for (const APPLICATION_CLASS of getPlatform().getApplicationClasses()) {
        const WORKER_CLASS = APPLICATION_CLASS.getWorkerClass();
        if (!WORKER_CLASS) {
            continue;
        }

        const app = new APPLICATION_CLASS();
        const appDataDir = path.join(getOpendeskDirectory(), 'apps', app.bundleName);
        const appWorker = new WORKER_CLASS(app.bundleName, appDataDir);
        appWorkers.set(app.bundleName, appWorker);
    }

    for (const [name, appWorker] of appWorkers.entries()) {
        logger.info(`initializing worker ${name}`);
        const appDataDirectory = path.join(getOpendeskDirectory(), 'apps', name);
        appWorker.appDataDirectory = appDataDirectory;
        appWorker.applicationConfigChanged(setting['applications'][name]);
        // 将初始化Promise存储到Map中
        const initPromise = appWorker.initialize().catch((error) => {
            logger.error(`worker ${name} initialization failed: ${error}`);
            throw error;
        });
        workerInitPromises.set(name, initPromise);
    }

    parentPort?.on('message', async (message) => {
        const { bundleName, requestId, methodName, args, stream } = message;

        if (message.type === 'response') {
            const pending = BaseWorker.pendingAppRequests.get(message.id);
            if (!pending) {
                return;
            }
            clearTimeout(pending.timer);
            BaseWorker.pendingAppRequests.delete(message.id);
            if (message.status === 'ok') {
                pending.resolve(message.data);
            } else {
                pending.reject(new Error(message.message || 'unknown callAppWithResponse error'));
            }
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
            parentPort?.postMessage({ type: 'response', id: requestId, status: 'ok', data: null });
            return;
        }

        const appWorker = appWorkers.get(bundleName);

        if (appWorker) {
            try {
                // 等待worker初始化完成
                const initPromise = workerInitPromises.get(bundleName);
                if (initPromise) {
                    await initPromise;
                }

                if (stream) {
                    for await (const chunk of appWorker.handleStreamMessage(methodName, ...args)) {
                        parentPort?.postMessage({
                            type: 'response_chunk',
                            id: requestId,
                            chunk: chunk
                        });
                    }
                    parentPort?.postMessage({ type: 'response_complete', id: requestId });
                } else {
                    const result = await appWorker.handleMessage(methodName, ...args);
                    parentPort?.postMessage({
                        type: 'response',
                        id: requestId,
                        status: 'ok',
                        data: result
                    });
                }
            } catch (error) {
                logger.error(`error calling worker ${bundleName} method ${methodName}: ${error}`);
                parentPort?.postMessage({
                    type: 'response',
                    id: requestId,
                    status: 'error',
                    message: error.message
                });
            }
        } else {
            logger.error(`worker ${bundleName} not found`);
            parentPort?.postMessage({
                type: 'response',
                id: requestId,
                status: 'error',
                message: `worker ${bundleName} not found`
            });
        }
    });

    logger.info('worker initialized successfully');
}
