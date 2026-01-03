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
        logger.info(`adding notification subscriber: ${subscriber.id}`);
        this.subscribers.push(subscriber);
    }

    sendNotification(type, source, title, message) {
        if (!isMainThread) {
            parentPort.postMessage({ type: 'notification', payload: { type, source, title, message } });
        } else {
            for (const subscriber of this.subscribers) {
                logger.info(`sending notification ${message} to subscriber: ${subscriber.id}`);
                subscriber.send('notification:notificationReceived', type, source, title, message);
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