import { BaseService } from "../../base.js";
import path from 'path';

const __dirname = import.meta.dirname;

class MailboxService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async getEmailHeaderList() {
        return await this.sendMessage('getEmailHeaderList', {});
    }

    static async getEmailContent(uid) {
        return await this.sendMessage('getEmailContent', uid);
    }

    static async reDownloadEmail(uid) {
        return await this.sendMessage('reDownloadEmail', uid);
    }

    /**
     * 立刻触发一次邮件同步
     * @returns {Promise<void>}
     */
    static async syncEmails() {
        return await this.sendMessage('syncEmails', {});
    }
}

export { MailboxService };