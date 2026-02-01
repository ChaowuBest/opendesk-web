/**
 * 工作线程入口文件
 * 当前设计上整个FillipDesk只保留一个工作线程。这主要是考虑到：
 * 1️⃣ 工作线程过多导致内存开销变大
 * 2️⃣ 原始设计中，由各个应用自行动态导入的工作线程会导致Electron Vite打包识别困难
 *
 * 因此现在每个应用如果需要在工作线程中执行任务，那么必须自己提供worker.ts/js文件，
 * 并在本文件中import这些Worker类，并注册到appWorkers中统一进行初始化和任务分发操作。
 */

import { logger } from "./utils/logger.js";
import { parentPort, workerData } from 'worker_threads';
import { BaseWorker } from "./applications/base.js";
import { getAppDirectory, Setting } from "./utils/setting.js";
import path from 'path';

import MailboxWorker from './applications/mailbox/service/worker.js'
import CalendarWorker from './applications/calendar/service/worker.js'
import A2AWorker from './applications/a2a/service/worker.js'
import RecallWorker from './applications/recall/service/worker.js'
import FileManagerWorker from './applications/filemgr/worker.js'
import TerminalWorker from './applications/terminal/worker.js'
import PPTWorker from './applications/ppt/worker.js'

const appWorkers: Map<string, BaseWorker> = new Map();
// 记录各个worker的初始化状态
const workerInitPromises: Map<string, Promise<void>> = new Map();

/* 这里我们不直接使用Setting类，而是传object进来，因为Setting类的Schema中ApplicationSchema
 * 在worker线程中无法使用 */
const setting: object = workerData.setting;

appWorkers.set('mailbox', new MailboxWorker(path.join(getAppDirectory(), 'apps', 'mailbox')));
appWorkers.set('calendar', new CalendarWorker(path.join(getAppDirectory(), 'apps', 'calendar')));
appWorkers.set('a2a', new A2AWorker(path.join(getAppDirectory(), 'apps', 'a2a')));
appWorkers.set('recall', new RecallWorker(path.join(getAppDirectory(), 'apps', 'recall')));
appWorkers.set('filemgr', new FileManagerWorker(path.join(getAppDirectory(), 'apps', 'filemgr')));
appWorkers.set('terminal', new TerminalWorker(path.join(getAppDirectory(), 'apps', 'terminal')));
appWorkers.set('ppt', new PPTWorker(path.join(getAppDirectory(), 'apps', 'ppt')));

for (const [name, appWorker] of appWorkers.entries()) {
    logger.info(`initializing worker ${name}`);
    const appDataDirectory = path.join(getAppDirectory(), 'apps', name);
    appWorker.appDataDirectory = appDataDirectory;
    appWorker.applicationConfigChanged(setting['applications'][name]);
    // 将初始化Promise存储到Map中
    const initPromise = appWorker.initialize().catch(error => {
        logger.error(`worker ${name} initialization failed: ${error}`);
        throw error;
    });
    workerInitPromises.set(name, initPromise);
}

parentPort?.on('message', async (message) => {
    const { bundleName, requestId, methodName, args, stream } = message;

    // 处理全局设置更新消息
    if (methodName === '__updateGlobalSetting') {
        const newSettingData = args[0];
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
                    parentPort?.postMessage({ type: 'response_chunk', id: requestId, chunk: chunk });
                }
                parentPort?.postMessage({ type: 'response_complete', id: requestId });
            } else {
                const result = await appWorker.handleMessage(methodName, ...args);
                parentPort?.postMessage({ type: 'response', id: requestId, status: 'ok', data: result });
            }
        } catch (error) {
            logger.error(`error calling worker ${bundleName} method ${methodName}: ${error}`);
            parentPort?.postMessage({ type: 'response', id: requestId, status: 'error', message: error.message });
        }
    } else {
        logger.error(`worker ${bundleName} not found`);
        parentPort?.postMessage({ type: 'response', id: requestId, status: 'error', message: `worker ${bundleName} not found` });
    }
});

logger.info('worker initialized successfully');