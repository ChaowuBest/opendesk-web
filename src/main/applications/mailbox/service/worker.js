const { EmailHeader, EmailProfileSchema } = require("../common");
const { BaseWorker } = require("../../base");
const { logger } = require('../../../utils/logger');
const _ = require('lodash');
const Pop3Command = require('node-pop3');
const nedb = require('nedb-promises');
const path = require('path');
const pMap = require('p-map');
const { simpleParser } = require("mailparser");


class MailboxStorage {

    constructor(dbPath) {
        /** @type {nedb} */
        this.db = new nedb({ filename: dbPath, autoload: true });
        this.db.ensureIndex({ fieldName: 'uid', unique: true });
        this.rawdb = new nedb({ filename: dbPath + '.raw', autoload: true });
        this.rawdb.ensureIndex({ fieldName: 'uid', unique: true });
    }

    async saveRawEmailHeader(uid, header) {
        await this.rawdb.update(
            { uid: uid },
            { $set: { uid: uid,header: header } },
            { upsert: true }
        )
    }

    async getRawEmailHeader(uid) {
        const doc = await this.rawdb.findOne({ uid: uid });
        return doc?.header;
    }

    async saveEmailHeaders(...rawHeaders) {
        const headers = await pMap(
            rawHeaders,
            async ([uid, header]) => {
                const parsed = await simpleParser(header);
                try {
                    const header = new EmailHeader(
                        uid,
                        parsed.subject,
                        parsed.from?.value, parsed.to?.value,
                        parsed.date?.getTime()
                    );
                    return header;
                } catch (error) {
                    logger.error(`error parsing email header: ${uid}: ${error}`);
                    return null;
                }
            },
            { concurrency: 16 }
        );
        await this.saveEmails(...headers.filter(header => header !== null));
    }

    async saveEmails(...emails) {
        for (const email of emails) {
            try {
                await this.db.update(
                    { uid: email.uid },
                    { $set: email },
                    { upsert: true }
                )
            } catch (error) {
                logger.error(`error saving email: ${email.uid}: ${error}`);
            }
        }
    }

    async getUIDSet() {
        const docs = await this.db.find({});
        const set = new Set(docs.map(doc => doc.uid));
        return set;
    }

    async getEmailList() {
        const docs = await this.db.find({});
        return docs.map(doc => new EmailHeader(doc.uid, doc.subject, doc.from, doc.to, doc.date));
    }
}

class MailboxWorker extends BaseWorker {

    constructor() {
        super();
        this.storage = new MailboxStorage(path.join(this.appDataDirectory, 'mailbox_header_storage.db'));
        this.isSyncing = false;
    }

    async syncPOP3Inbox(usr, pwd, tls, host, port) {
        const pop3 = new Pop3Command({ user: usr, password: pwd, host: host, port: port, tls: tls });

        const allList = await pop3.UIDL();
        const uidSet = await this.storage.getUIDSet();
        const newList = allList.filter(([_, uid]) => !uidSet.has(uid)).reverse();

        var pendingHeaders = [];

        for (const [i, [index, uid]] of newList.entries()) {
            const cachedRawEmail = await this.storage.getRawEmailHeader(uid);
            if (cachedRawEmail) {
                pendingHeaders.push([uid, cachedRawEmail]);
            } else {
                const rawEmailHeader = await pop3.TOP(index, 1)
                pendingHeaders.push([uid, rawEmailHeader]);
                await this.storage.saveRawEmailHeader(uid, rawEmailHeader);
            }

            logger.info(`syncing pop3 email headers ${i} / ${newList.length} emails`);

            if (pendingHeaders.length >= 100) {
                this.storage.saveEmailHeaders(...pendingHeaders);
                pendingHeaders = [];
            }
        }

        if (pendingHeaders.length > 0) {
            this.storage.saveEmailHeaders(...pendingHeaders);
        }

        await pop3.QUIT();
    }

    async sync() {
        const config = EmailProfileSchema.parse(this.config);
        if (this.isSyncing) {
            logger.info('already syncing, skip');
            return;
        }

        this.isSyncing = true;
        if (config.inbox?.pop3) {
            await this.syncPOP3Inbox(
                config.username, config.password,
                config.inbox.pop3.tls, config.inbox.pop3.host, config.inbox.pop3.port
            );
        }
        this.isSyncing = false;
        logger.info('mailbox sync completed');
    }

    async startService() {
        this.sync();
    }

    async getEmailList() {
        let startTime = Date.now();
        const result = await this.storage.getEmailList();
        let cost = (Date.now() - startTime) / 1000;
        logger.info(`get email list cost: ${cost.toFixed(2)}s`);
        return result;
    }

    async getEmailContent(uid) {
        const config = EmailProfileSchema.parse(this.config);
        return {
            subject: 'test',
            html: 'fuckyou',
        }
    }

}

(new MailboxWorker()).initialize();