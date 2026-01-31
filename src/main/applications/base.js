import { z } from 'zod';
import { Worker, parentPort, workerData } from 'worker_threads';
import { logger, LogStream } from '../utils/logger.js';
import { Setting, getAppDirectory } from '../utils/setting.js';
import { BaseToolset } from '../agents/tool';
import { NotificationManager } from '../utils/notificationmgr.js';
import path from 'path';
import fs from 'fs';
import PQueue from 'p-queue';


class BaseWorker {

    constructor(bundleName, appDataDirectory) {
        this.bundleName = bundleName;
        /** @type {object} */
        this.config = {};
        /** @type {string} */
        this.appDataDirectory = appDataDirectory;
        /** @type {boolean} */
        this._autoListen = false;
        /** @type {PQueue} */
        this.taskQueue = new PQueue({ concurrency: 1 });
    }

    /**
     * 消息处理封装，由上级Worker统一接收消息并调用
     * @param {string} methodName
     * @param {any[]} args
     * @returns {Promise<any>}
     */
    async handleMessage(methodName, ...args) {
        if (typeof this[methodName] === "function") {
            return await this[methodName](...args);
        } else {
            throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
        }
    }

    async* handleStreamMessage(methodName, ...args) {
        if (typeof this[methodName] === "function") {
            yield* this[methodName](...args);
        } else {
            throw new Error(`unknown message ${methodName}, implement this method in the worker class`);
        }
    }

    /**
     * 初始化工作，各个应用的Worker需要自己继承并实现
     */
    async initialize() { }

    async finalize() { }

    async applicationConfigChanged(config) {
        this.config = config;
    }

    async emitEvent(eventName, ...args) {
        parentPort?.postMessage({
            type: 'subscribeEvent',
            bundleName: this.bundleName,
            eventName: eventName,
            args: args,
        });
    }

    /**
     * 顺序执行任务
     * @param {() => Promise<void>} task
     * @returns {Promise<void>}
     */
    async runSequentially(task) {
        return await this.taskQueue.add(task);
    }
}

class BaseGUIConfig {
    /**
     * @param {string[]} javascripts
     * @param {string} entry
     * @param {string | undefined} icon
     */
    constructor(javascripts, entry, icon = undefined) {
        this.javascripts = javascripts;
        this.entry = entry;
        this.icon = icon;
    }
}

class BaseApplication {

    constructor(bundleName, name = "未命名应用") {
        /** @type {string} */
        this.bundleName = bundleName;
        /** @type {string} */
        this.name = name;
        /** @type {Map<string, Set<Electron.SenderFrame>>} */
        this.eventSubscribers = new Map();
        /** @type {ApplicationRegistry | undefined} */
        this.registry = undefined;
    }

    toJSON() {
        return {
            bundleName: this.bundleName,
            name: this.name,
        };
    }

    /**
     * 添加事件订阅者
     * @param {string} eventName
     * @param {Electron.SenderFrame} senderFrame
     */
    addSubscriber(eventName, senderFrame) {
        if (!this.eventSubscribers.has(eventName)) {
            this.eventSubscribers.set(eventName, new Set());
        }
        this.eventSubscribers.get(eventName).add(senderFrame);
    }

    /**
     * 移除事件订阅者
     * @param {string} eventName
     * @param {Electron.SenderFrame} senderFrame
     */
    removeSubscriber(eventName, senderFrame) {
        if (this.eventSubscribers.has(eventName)) {
            this.eventSubscribers.get(eventName).delete(senderFrame);
        }
    }

    /**
     * 获取应用的自定义协议配置，用于在应用内安全加载资源（如 ppt://）。
     * 每个应用可返回多组配置；主进程会在启动时据此注册 scheme 与 handler。
     * @returns {Array<{ scheme: string, privileges?: import('electron').ProtocolHandlerPrivileges, handler: (request: import('electron').ProtocolRequest) => Promise<Response> | Response }>}
     */
    getProtocolHandlers() {
        return [];
    }

    /**
     * 发送事件到所有订阅者
     * @param {string} eventName
     * @param {any[]} args
     */
    sendEventToSubscribers(eventName, ...args) {
        const subscribers = this.eventSubscribers.get(eventName);
        if (!subscribers) return;

        // 使用 [...subscribers] 避免迭代时删除出错
        for (const subscriber of [...subscribers]) {
            // Electron BrowserWindow/WebContents 都有 isDestroyed 方法
            // 如果对象已经失效，则删除
            if (typeof subscriber.isDestroyed === 'function' && subscriber.isDestroyed()) {
                subscribers.delete(subscriber);
                continue;
            }
            subscriber.send(`applicationRegistry:event:${eventName}`, ...args);
        }
    }

    /**
     * 设置应用注册器
     * @param {ApplicationRegistry} registry
     */
    setRegistry(registry) {
        this.registry = registry;
    }

    /**
     * 返回应用的配置 schema，用于在设置界面中显示和编辑配置。如果不需要配置，则返回空对象。
     * @returns {z.ZodObject<any>}
     */
    getConfigSchema() {
        return z.object({});
    }

    /**
     * 获取应用的配置
     * @returns {z.output<z.ZodObject<any>>}
     */
    getConfig() {
        return Setting.getInstance().data.applications[this.bundleName];
    }

    /**
     * 配置发生变化时调用
     */
    onConfigChanged() {
        logger.info(`application ${this.bundleName} config changed`);
    }

    /**
     * 获取应用提供的工具
     * @returns {Promise<BaseToolset[]>}
     */
    async getToolsets() {
        return [];
    }

    /**
     * 获取应用的 GUI 配置
     * @returns {BaseGUIConfig | undefined}
     */
    getGUIConfig() {
        return undefined;
    }

    async getDataDirectory() {
        let data_directory = path.join(await getAppDirectory(), 'apps', this.bundleName);
        if (!fs.existsSync(data_directory)) {
            fs.mkdirSync(data_directory, { recursive: true });
        }
        return data_directory;
    }

    async callWorker(methodName, ...args) {
        if (this.registry === undefined) {
            throw new Error(`global worker not initialized`);
        }
        return await this.registry.callWorker(this.bundleName, methodName, ...args);
    }
}

export {
    BaseApplication,
    BaseWorker,
    BaseGUIConfig
};