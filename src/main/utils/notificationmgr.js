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

    static getInstance() {
        if (!NotificationManager.instance) {
            NotificationManager.instance = new NotificationManager();
        }
        return NotificationManager.instance;
    }

    addSubscriber(subscriber) {
        this.subscribers.push(subscriber);
    }

    sendNotification(type, source, title, message) {
        console.info(`sending notification`, type, source, title, message);
        for (const subscriber of this.subscribers) {
            subscriber.send('notification:notificationReceived', type, source, title, message);
        }
    }

    removeNotification(notification) {
        this.notifications = this.notifications.filter(n => n !== notification);
    }
}


export { NotificationManager };