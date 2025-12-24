const { EmailHeader, EmailProfileSchema, EmailContent } = require("../common");
const { BaseWorker } = require("../../base");
const { logger } = require('../../../utils/logger');
const _ = require('lodash');
const Pop3Command = require('node-pop3');
const nedb = require('nedb-promises');
const path = require('path');
const pMap = require('p-map');
const { simpleParser } = require("mailparser");


class POP3EmailClient {

    constructor(usr, pwd, tls, host, port) {
        this.usr = usr;
        this.pwd = pwd;
        this.tls = tls;
        this.host = host;
        this.port = port;
    }

    pop3() {
        return new Pop3Command({ user: this.usr, password: this.pwd, host: this.host, port: this.port, tls: this.tls });
    }

    async getEmailContent(uid) {
        const pop3 = this.pop3();
        const uidlist = await pop3.UIDL();
        const uidmapping = new Map(uidlist.map(([index, uid]) => [uid, index]));
        try {
            const index = uidmapping.get(uid);
            if (index === undefined) {
                logger.error(`email not found: ${uid}`);
                return null;
            }
            const email = await pop3.RETR(index);
            const parsed = await simpleParser(email);
            return new EmailContent(parsed.html, parsed.text, parsed.attachments);
        }
        catch (error) {
            logger.error(`error getting email content: ${uid}: ${error}`);
            return null;
        } finally {
            await pop3.QUIT();
        }
    }
}

class MailboxStorage {

    constructor(dbPath) {
        /** @type {nedb} */
        this.db = new nedb({ filename: dbPath, autoload: true });
        this.db.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
        this.rawdb = new nedb({ filename: dbPath + '.raw', autoload: true });
        this.rawdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
        this.contentdb = new nedb({ filename: dbPath + '.content', autoload: true });
        this.contentdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
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

    async getEmailContent(uid) {
        const doc = await this.contentdb.findOne({ uid: uid });
        if (!doc) {
            return null;
        }
        return new EmailContent(doc.htmlContent, doc.textContent);
    }

    async saveEmailContent(uid, content) {
        try {
            await this.contentdb.update(
                { uid: uid },
                { $set: { uid: uid, htmlContent: content.htmlContent, textContent: content.textContent } },
                { upsert: true }
            )
        } catch (error) {
            logger.error(`error saving email content: ${uid}: ${error}`);
        }
    }

    async saveRawEmailHeaders(...rawHeaders) {
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
        await this.saveEmailHeaders(...headers.filter(header => header !== null));
    }

    async saveEmailHeaders(...emails) {
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

    async getEmailHeaderList() {
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
                this.storage.saveRawEmailHeaders(...pendingHeaders);
                pendingHeaders = [];
            }
        }

        if (pendingHeaders.length > 0) {
            this.storage.saveRawEmailHeaders(...pendingHeaders);
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

    async getEmailHeaderList() {
        let startTime = Date.now();
        const result = await this.storage.getEmailHeaderList();
        let cost = (Date.now() - startTime) / 1000;
        logger.info(`get email list cost: ${cost.toFixed(2)}s`);
        return result;
    }

    /**
     * Get the content of an email by its UID.
     * @param {string} uid 
     * @returns {EmailContent}
     */
    async getEmailContent(uid) {
        logger.info(`getting email content: ${uid}`);
        const cachedContent = await this.storage.getEmailContent(uid);
        if (cachedContent) {
            return cachedContent;
        }

        const config = EmailProfileSchema.parse(this.config);
        if (config.inbox?.pop3) {   
            const pop3 = new POP3EmailClient(
                config.username, config.password,
                config.inbox.pop3.tls,
                config.inbox.pop3.host,
                config.inbox.pop3.port
            );
            const result = await pop3.getEmailContent(uid);
            await this.storage.saveEmailContent(uid, result);
            return result;
        } else {
            throw new Error('no valid inbox server configured');
        }
    }

}

(new MailboxWorker()).initialize();