import { BaseApplication, BaseGUIConfig } from "../base.js";
import { EmailProfileSchema } from "./common.js";
import { logger } from "../../utils/logger.js";
import path from 'path';


const __dirname = import.meta.dirname;

class MailboxApplication extends BaseApplication {

    constructor() {
        super('mailbox', '邮箱');
        /** @type {Set<import('electron').WebFrameMain>} */
        this.subscribers = new Set();
    }

    /**
     * 添加邮件更新订阅者
     * @param {import('electron').WebFrameMain} senderFrame
     * @returns {string} subscriptionId
     */
    addSubscriber(senderFrame) {
        const subscriptionId = `mailbox-${Date.now()}-${Math.random()}`;
        this.subscribers.add(senderFrame);
        return subscriptionId;
    }

    /**
     * 移除邮件更新订阅者
     * @param {import('electron').WebFrameMain} senderFrame
     */
    removeSubscriber(senderFrame) {
        this.subscribers.delete(senderFrame);
    }

    /**
     * 通知所有订阅者邮件列表已更新
     */
    notifyEmailListUpdated() {
        for (const subscriber of this.subscribers) {
            try {
                if (subscriber.isDestroyed()) {
                    this.subscribers.delete(subscriber);
                    continue;
                }
                subscriber.send('mailbox:emailListUpdated');
            } catch (error) {
                logger.error(`Failed to notify subscriber: ${error.message}`);
                this.subscribers.delete(subscriber);
            }
        }
    }

    /**
     * 处理来自 worker 的邮件列表更新通知
     */
    onEmailListUpdated() {
        this.notifyEmailListUpdated();
    }

    getConfigSchema() {
        return EmailProfileSchema;
    }

    onConfigChanged() {
        logger.info(`mailbox application config changed`);
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'mailbox-entry-widget',

        );
    }
}

export { MailboxApplication };