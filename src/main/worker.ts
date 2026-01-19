import { logger } from "./utils/logger.js";
import { parentPort, workerData } from 'worker_threads';
import { BaseWorker } from "./applications/base.js";
import { getAppDirectory } from "./utils/setting.js";
import path from 'path';

import MailboxWorker from './applications/mailbox/service/worker.js'
import CalendarWorker from './applications/calendar/service/worker.js'
import A2AWorker from './applications/a2a/service/worker.js'
import RecallWorker from './applications/recall/service/worker.js'
import FileManagerWorker from './applications/filemgr/worker.js'

const appWorkers: Map<string, BaseWorker> = new Map();

/* 这里我们不直接使用Setting类，而是传object进来，因为Setting类的Schema中ApplicationSchema
 * 在worker线程中无法使用 */
const setting: object = workerData.setting;

appWorkers.set('mailbox', new MailboxWorker(path.join(getAppDirectory(), 'apps', 'mailbox')));
appWorkers.set('calendar', new CalendarWorker(path.join(getAppDirectory(), 'apps', 'calendar')));
appWorkers.set('a2a', new A2AWorker(path.join(getAppDirectory(), 'apps', 'a2a')));
appWorkers.set('recall', new RecallWorker(path.join(getAppDirectory(), 'apps', 'recall')));
appWorkers.set('filemgr', new FileManagerWorker(path.join(getAppDirectory(), 'apps', 'filemgr')));

for (const [name, appWorker] of appWorkers.entries()) {
    logger.info(`initializing worker ${name}`);
    const appDataDirectory = path.join(getAppDirectory(), 'apps', name);
    appWorker.appDataDirectory = appDataDirectory;
    appWorker.applicationConfigChanged(setting['applications'][name]);
    appWorker.initialize();
}

parentPort?.on('message', async (message) => {
    const { bundleName, requestId, methodName, args, stream } = message;
    logger.info(`received message from ${bundleName}`);
    const appWorker = appWorkers.get(bundleName);

    if (appWorker) {
        try {
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