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

import { BaseToolset } from "../aikernel/tool.js";
import { BaseApplication } from "./base";
import { Setting, getAppDirectory } from "../utils/setting.js";
import { logger, LogStream } from "../utils/logger.js";
import { addLine as addCliLogLine } from "../utils/cliLogStore.js";
import { NotificationManager } from "../utils/notificationmgr.js";
import { getPlatform } from "../../platforms/base.js";
import { Worker } from "worker_threads";
import { Skill, SkillRegistry } from "../aikernel/skill.js";


export type ProtocolHandlerEntry = {
    scheme: string;
    privileges?: Electron.Privileges;
    handler: (request: Electron.ProtocolRequest) => Response | Promise<Response>;
};


export class ApplicationRegistry {

    static applications: Map<string, BaseApplication> = new Map();
    static pendingRequests: Map<string, {
        resolve: (value: any) => void,
        reject: (reason?: any) => void
    }> = new Map();
    static pendingStreamRequests: Map<string, (chunk: any) => void> = new Map();
    static globalWorker: Worker | null = null;

    static hasGlobalWorker(): boolean {
        return this.globalWorker !== null;
    }

    static getGlobalWorker(): Worker {
        if (this.globalWorker === null) {
            throw new Error('global worker not initialized yet');
        }
        return this.globalWorker;
    }

    static registerApplication(application: BaseApplication) {
        this.applications.set(application.bundleName, application);
        application.setRegistry(this);

        // 注册Skill
        const skillRegistry = SkillRegistry.getInstance();
        application.getSkills().then(skills => skillRegistry.registerSkills(application.bundleName, ...skills));

        Setting.registerApplicationSettings(application, () => {
            application.onConfigChanged();
            this.globalWorker?.postMessage({
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
        } else if (!ApplicationRegistry.hasGlobalWorker()) {
            return { status: 'error', message: 'global worker not initialized yet' }
        }

        try {
            let promise = new Promise((resolve, reject) => {
                ApplicationRegistry.pendingRequests.set(requestId, { resolve, reject });
            });

            ApplicationRegistry.getGlobalWorker().postMessage({
                bundleName: bundleName,
                requestId: requestId,
                methodName: methodName,
                args: args,
            })

            const data = await promise;
            ApplicationRegistry.pendingRequests.delete(requestId);
            return { status: 'ok', data: data };
        } catch (error) {
            return { status: 'error', message: error.message };
        }
    }
};

/**
 * 通知 Worker 线程更新全局设置
 * @param settingData - 新的设置数据
 */
export function notifyWorkerSettingUpdate(settingData: object) {
    if (ApplicationRegistry.getGlobalWorker() === null) {
        logger.warn('global worker not initialized, cannot notify setting update');
        return;
    }
    ApplicationRegistry.getGlobalWorker().postMessage({
        bundleName: '__system',
        requestId: crypto.randomUUID(),
        methodName: '__updateGlobalSetting',
        args: [settingData],
    });
}

/**
 * 初始化应用注册表和协议处理
 * 在 app.whenReady() 之前调用，用于注册应用实例和协议 schemes
 */
export function initializeRegistry() {
    // 注册所有应用实例
    for (const APPLICATION_CLASS of getPlatform().getApplicationClasses()) {
        const appInstance = new APPLICATION_CLASS();
        if (!ApplicationRegistry.applications.has(appInstance.bundleName)) {
            ApplicationRegistry.registerApplication(appInstance);
        }
    }

    // 应用注册的时候会改变设置的Schema，所以这里需要清空一下重新载入
    Setting.clearCache();
}

/**
 * 初始化 Worker 和协议 handlers
 * 在 app.whenReady() 之后调用
 */
export function initializeRegistryWorker() {
    // 创建 Worker（需要在 app.whenReady() 之后，因为需要 app.getAppPath()）
    ApplicationRegistry.globalWorker = new Worker(
        getPlatform().getWorkerPath(),
        {
            workerData: {
                paths: { appDirectory: getAppDirectory() },
                setting: Setting.getInstance().getData()
            },
            execArgv: ['tsx']
        }
    );

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