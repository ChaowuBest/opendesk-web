const { BaseApplication, BaseGUIConfig } = require("../base");
const path = require('path');
const { MailboxService } = require("./service/service");
const { EmailProfileSchema } = require("./common");


class MailboxApplication extends BaseApplication {

    constructor() {
        super('fillipdesk.mailbox');
    }

    getConfigSchema() {
        return EmailProfileSchema;
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'renderer', 'entry.js')],
            'mailbox-entry-widget'
        );
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'getEmailList':
                return await MailboxService.getEmailList();
            case 'getEmailContent':
                return await MailboxService.getEmailContent(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }

    getServices() {
        return [MailboxService];
    }
}

module.exports = { MailboxApplication }