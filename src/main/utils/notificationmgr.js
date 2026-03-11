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
        // 检查订阅者是否已存在，避免重复添加
        if (this.subscribers.includes(subscriber)) {
            logger.info(`notification subscriber ${subscriber.id} already exists, skipping`);
            return;
        }
        logger.info(`adding notification subscriber: ${subscriber.id}`);
        this.subscribers.push(subscriber);
    }

    /**
     * 注册 CLI 模式下的通知回调
     * @param {(type: string, source: string, title: string, message: string) => void} callback
     * @returns {() => void} 取消注册的函数
     */
    addCliCallback(callback) {
        this.cliCallbacks.push(callback);
        return () => {
            this.cliCallbacks = this.cliCallbacks.filter(cb => cb !== callback);
        };
    }

    sendNotification(type, source, title, message) {
        if (!isMainThread) {
            parentPort.postMessage({ type: 'notification', payload: { type, source, title, message } });
        } else {
            // Electron renderer 订阅者
            for (const subscriber of this.subscribers) {
                logger.info(`sending notification ${message} to subscriber: ${subscriber.id}`);
                subscriber.send('notification:notificationReceived', type, source, title, message);
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
        this.notifications = this.notifications.filter(n => n !== notification);
    }
}


export { NotificationManager };