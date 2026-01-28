import { BaseToolset } from "../agents/tool";
import { BaseApplication } from "./base.js";
import { SkillRegistry } from "../services/skills/SkillRegistry.js";
import { MailboxApplication } from "./mailbox/app.js";
import { FileMgrApplication } from "./filemgr/app.js";
import { CalendarApplication } from "./calendar/app.js";
import { A2AApplication } from "./a2a/app.js";
import { RecallApplication } from "./recall/app.js";
import { SearchApplication } from "./search/app.js";
import { NewsApplication } from "./news/app.js";
import { TerminalApplication } from "./terminal/app.js";
import { PPTCreatorApplication } from "./ppt/app.js";
import { DesignerApplication } from "./designer/app.js";
import { Setting, getAppDirectory } from "../utils/setting.js";
import { logger, LogStream } from "../utils/logger.js";
import { NotificationManager } from "../utils/notificationmgr.js";
import { app } from 'electron';
import { Worker } from "worker_threads";
import path from 'path';


const APPLICATION_CLASSES: (typeof BaseApplication)[] = [
    MailboxApplication,
    FileMgrApplication,
    CalendarApplication,
    TerminalApplication,
    A2AApplication,
    RecallApplication,
    SearchApplication,
    NewsApplication,
    PPTCreatorApplication,
    DesignerApplication,
];

export type ProtocolHandlerEntry = {
    scheme: string;
    privileges?: Electron.Privileges;
    handler: (request: Electron.ProtocolRequest) => Response | Promise<Response>;
};

var pendingRequests: Map<string, {
    resolve: (value: any) => void,
    reject: (reason?: any) => void
}> = new Map();
var pendingStreamRequests: Map<string, (chunk: any) => void> = new Map();
var globalWorker: Worker | null = null;


export class ApplicationRegistry {
    static applications: Map<string, BaseApplication> = new Map();

    static registerApplication(application: BaseApplication) {
        this.applications.set(application.bundleName, application);
        application.setRegistry(this);
        Setting.registerApplicationSettings(application, () => {
            application.onConfigChanged();
            globalWorker?.postMessage({
                bundleName: application.bundleName,
                methodName: 'applicationConfigChanged',
                args: [application.getConfig()],
            })
        });
    }

    static collectProtocolHandlerEntries(): ProtocolHandlerEntry[] {
        let entries: ProtocolHandlerEntry[] = [];
        for (const application of this.applications.values()) {
            entries.push(...application.getProtocolHandlers());
        }
        return entries;
    }

    static getApplicationList(): object[] {
        return Array.from(this.applications.values()).map(application => application.toJSON());
    }

    static getApplication(bundleName: string): BaseApplication | undefined {
        return this.applications.get(bundleName);
    }

    static async listAvailableToolsets(): Promise<BaseToolset[]> {
        let result: BaseToolset[] = [];
        for (const application of this.applications.values()) {
            result.push(...(await application.getToolsets()));
        }
        return result;
    }

    static async callWorker(bundleName: string, methodName: string, ...args: any[]): Promise<any> {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        } else if (globalWorker === null) {
            return { status: 'error', message: 'global worker not initialized yet' }
        }

        try {
            let promise = new Promise((resolve, reject) => {
                pendingRequests.set(requestId, { resolve, reject });
            });

            globalWorker.postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args,
            })

            const data = await promise;
            pendingRequests.delete(requestId);
            return { status: 'ok', data: data };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    }
};

/**
 * 注册应用注册器IPC处理程序
 */
