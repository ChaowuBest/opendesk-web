const { Worker } = require('worker_threads');
const { getAppDirectory } = require('../../utils/setting');
const { logger, LogStream } = require('../../utils/logger');

const path = require('path');


class FSService {
    /** @type {Worker | null} */
    static worker = null;

    /** @type {Map<number, { resolve: Function, reject: Function }>} */
    static pendingRequests = new Map();

    /** @type {number} */
    static requestIdCounter = 0;

    /**
     * 创建并初始化 worker
     */
    static async initializeWorker() {
        if (this.worker) {
            return;
        }

        const workerPath = path.join(__dirname, 'worker.js');
        this.worker = new Worker(workerPath, {
            workerData: {
                paths: {
                    appDirectory: getAppDirectory()
                }
            }
        });

        let main_log_stream = LogStream.getStream();
        // 处理 worker 消息
        this.worker.on('message', (message) => {
            const { type, id, status, data, message: errorMessage } = message;

            // 处理来自 worker 的日志消息
            if (type === 'log') {
                main_log_stream.write(message.message + '\n');
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
            console.error('Worker error:', error);
        });

        // 处理 worker 退出
        this.worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker stopped with exit code ${code}`);
            }
            this.worker = null;
            // 清理所有待处理的请求
            this.pendingRequests.forEach(({ reject }) => {
                reject(new Error('Worker exited'));
            });
            this.pendingRequests.clear();
        });

        // 初始化 worker
        await this.sendMessage('init', {});
    }

    /**
     * 向 worker 发送消息
     * @param {string} type
     * @param {any} payload
     * @returns {Promise<any>}
     */
    static async sendMessage(type, payload) {
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

    /**
     * 启动文件系统服务
     */
    static async startFSService() {
        try {
            await this.sendMessage('startService', {});
        } catch (error) {
            console.error('Failed to start FS service:', error);
            throw error;
        }
    }

    /**
     * 停止文件系统服务
     */
    static async stopFSService() {
        try {
            if (this.worker) {
                await this.sendMessage('stopService', {});
                await this.worker.terminate();
                this.worker = null;
            }
        } catch (error) {
            console.error('Failed to stop FS service:', error);
        }
    }

    /**
     * 通过关键词搜索文件
     * @param {string} keyword
     * @returns {Promise<any>}
     */
    static async searchFilesByKeyword(keyword) {
        return await this.sendMessage('searchFilesByKeyword', { keyword });
    }

    /**
     * 通过名称相似度搜索文件
     * @param {string} query
     * @param {number} topK
     * @param {number} threshold
     * @returns {Promise<any>}
     */
    static async searchFilesByNameSimilarity(query, topK = 20, threshold = 0.5) {
        return await this.sendMessage('searchFilesByNameSimilarity', { query, topK, threshold });
    }
}

module.exports = { FSService };