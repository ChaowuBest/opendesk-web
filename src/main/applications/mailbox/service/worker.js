import { EmailHeader, EmailProfileSchema, EmailContent, EmailAttachment } from "../common.js";
import { BaseWorker } from "../../base.js";
import { logger } from '../../../utils/logger.js';
import Pop3Command from 'node-pop3';
import fs from 'fs';
import nedb from 'nedb-promises';
import path from 'path';
import pMap from 'p-map';
import { simpleParser } from "mailparser";

import pkg from 'lodash';
import { NotificationManager } from "../../../utils/notificationmgr.js";

const _ = pkg;

var mailboxDataDirectory = null;

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

    async prepareAttachments(uid, attachments) {
        if (!attachments) {
            return [];
        }

        const attachmentDirectory = path.join(mailboxDataDirectory, 'attachments', uid);
        let result = [];
        fs.mkdirSync(attachmentDirectory, { recursive: true });
        for (const attachment of attachments) {
            const attachmentPath = path.join(attachmentDirectory, attachment.filename);
            logger.info(`saving attachment: ${attachment.filename} to ${attachmentPath}`);
            fs.writeFileSync(attachmentPath, attachment.content);
            result.push(new EmailAttachment(attachment.filename, attachmentPath));
        }
        return result;
    }

    async getEmail(uid) {
        const pop3 = this.pop3();
        try {
            const uidlist = await pop3.UIDL();
            const uidmapping = new Map(uidlist.map(([index, uid]) => [uid, index]));
            const index = uidmapping.get(uid);
            if (index === undefined) {
                logger.error(`email not found: ${uid}`);
                return null;
            }
            const email = await pop3.RETR(index);
            const parsed = await simpleParser(email);

            const attachments = await this.prepareAttachments(uid, parsed.attachments);
            const content = new EmailContent(parsed.html, parsed.text, attachments);
            const header = new EmailHeader(
                uid,
                parsed.subject,
                parsed.from?.value, parsed.to?.value,
                parsed.cc?.value, parsed.bcc?.value,
                parsed.date?.getTime()
            );
            return { header, content };
        }
        catch (error) {
            logger.error(`error getting email content: ${uid}: ${error}`);
            return null;
        } finally {
            await pop3.QUIT();
        }
    }

    async getEmailContent(uid) {
        const { _, content } = await this.getEmail(uid);
        return content;
    }
}

class MailboxStorage {

    constructor(dbPath) {
        /** @type {nedb} */
        this.dbPath = dbPath;
        this.db = new nedb({ filename: dbPath });
        this.rawdb = new nedb({ filename: dbPath + '.raw' });
        this.contentdb = new nedb({ filename: dbPath + '.content' });
    }

    async initialize() {
        await this.db.load().catch(err => {
            logger.error(`error loading mailbox_header_storage.db: ${err}`);
            fs.rmSync(this.dbPath);
            this.db = new nedb({ filename: this.dbPath, autoload: true });
            NotificationManager.getInstance().error('邮箱', '收取新邮件', `邮箱数据库(db)损坏，已删除并重新创建`);
        }).finally(() => {
            this.db.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
        })
        await this.rawdb.load().catch(err => {
            logger.error(`error loading mailbox_header_storage.db.raw: ${err}`);
            fs.rmSync(this.dbPath + '.raw');
            this.rawdb = new nedb({ filename: this.dbPath + '.raw', autoload: true });
            NotificationManager.getInstance().error('邮箱', '收取新邮件', `邮箱数据库(rawdb)损坏，已删除并重新创建`);
        }).finally(() => {
            this.rawdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
        })
        await this.contentdb.load().catch(err => {
            logger.error(`error loading mailbox_header_storage.db.content: ${err}`);
            fs.rmSync(this.dbPath + '.content');
            this.contentdb = new nedb({ filename: this.dbPath + '.content', autoload: true });
            NotificationManager.getInstance().error('邮箱', '收取新邮件', `邮箱数据库(contentdb)损坏，已删除并重新创建`);
        }).finally(() => {
            this.contentdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
        })
    }

    async saveRawEmailHeader(uid, header) {
        await this.rawdb.update(
            { uid: uid },
            { $set: { uid: uid, header: header } },
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
        return new EmailContent(doc.htmlContent, doc.textContent, doc.attachments || []);
    }

    async saveEmailContent(uid, content) {
        try {
            await this.contentdb.update(
                { uid: uid },
                { $set: { uid: uid, htmlContent: content.htmlContent, textContent: content.textContent, attachments: content.attachments } },
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
                        parsed.cc?.value, parsed.bcc?.value,
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

    async saveEmailHeader(header) {
        await this.saveEmailHeaders(header);
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

    /**
     * Get the list of email headers from the database
     * @returns {Promise<EmailHeader[]>}
     */
    async getEmailHeaderList() {
        const docs = await this.db.find({}).sort({ date: -1 }).limit(100);
        return docs.map(doc => new EmailHeader(doc.uid, doc.subject, doc.from, doc.to, doc.cc, doc.bcc, doc.date));
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

        if (newList.length > 0) {
            NotificationManager.getInstance().info('邮箱', '收取新邮件', `即将从${usr}收取 ${newList.length} 封新邮件`);
        }

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
        if (this.config === undefined) {
            logger.warn('no config, skip mailbox sync');
            return;
        }

        const config = EmailProfileSchema.parse(this.config);
        if (this.isSyncing) {
            logger.info('another syncing process is running, skip');
            return;
        }

        this.isSyncing = true;
        try {
            if (config.inbox?.pop3) {
                await this.syncPOP3Inbox(
                    config.username, config.password,
                    config.inbox.pop3.tls, config.inbox.pop3.host, config.inbox.pop3.port
                );
            }
            logger.info('mailbox sync completed');
        } catch (error) {
            logger.error(`error syncing mailbox: ${error.message}`);
            NotificationManager.getInstance().error('邮箱', '收取新邮件', `收取新邮件失败: ${error.message}`);
        } finally {
            this.isSyncing = false;
        }
    }

    async trySync() {
        try {
            await this.sync();
        } catch (error) {
            logger.error(`error syncing mailbox: ${error.message}`);
        }
    }

    async syncEmails() {
        if (this.config === undefined) {
            logger.warn('no config, skip mailbox sync');
            return;
        }
        this.sync();
    }

    async startService() {
        if (this.config === undefined) {
            logger.warn('mailbox service not configured, will not start mailbox service');
            return;
        }

        await this.storage.initialize();
        setTimeout(async () => {
            await this.trySync();
            setInterval(async () => {
                await this.trySync();
            }, 1000 * 60 * 5);
        }, 1000 * 5);
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

    async reDownloadEmailContent(uid) {
        logger.info(`re-downloading email: ${uid}`);
        const config = EmailProfileSchema.parse(this.config);
        if (config.inbox?.pop3) {
            const pop3 = new POP3EmailClient(
                config.username, config.password,
                config.inbox.pop3.tls, config.inbox.pop3.host, config.inbox.pop3.port
            );
            const { header, content } = await pop3.getEmail(uid);
            await this.storage.saveEmailContent(uid, content);
            await this.storage.saveEmailHeader(header);
            return content;
        } else {
            logger.error(`no valid inbox server configured: ${this.config}`);
            throw new Error('no valid inbox server configured');
        }
    }
}

let mailboxWorker = new MailboxWorker();
mailboxDataDirectory = mailboxWorker.appDataDirectory;
mailboxWorker.initialize();