export function registerApplicationRegistryHandlers(ipcMain: Electron.IpcMain) {
    ipcMain.handle('applicationRegistry:getApplicationGUIConfig', async (event, bundleName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        return { status: 'ok', data: application.getGUIConfig() };
    })
    ipcMain.handle('applicationRegistry:getApplicationList', async (event) => {
        return { status: 'ok', data: ApplicationRegistry.getApplicationList() };
    })
    ipcMain.handle('applicationRegistry:call', async (event, bundleName, methodName, ...args) => {
        return ApplicationRegistry.callWorker(bundleName, methodName, ...args);
    })
    ipcMain.handle('applicationRegistry:callMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        const method = application[methodName];
        if (method === undefined) {
            return { status: 'error', message: `method ${methodName} not found in application ${bundleName}` }
        }
        return { status: 'ok', data: await method(...args) };
    })
    ipcMain.handle('applicationRegistry:streamCall', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        } else if (globalWorker === null) {
            return { status: 'error', message: 'global worker not initialized yet' }
        }

        try {
            const callback = (chunk) => {
                event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk);
            }
            pendingStreamRequests.set(requestId, callback);

            globalWorker.postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args,
                stream: true,
            })

            return { status: 'ok', requestId: requestId };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    })
    ipcMain.handle('applicationRegistry:streamCallMainWorld', async (event, bundleName, methodName, ...args) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        const requestId = crypto.randomUUID();

        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` }
        }
        const method = application[methodName];
        if (method === undefined) {
            return { status: 'error', message: `method ${methodName} not found in application ${bundleName}` }
        }

        const send = (chunk: any) => {
            event.senderFrame?.send?.(`applicationRegistry:streamChunk:${requestId}`, chunk);
        };

        (async () => {
            try {
                for await (const chunk of method.apply(application, args)) {
                    send(chunk);
                }
                send(undefined);
            } catch (error) {
                logger.error(`streamCallMainWorld ${bundleName}.${methodName} error: ${error}`);
                send(undefined);
            }
        })();

        return { status: 'ok', requestId };
    })
    ipcMain.handle('applicationRegistry:subscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.addSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    })
    ipcMain.handle('applicationRegistry:unsubscribe', async (event, bundleName, eventName) => {
        const application = ApplicationRegistry.getApplication(bundleName);
        if (application === undefined) {
            return { status: 'error', message: `application ${bundleName} not found` };
        }
        application.removeSubscriber(eventName, event.senderFrame);
        return { status: 'ok' };
    })
}

/**
 * 通知 Worker 线程更新全局设置
 * @param settingData - 新的设置数据
 */
export function notifyWorkerSettingUpdate(settingData: object) {
    if (globalWorker === null) {
        logger.warn('global worker not initialized, cannot notify setting update');
        return;
    }
    globalWorker.postMessage({
        bundleName: '__system',
        requestId: crypto.randomUUID(),
        methodName: '__updateGlobalSetting',
        args: [settingData],
    });
}

export function initializeRegistry() {
    for (const APPLICATION_CLASS of APPLICATION_CLASSES) {
        ApplicationRegistry.registerApplication(new APPLICATION_CLASS());
    }

    globalWorker = new Worker(
        path.join(app.getAppPath(), 'dist', 'main', 'worker.js'),
        {
            workerData: {
                paths: { appDirectory: getAppDirectory() },
                setting: Setting.getInstance().getData()
            }
        }
    );

    globalWorker.on('message', (event) => {
        // 处理来自 worker 的日志消息
        switch (event.type) {
            case 'response': {
                const pending = pendingRequests.get(event.id);
                if (pending) {
                    pendingRequests.delete(event.id);
                    if (event.status === 'ok') {
                        pending.resolve(event.data);
                    } else {
                        pending.reject(new Error(event.message || 'unknown error'));
                    }
                }
                break;
            }
            case 'response_chunk': {
                const callback = pendingStreamRequests.get(event.id);
                if (callback) {
                    callback(event.chunk);
                }
                break;
            }
            case 'response_complete': {
                const callback = pendingStreamRequests.get(event.id);
                if (callback) {
                    callback(undefined);
                    pendingStreamRequests.delete(event.id);
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
                LogStream.getStream().write(event.message + '\n');
                break;
            }
            case 'subscribeEvent': {
                const { bundleName, eventName, args } = event;
                const application = ApplicationRegistry.getApplication(bundleName);
                if (!application) {
                    logger.warn(`application ${bundleName} not found`);
                    return;
                }
                application.sendEventToSubscribers(eventName, ...args);
                break;
            }
            case 'emailListUpdated': {
                const application = ApplicationRegistry.getApplication(event.bundleName);
                if (application && 'onEmailListUpdated' in application && typeof (application as any).onEmailListUpdated === 'function') {
                    (application as any).onEmailListUpdated();
                }
                break;
            }
            default: {
                console.info(event);
                break;
            }
        }
    });
}
