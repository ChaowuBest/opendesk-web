import { z } from 'zod';
import { Worker, parentPort, workerData } from 'worker_threads';
import { logger, LogStream } from '../utils/logger.js';
import { Setting, getAppDirectory } from '../utils/setting.js';
import { BaseTool } from '../agents/tool.js';
import { NotificationManager } from '../utils/notificationmgr.js';
import path from 'path';
import fs from 'fs';


class BaseWorker {

    constructor() {
        /** @type {object} */
        this.config = {};
        /** @type {string} */
        this.appDataDirectory = getAppDirectory();
    }

    /**
     * 初始化 worker
     */
    async initialize() {
        // 从 workerData 初始化 Setting（如果存在）
        if (workerData && workerData.settingData) {
            try {
                const settingInstance = Setting.getInstance();
                settingInstance.setData(workerData.settingData);
                logger.info('Setting data initialized from main thread in worker');
            } catch (error) {
                logger.error(`Failed to initialize setting data in worker: ${error.message}`);
            }
        }

        parentPort.on('message', async (message) => {
            try {
                const { type, id, payload } = message;
                if (typeof this[type] === "function") {
                    let result = await this[type](...payload);
                    parentPort.postMessage({ type: 'response', id: id, status: 'ok', data: result });
                } else {
                    throw new Error(`unknown message ${type}, implement this method in the worker class`);
                }
            } catch (error) {
                logger.error(`worker error: ${error.message}: message ${JSON.stringify(message)}`);
                parentPort.postMessage({ type: 'response', id: message.id, status: 'error', message: error.message });
            }
        });
    }

    async startService() {}
    async stopService() {}

    async applicationConfigChanged(config) {
        this.config = config;
    }
}

class BaseService {

    /** @type {Worker | null} */
    static worker = null;

    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    static pendingRequests = new Map();

    /** @type {number} */
    static requestIdCounter = 0;

    /** @type {string} */
    static applicationDataDirectory = getAppDirectory();

    static getWorkerPath() {
        throw new Error('worker path not implemented');
    }

    static async sendApplicationConfig(config) {
        if (!this.worker) {
            throw new Error('worker not initialized');
        }
        await this.sendMessage('applicationConfigChanged', config);
    }

    static async initializeWorker() {
        if (this.worker) {
            return;
        }

        // 获取主线程的 Setting 数据并传递给 Worker
        const settingData = Setting.getInstance().getData();

        this.worker = new Worker(
            this.getWorkerPath(),
            {
                workerData: { 
                    paths: { appDirectory: this.applicationDataDirectory },
                    settingData: settingData
                }
            }
        );

        let main_log_stream = LogStream.getStream();
        // 处理 worker 消息
        this.worker.on('message', (message) => {
            const { type, id, status, data, message: errorMessage, payload } = message;

            // 处理来自 worker 的日志消息
            if (type === 'log') {
                main_log_stream.write(message.message + '\n');
                return;
            } else if (type === 'notification') {
                const { type, source, title, message } = payload;
                NotificationManager.getInstance().sendNotification(type, source, title, message);
                return;
            }

            if (type === 'response' && id !== undefined) {
                const pending = this.pendingRequests.get(id);
                if (pending) {
                    this.pendingRequests.delete(id);
                    if (status === 'ok') {
                        pending.resolve(data);
                    } else {
                        pending.reject(new Error(errorMessage || 'Unknown error'));
                    }
                }
            }
        });

        // 处理 worker 错误
        this.worker.on('error', (error) => {
            logger.error('Worker error:', error);
        });

        // 处理 worker 退出
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                logger.error(`Worker ${this.name} stopped with exit code ${code}`);
            }
            this.worker = null;
            // 清理所有待处理的请求
            this.pendingRequests.forEach(({ reject }) => {
                reject(new Error('Worker exited'));
            });
            this.pendingRequests.clear();
        });
    }

    /**
     * 向 worker 发送消息
     * @param {string} type
     * @param {any} payload
     * @returns {Promise<any>}
     */
    static async sendMessage(type, ...payload) {
        if (!this.worker) {
            await this.initializeWorker();
        }

        const id = ++this.requestIdCounter;
        return new Promise((resolve, reject) => {
            this.pendingRequests.set(id, { resolve, reject });
            this.worker.postMessage({ type, id, payload });

            // 设置超时
            setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    reject(new Error(`Request timeout: ${type}`));
                }
            }, 30000); // 30秒超时
        });
    }

    static async startService() {
        logger.info(`starting service: ${this.name}`);
        try {
            await this.sendMessage('startService', {});
        } catch (error) {
            logger.error(`failed to start service: ${this.name}: ${error.message}`);
            throw error;
        }
    }

    static async stopService() {
        logger.info(`stopping service: ${this.name}`);
        try {
            if (this.worker) {
                await this.sendMessage('stopService', {});
                await this.worker.terminate();
                this.worker = null;
            }
        } catch (error) {
            logger.error(`failed to stop service: ${this.name}: ${error.message}`);
        }
    }
}

class BaseGUIConfig {
    /**
     * @param {string[]} javascripts
     * @param {string} entry
     */
    constructor(javascripts, entry) {
        this.javascripts = javascripts;
        this.entry = entry;
    }
}

class BaseApplication {

    constructor(bundleName) {
        /** @type {string} */
        this.bundleName = bundleName;
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

    async handleMessage(message, ...args) {
        throw new Error(`unknown message: ${message}`);
    }

    /**
     * 返回应用提供的服务
     * @returns {Array<typeof BaseService>}
     */
    getServices() {
        return [];
    }

    /**
     * 获取应用提供的工具
     * @returns {BaseTool[]}
     */
    getTools() {
        return [];
    }

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
}

class ApplicationRegistry {
    /** @type {Map<string, BaseApplication>} */
    static applications = new Map();

    /**
     *
     * @param {BaseApplication} application
     */
    static registerApplication(application) {
        logger.info(`registering application ${application.bundleName}`);
        ApplicationRegistry.applications.set(application.bundleName, application);
        Setting.registerApplicationSettings(application);
        application.getServices()?.forEach(async service => {
            service.applicationDataDirectory = await application.getDataDirectory();
            service.startService();
            service.sendApplicationConfig(application.getConfig());
        });
    }

    static getApplication(bundleName) {
        return ApplicationRegistry.applications.get(bundleName);
    }

    /**
     * @returns {Map<string, BaseTool>}
     */
    static listAvailableTools() {
        let result = new Map();
        for (let application of ApplicationRegistry.applications.values()) {
            for (let tool of application.getTools()) {
                let tool_id = `${application.bundleName}-${tool.name}`;
                result.set(tool_id, tool);
            }
        }
        return result;
    }
}

export {
    BaseApplication,
    BaseService,
    BaseWorker,
    BaseGUIConfig,
    ApplicationRegistry
};