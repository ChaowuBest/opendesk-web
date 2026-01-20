import { EmailHeader, EmailProfileSchema, EmailContent, EmailAttachment } from "../common.js";
import { BaseWorker } from "../../base.js";
import { logger } from '../../../utils/logger.js';
import Pop3Command from 'node-pop3';
import fs from 'fs';
import nedb from 'nedb-promises';
import path from 'path';
import pMap from 'p-map';
import { simpleParser } from "mailparser";
import { parentPort } from 'worker_threads';

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
        if (!attachments || attachments.length === 0) {
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

    async markEmailAsRead(uid) {
        logger.info(`marking email as read: ${uid}`);
        await this.db.update(
            { uid: uid },
            { $set: { unread: false } }
        )
    }

    async getEmailContent(uid) {
        const doc = await this.contentdb.findOne({ uid: uid });
        if (!doc) {
            return null;
        }
        return new EmailContent(doc.htmlContent, doc.textContent, doc.attachments || []);
    }

    async starEmail(uid, starred) {
        logger.info(`starring email: ${uid}: ${starred}`);
        await this.db.update(
            { uid: uid },
            { $set: { starred: starred } }
        )
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
        return docs.map(doc => new EmailHeader(
            doc.uid, doc.subject,
            doc.from, doc.to, doc.cc, doc.bcc,
            doc.date, doc.unread, doc.starred
        ));
    }

    /**
     * Search emails by various criteria
     * @param {import('../common.js').EmailHeaderQuerySchema & {general?: string}} query
     * @returns {Promise<EmailHeader[]>}
     */
    async searchEmails(query) {
        // Build the query object for NeDB
        const dbQuery = {};
        const orConditions = [];

        // General search (search in subject, body, or from)
        if (query.general) {
            const generalRegex = new RegExp(query.general, 'i');
            const matchingUids = new Set();
            
            // 1. Find emails matching subject
            const subjectDocs = await this.db.find({
                subject: { $regex: generalRegex }
            });
            for (const doc of subjectDocs) {
                matchingUids.add(doc.uid);
            }
            
            // 2. Find emails matching from (sender)
            const fromDocs = await this.db.find({
                $or: [
                    { 'from.address': { $regex: generalRegex } },
                    { 'from.name': { $regex: generalRegex } }
                ]
            });
            for (const doc of fromDocs) {
                matchingUids.add(doc.uid);
            }
            
            // 3. Find emails matching body content
            const bodyRegex = new RegExp(query.general, 'i');
            const contentDocs = await this.contentdb.find({
                $or: [
                    { htmlContent: { $regex: bodyRegex } },
                    { textContent: { $regex: bodyRegex } }
                ]
            });
            for (const contentDoc of contentDocs) {
                matchingUids.add(contentDoc.uid);
            }
            
            // Query headers for matching UIDs (OR relationship: subject OR from OR body)
            if (matchingUids.size > 0) {
                dbQuery.uid = { $in: Array.from(matchingUids) };
            } else {
                // No matches, return empty result
                return [];
            }
        } else {
            // Subject search (case-insensitive regex)
            if (query.subject) {
                dbQuery.subject = { $regex: new RegExp(query.subject, 'i') };
            }

            // From search (search in from array)
            if (query.from) {
                orConditions.push({
                    'from.address': { $regex: new RegExp(query.from, 'i') }
                });
                orConditions.push({
                    'from.name': { $regex: new RegExp(query.from, 'i') }
                });
            }

            // To search (search in to array)
            if (query.to) {
                orConditions.push({
                    'to.address': { $regex: new RegExp(query.to, 'i') }
                });
                orConditions.push({
                    'to.name': { $regex: new RegExp(query.to, 'i') }
                });
            }

            // If we have or conditions, add them to the query
            if (orConditions.length > 0) {
                dbQuery.$or = orConditions;
            }
        }

        // Date range search
        if (query.startDate || query.endDate) {
            dbQuery.date = dbQuery.date || {};
            if (query.startDate) {
                const startDate = new Date(query.startDate);
                startDate.setHours(0, 0, 0, 0);
                dbQuery.date.$gte = startDate.getTime();
            }
            if (query.endDate) {
                const endDate = new Date(query.endDate);
                endDate.setHours(23, 59, 59, 999);
                dbQuery.date.$lte = endDate.getTime();
            }
        }

        // Execute the query
        let docs = await this.db.find(dbQuery).sort({ date: -1 });
        
        // If body search is requested (and not general search), filter by content
        if (query.body && !query.general) {
            const bodyRegex = new RegExp(query.body, 'i');
            const matchingUids = new Set();
            
            // Search in content database
            const contentDocs = await this.contentdb.find({
                $or: [
                    { htmlContent: { $regex: bodyRegex } },
                    { textContent: { $regex: bodyRegex } }
                ]
            });
            
            for (const contentDoc of contentDocs) {
                matchingUids.add(contentDoc.uid);
            }
            
            // Filter headers by matching UIDs
            docs = docs.filter(doc => matchingUids.has(doc.uid));
        }

        // Apply limit and offset
        if (query.offset) {
            docs = docs.slice(query.offset);
        }
        if (query.limit) {
            docs = docs.slice(0, query.limit);
        }

        return docs.map(doc => new EmailHeader(
            doc.uid, doc.subject,
            doc.from, doc.to, doc.cc, doc.bcc,
            doc.date, doc.unread, doc.starred
        ));
    }
}

class MailboxWorker extends BaseWorker {

    constructor(appDataDirectory) {
        super(appDataDirectory);
        mailboxDataDirectory = appDataDirectory;
        this.storage = new MailboxStorage(path.join(appDataDirectory, 'mailbox_header_storage.db'));
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
        
        // 如果有新邮件，在所有邮件保存完成后发送更新通知
        if (newList.length > 0) {
            if (typeof parentPort !== 'undefined' && parentPort) {
                parentPort.postMessage({ 
                    type: 'emailListUpdated',
                    bundleName: 'mailbox'
                });
            } else {
                logger.warn('parentPort 未定义，无法发送邮件列表更新消息');
            }
        }
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

    async initialize() {
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

    async applicationConfigChanged(config) {
        super.applicationConfigChanged(config);
        await this.sync();
    }

    async getEmailHeaderList() {
        let startTime = Date.now();
        const result = await this.storage.getEmailHeaderList();
        let cost = (Date.now() - startTime) / 1000;
        logger.info(`get email list cost: ${cost.toFixed(2)}s`);
        return result;
    }

    async searchEmails(query) {
        let startTime = Date.now();
        const result = await this.storage.searchEmails(query);
        let cost = (Date.now() - startTime) / 1000;
        logger.info(`search emails cost: ${cost.toFixed(2)}s, found ${result.length} results`);
        return result;
    }

    async markEmailAsRead(uid) {
        await this.storage.markEmailAsRead(uid);
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

    async starEmail(starOptions) {
        await this.storage.starEmail(starOptions.uid, starOptions.starred);
    }
}

export default MailboxWorker;
