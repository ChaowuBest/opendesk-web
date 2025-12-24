const { BaseService } = require("../../base");
const path = require('path');


class MailboxService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async getEmailList() {
        return await this.sendMessage('getEmailList', {});
    }

    static async getEmailContent(uid) {
        return await this.sendMessage('getEmailContent', uid);
    }
}

module.exports = { MailboxService };