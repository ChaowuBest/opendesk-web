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

import { logger } from './logger.js';
import { isMainThread, parentPort } from 'worker_threads';

class NotificationManager {
    /**
     * The singleton instance of the NotificationManager
     * @type {NotificationManager | null}
     */
    static instance = null;

    constructor() {
        this.notifications = [];
        /** @type {Electron.WebContents[]} */
        this.subscribers = [];
        /**
         * CLI 模式下的通知回调列表
         * @type {Array<(type: string, source: string, title: string, message: string) => void>}
         */
        this.cliCallbacks = [];
    }

    /**
     * Get the singleton instance of the NotificationManager
     * @returns {NotificationManager}
     */
    static getInstance() {
        if (NotificationManager.instance === null) {
            logger.info('creating notification manager instance');
            NotificationManager.instance = new NotificationManager();
        }
        return NotificationManager.instance;
    }

    addSubscriber(subscriber) {
        // 空订阅者没有任何意义，存进去只会在广播时抛 "Cannot read properties of null"
        if (!subscriber) {
            logger.warn('ignoring empty notification subscriber');
            return;
        }
        // 检查订阅者是否已存在，避免重复添加
        if (this.subscribers.includes(subscriber)) {
            logger.info(`notification subscriber ${subscriber.id} already exists, skipping`);
            return;
        }
        logger.info(`adding notification subscriber: ${subscriber.id}`);
        this.subscribers.push(subscriber);
        // WebContents 销毁时即时摘除：只在 sendNotification 里做惰性清理的话，
        // 长期不发通知的场景下死引用会一直挂在数组里（并阻止 GC）
        if (typeof subscriber.once === 'function') {
            subscriber.once('destroyed', () => {
                this.removeSubscriber(subscriber);
            });
        }
    }

    /**
     * 注册 CLI 模式下的通知回调
     * @param {(type: string, source: string, title: string, message: string) => void} callback
     * @returns {() => void} 取消注册的函数
     */
    addCliCallback(callback) {
        this.cliCallbacks.push(callback);
        return () => {
            this.cliCallbacks = this.cliCallbacks.filter((cb) => cb !== callback);
        };
    }

    /**
     * 取订阅者标识用于日志。
     * destroyed 回调、以及"已销毁但还没被摘除"的路径上，读原生对象属性本身也可能抛错，
     * 日志绝不能成为新的崩溃点。
     * @param {Electron.WebContents} subscriber
     * @returns {string}
     */
    subscriberLabel(subscriber) {
        try {
            return String(subscriber?.id ?? '<unknown>');
        } catch {
            return '<unreadable>';
        }
    }

    /**
     * 移除指定订阅者
     * @param {Electron.WebContents} subscriber
     * @returns {boolean} 是否真的移除了
     */
    removeSubscriber(subscriber) {
        const index = this.subscribers.indexOf(subscriber);
        if (index === -1) return false;
        const label = this.subscriberLabel(subscriber);
        this.subscribers.splice(index, 1);
        logger.info(`notification subscriber ${label} removed`);
        return true;
    }

    /**
     * 订阅者是否已销毁。
     * 判定本身也可能抛错（对已释放的原生对象取属性），此时按"已销毁"处理——
     * 保留一个判定都会失败的订阅者没有任何意义，只会让后续每次广播都继续抛错。
     * @param {Electron.WebContents} subscriber
     * @returns {boolean}
     */
    isSubscriberDestroyed(subscriber) {
        if (typeof subscriber?.isDestroyed !== 'function') return false;
        try {
            return subscriber.isDestroyed() === true;
        } catch (err) {
            logger.warn(`failed to check notification subscriber ${this.subscriberLabel(subscriber)}: ${err}`);
            return true;
        }
    }

    /**
     * 清理已销毁的订阅者（如内置浏览器宿主窗口关闭后残留的 WebContents），
     * 防止死引用持续累积，并在后续 send 时触发 "Object has been destroyed"。
     */
    removeDestroyedSubscribers() {
        this.subscribers = this.subscribers.filter((subscriber) => !this.isSubscriberDestroyed(subscriber));
    }

    sendNotification(type, source, title, message) {
        if (!isMainThread) {
            parentPort.postMessage({
                type: 'notification',
                payload: { type, source, title, message }
            });
        } else {
            this.removeDestroyedSubscribers();
            // Electron renderer 订阅者。遍历快照，避免循环内摘除订阅者导致跳过后续元素
            for (const subscriber of [...this.subscribers]) {
                const label = this.subscriberLabel(subscriber);
                logger.info(`sending notification ${message} to subscriber: ${label}`);
                try {
                    subscriber.send('notification:notificationReceived', type, source, title, message);
                } catch (err) {
                    // 清理后、发送前被销毁：摘掉死引用即可。
                    // 其他失败（如载荷不可克隆）是真实 bug，必须按 error 级别留在日志里，
                    // 但同样不能让单个订阅者中断整轮广播
                    if (this.isSubscriberDestroyed(subscriber)) {
                        this.removeSubscriber(subscriber);
                        logger.warn(`dropped destroyed notification subscriber ${label}: ${err}`);
                    } else {
                        logger.error(`failed to send notification to subscriber ${label}: ${err}`);
                    }
                }
            }
            // CLI 模式回调
            for (const callback of this.cliCallbacks) {
                try {
                    callback(type, source, title, message);
                } catch (err) {
                    logger.error(`CLI notification callback error: ${err}`);
                }
            }
        }
    }

    info(source, title, message) {
        this.sendNotification('info', source, title, message);
    }

    error(source, title, message) {
        this.sendNotification('error', source, title, message);
    }

    warning(source, title, message) {
        this.sendNotification('warning', source, title, message);
    }

    removeNotification(notification) {
        this.notifications = this.notifications.filter((n) => n !== notification);
    }
}

export { NotificationManager };
