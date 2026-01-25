import { EmailHeader, EmailProfileSchema, EmailContent, EmailAttachment } from "../common.js";
import { BaseWorker } from "../../base.js";
import { logger } from '../../../utils/logger.js';
import Pop3Command from 'node-pop3';
import nodemailer from 'nodemailer';
import fs from 'fs';
import nedb from 'nedb-promises';
import path from 'path';
import pMap from 'p-map';
import { simpleParser } from "mailparser";

import pkg from 'lodash';
import { NotificationManager } from "../../../utils/notificationmgr.js";

const _ = pkg;

var mailboxDataDirectory = null;

/**
 * 为Promise添加超时机制
 * @param {Promise} promise 
 * @param {number} timeoutMs 超时时间（毫秒）
 * @param {string} operation 操作名称（用于错误信息）
 * @returns {Promise}
 */
async function withTimeout(promise, timeoutMs, operation = 'operation') {
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error(`${operation} 超时 (${timeoutMs}ms)`));
        }, timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]);
}

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

    extractFilenameFromContentDisposition(contentDisposition) {
        if (!contentDisposition) return null;

        let filenameMatch = contentDisposition.match(/filename\*=([^;]+)/i);
        if (filenameMatch) {
            // RFC 5987 格式: filename*=charset'lang'encoded-value
            const encodedValue = filenameMatch[1];
            const match = encodedValue.match(/^([^']+)'[^']*'(.+)$/);
            if (match) {
                const [, charset, encoded] = match;
                try {
                    const decoded = decodeURIComponent(encoded);
                    const buffer = Buffer.from(decoded, 'latin1');
                    const charsetMap = {
                        'gb2312': 'gbk',
                        'gb_2312': 'gbk',
                        'x-gbk': 'gbk',
                    };
                    const normalizedCharset = charsetMap[charset?.toLowerCase()] || charset?.toLowerCase() || 'utf-8';
                    try {
                        return buffer.toString(normalizedCharset);
                    } catch (e) {
                        return buffer.toString('utf-8', 'replace');
                    }
                } catch (error) {
                    logger.warn(`Failed to decode RFC 5987 filename: ${error.message}`);
                }
            }
        }

        filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
        if (filenameMatch && filenameMatch[1]) {
            let filename = filenameMatch[1].trim();
            filename = filename.replace(/^["']|["']$/g, '');
            filename = this.decodeRfc2047(filename);
            return filename || null;
        }
        return null;
    }

    getExtensionFromContentType(contentType) {
        if (!contentType) return '';

        const mimeToExt = {
            'text/plain': '.txt',
            'text/html': '.html',
            'text/css': '.css',
            'text/calendar': '.ics',
            'text/javascript': '.js',
            'application/json': '.json',
            'application/pdf': '.pdf',
            'application/zip': '.zip',
            'application/x-zip-compressed': '.zip',
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/svg+xml': '.svg',
            'application/msword': '.doc',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
            'application/vnd.ms-excel': '.xls',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
            'application/vnd.ms-powerpoint': '.ppt',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
            'message/rfc822': '.eml',
            'message/rfc822-headers': '.eml',
        };

        const mainType = contentType.split(';')[0].trim().toLowerCase();
        return mimeToExt[mainType] || '';
    }

    sanitizeFilename(filename) {
        if (!filename) return 'attachment';

        let sanitized = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
        sanitized = sanitized.replace(/^[.\s]+/, '');
        sanitized = sanitized.replace(/[.\s]+$/, '');

        if (!sanitized || sanitized.trim() === '') {
            return 'attachment';
        }

        const maxLength = 255;
        if (sanitized.length > maxLength) {
            const ext = path.extname(sanitized);
            const nameWithoutExt = path.basename(sanitized, ext);
            const truncatedName = nameWithoutExt.substring(0, maxLength - ext.length - 10) + '...';
            sanitized = truncatedName + ext;
        }

        return sanitized;
    }

    decodeRfc2047(encodedStr) {
        if (!encodedStr) return '';

        // 匹配所有 RFC 2047 编码段 =?charset?encoding?encoded-text?=
        // 支持多个编码段（主题可能被分成多段）
        const rfc2047Pattern = /=\?([^?]+)\?([BQbq])\?([^?]+)\?=/g;

        return encodedStr.replace(rfc2047Pattern, (match, charset, encoding, encoded) => {
            try {
                let decoded;
                const encodingUpper = encoding.toUpperCase();
                const charsetLower = charset.toLowerCase();

                if (encodingUpper === 'B') {
                    const buffer = Buffer.from(encoded, 'base64');
                    const charsetMap = {
                        'gb2312': 'utf-8',  // Node.js 不支持 GBK，先尝试 utf-8
                        'gb_2312': 'utf-8',
                        'x-gbk': 'utf-8',
                        'gbk': 'utf-8',
                        'gb18030': 'utf-8',
                        'windows-1252': 'latin1',
                        'iso-8859-1': 'latin1',
                        'cp936': 'utf-8',
                    };
                    const normalizedCharset = charsetMap[charsetLower] || charsetLower;

                    try {
                        if (['utf8', 'utf-8', 'utf16le', 'latin1', 'ascii'].includes(normalizedCharset)) {
                            decoded = buffer.toString(normalizedCharset);
                        } else if (charsetLower.includes('gb') || charsetLower.includes('gbk') || charsetLower.includes('gb2312')) {
                            decoded = buffer.toString('utf-8', 'replace');
                            if (decoded.includes('')) {
                                try {
                                    const utf8Str = buffer.toString('utf-8');
                                    if (!utf8Str.includes('')) {
                                        decoded = utf8Str;
                                    } else {
                                        decoded = buffer.toString('latin1');
                                    }
                                } catch (e) {
                                    decoded = buffer.toString('latin1');
                                }
                            }
                        } else {
                            try {
                                decoded = buffer.toString('utf-8');
                            } catch (e) {
                                decoded = buffer.toString('latin1');
                            }
                        }
                    } catch (e) {
                        decoded = buffer.toString('latin1');
                    }
                } else if (encodingUpper === 'Q') {
                    const bytes = [];
                    for (let i = 0; i < encoded.length; i++) {
                        if (encoded[i] === '=' && i + 2 < encoded.length) {
                            const hex = encoded.substring(i + 1, i + 3);
                            if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
                                bytes.push(parseInt(hex, 16));
                                i += 2;
                                continue;
                            }
                        }
                        if (encoded[i] === '_') {
                            bytes.push(0x20);
                        } else {
                            bytes.push(encoded.charCodeAt(i));
                        }
                    }

                    const buffer = Buffer.from(bytes);
                    const charsetMap = {
                        'gb2312': 'utf-8',
                        'gb_2312': 'utf-8',
                        'x-gbk': 'utf-8',
                        'gbk': 'utf-8',
                        'gb18030': 'utf-8',
                        'windows-1252': 'latin1',
                        'iso-8859-1': 'latin1',
                        'cp936': 'utf-8',
                    };
                    const normalizedCharset = charsetMap[charsetLower] || charsetLower;
                    try {
                        if (['utf8', 'utf-8', 'utf16le', 'latin1', 'ascii'].includes(normalizedCharset)) {
                            decoded = buffer.toString(normalizedCharset);
                        } else if (charsetLower.includes('gb') || charsetLower.includes('gbk')) {
                            decoded = buffer.toString('utf-8', 'replace');
                        } else {
                            decoded = buffer.toString('utf-8', 'replace');
                        }
                    } catch (e) {
                        decoded = buffer.toString('latin1');
                    }
                } else {
                    return match;
                }

                return decoded;
            } catch (error) {
                logger.warn(`Failed to decode RFC 2047: charset=${charset}, encoding=${encoding}, error=${error.message}`);
                return match;
            }
        });
    }

    async extractSubjectFromRfc822(content) {
        try {
            let contentBuffer;
            if (Buffer.isBuffer(content)) {
                contentBuffer = content;
            } else if (typeof content === 'string') {
                contentBuffer = Buffer.from(content, 'utf-8');
            } else {
                return null;
            }

            const parsed = await simpleParser(contentBuffer);
            if (parsed.subject) {
                return parsed.subject;
            }

            const contentStr = contentBuffer.toString('utf-8', 'replace');
            const subjectMatch = contentStr.match(/^Subject:\s*((?:.|\r?\n(?:\s|\t).*)*)/im);
            if (subjectMatch && subjectMatch[1]) {
                let subject = subjectMatch[1]
                    .replace(/\r?\n[\s\t]+/g, ' ')
                    .trim();
                subject = this.decodeRfc2047(subject);
                return subject || null;
            }
        } catch (error) {
            logger.warn(`Failed to extract subject from RFC822 attachment: ${error.message}`);
            // 如果解析失败，尝试简单的字符串提取作为备用
            try {
                const contentStr = Buffer.isBuffer(content)
                    ? content.toString('utf-8', 'replace')
                    : String(content);
                const subjectMatch = contentStr.match(/^Subject:\s*((?:.|\r?\n(?:\s|\t).*)*)/im);
                if (subjectMatch && subjectMatch[1]) {
                    let subject = subjectMatch[1]
                        .replace(/\r?\n[\s\t]+/g, ' ')
                        .trim();
                    subject = this.decodeRfc2047(subject);
                    return subject || null;
                }
            } catch (fallbackError) {
                logger.warn(`Fallback extraction also failed: ${fallbackError.message}`);
            }
        }
        return null;
    }

    async generateDefaultFilename(attachment, index) {
        const timestamp = Date.now();
        const contentType = attachment.contentType || '';
        const mainType = contentType.split(';')[0].trim().toLowerCase();
        const ext = this.getExtensionFromContentType(contentType);

        if (mainType === 'message/rfc822' && attachment.content) {
            const subject = await this.extractSubjectFromRfc822(attachment.content);
            if (subject) {
                const subjectFilename = this.sanitizeFilename(subject);
                if (subjectFilename && subjectFilename !== 'attachment') {
                    const finalExt = ext || '.eml';
                    const nameWithoutExt = path.basename(subjectFilename, path.extname(subjectFilename));
                    return `${nameWithoutExt}${finalExt}`;
                }
            }
        }

        if (attachment.contentId) {
            const contentIdName = this.sanitizeFilename(attachment.contentId.replace(/[<>]/g, ''));
            if (contentIdName && contentIdName !== 'attachment') {
                return contentIdName + ext;
            }
        }

        return `attachment_${index}_${timestamp}${ext}`;
    }

    async prepareAttachments(uid, attachments) {
        if (!attachments || attachments.length === 0) {
            return [];
        }

        const attachmentDirectory = path.join(mailboxDataDirectory, 'attachments', uid);
        let result = [];
        fs.mkdirSync(attachmentDirectory, { recursive: true });

        for (let i = 0; i < attachments.length; i++) {
            const attachment = attachments[i];
            let filename = attachment.filename;

            // 如果 filename 为 undefined 或空，尝试从其他地方获取
            if (!filename) {
                if (attachment.contentDisposition) {
                    filename = this.extractFilenameFromContentDisposition(attachment.contentDisposition);
                }

                if (!filename && attachment.contentId) {
                    filename = attachment.contentId.replace(/[<>]/g, '');
                }

                if (!filename) {
                    filename = await this.generateDefaultFilename(attachment, i);
                    logger.warn(`附件 ${i} 没有文件名，使用默认名称: ${filename}`);
                }
            }

            const contentType = attachment.contentType || '';
            const mainType = contentType.split(';')[0].trim().toLowerCase();
            if (mainType === 'message/rfc822' || mainType === 'message/rfc822-headers') {
                const currentExt = path.extname(filename).toLowerCase();
                if (currentExt !== '.eml') {
                    const nameWithoutExt = path.basename(filename, currentExt);
                    filename = `${nameWithoutExt}.eml`;
                }
            }

            filename = this.sanitizeFilename(filename);
            let finalFilename = filename;
            let counter = 1;
            const baseName = path.basename(filename, path.extname(filename));
            const ext = path.extname(filename);
            while (fs.existsSync(path.join(attachmentDirectory, finalFilename))) {
                finalFilename = `${baseName}_${counter}${ext}`;
                counter++;
            }

            try {
                const attachmentPath = path.join(attachmentDirectory, finalFilename);
                fs.writeFileSync(attachmentPath, attachment.content);
                result.push(new EmailAttachment(finalFilename, attachmentPath));
            } catch (error) {
                logger.error(`保存附件失败: ${finalFilename}: ${error.message}`);
            }
        }

        return result;
    }

    async getEmail(uid) {
        const pop3 = this.pop3();
        const operationTimeout = 60000; // 单个操作超时60秒（获取完整邮件可能需要更长时间）
        try {
            // 为UIDL操作添加超时
            const uidlist = await withTimeout(
                pop3.UIDL(),
                operationTimeout,
                `UIDL(${uid})`
            );
            const uidmapping = new Map(uidlist.map(([index, uid]) => [uid, index]));
            const index = uidmapping.get(uid);
            if (index === undefined) {
                logger.error(`email not found: ${uid}`);
                return null;
            }
            // 为RETR操作添加超时
            const email = await withTimeout(
                pop3.RETR(index),
                operationTimeout,
                `RETR(${index}, ${uid})`
            );
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
            // 处理 AggregateError，记录所有错误信息
            if (error instanceof AggregateError) {
                const errorMessages = error.errors?.map(err => err.message || String(err)).join('; ') || error.message;
                logger.error(`error getting email content: ${uid}: AggregateError - ${errorMessages}`);
                if (error.errors && error.errors.length > 0) {
                    error.errors.forEach((err, idx) => {
                        logger.error(`  error ${idx + 1}: ${err.message || String(err)}`);
                    });
                }
            } else {
                logger.error(`error getting email content: ${uid}: ${error.message || String(error)}`);
                if (error.stack) {
                    logger.error(`  stack: ${error.stack}`);
                }
            }
            return null;
        } finally {
            try {
                // 为QUIT操作添加较短的超时
                await withTimeout(
                    pop3.QUIT(),
                    5000,
                    `QUIT(${uid})`
                );
            } catch (quitError) {
                // 忽略 QUIT 操作的错误，避免掩盖原始错误
                logger.warn(`error during POP3 QUIT for ${uid}: ${quitError.message || String(quitError)}`);
            }
        }
    }

    async getEmailContent(uid) {
        const emailResult = await this.getEmail(uid);
        if (!emailResult) {
            logger.error(`failed to get email content: ${uid}, getEmail returned null`);
            return null;
        }
        const { _, content } = emailResult;
        return content;
    }
}

class SmtpEmailClient {
    constructor(account, user, pass, fromName, host, port, secure) {
        this.account = account;
        this.user = user;
        this.pass = pass;
        this.fromName = fromName;
        this.host = host;
        this.port = port;
        this.secure = secure;
    }

    async sendMail(to, cc, bcc, subject, text, html, attachments) {
        const transport = nodemailer.createTransport({
            host: this.host,
            port: this.port,
            secure: this.secure,
            auth: {
                user: this.user,
                pass: this.pass
            },
            tls: {
                rejectUnauthorized: false
            }
        })

        const mailOptions = {
            from: `"${this.fromName}" <${this.account}>`,
            to: Array.isArray(to) ? to.join(', ') : to,
            cc: Array.isArray(cc) ? cc.join(', ') : cc,
            bcc: Array.isArray(bcc) ? bcc.join(', ') : bcc,
            subject: subject,
            text: text,
            html: html,
            attachments: attachments
        };
        try {
            await transport.sendMail(mailOptions);
            NotificationManager.getInstance().info('邮箱', '发送成功', '邮件发送成功')
            return true;
        } catch (error) {
            NotificationManager.getInstance().error(error, '邮箱', '发送失败', '邮件发送失败')
            return false;
        }
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

    async markEmailAsUnread(uid) {
        logger.info(`marking email as unread: ${uid}`);
        await this.db.update(
            { uid: uid },
            { $set: { unread: true } }
        )
    }

    async deleteEmail(uid) {
        logger.info(`deleting email: ${uid}`);
        await this.db.update(
            { uid: uid },
            { $set: { deleted: true } }
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
     * @param {number} offset - The offset to start from
     * @param {number} pageSize - The page size of emails to return
     * @returns {Promise<EmailHeader[]>}
     */

    async getEmailHeaderList(offset = 0, pageSize = 20) {
        const docs = await this.db.find({deleted: { $ne: true }}).sort({ date: -1 }).skip(offset).limit(pageSize);
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

        // Unread filter
        if (query.unread !== undefined) {
            dbQuery.unread = query.unread;
        }

        // Starred filter
        if (query.starred !== undefined) {
            dbQuery.starred = query.starred;
        }

        // Always exclude deleted emails
        dbQuery.deleted = { $ne: true };

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

        // Apply limit and offset for pagination (after all filtering)
        if (query.offset !== undefined) {
            docs = docs.slice(query.offset);
        }
        if (query.limit !== undefined) {
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
        super('mailbox', appDataDirectory);
        mailboxDataDirectory = appDataDirectory;
        this.storage = new MailboxStorage(path.join(appDataDirectory, 'mailbox_header_storage.db'));
        this.isSyncing = false;
    }

    async syncPOP3Inbox(usr, pwd, tls, host, port) {
        const maxRetries = 3;
        const operationTimeout = 30000; // 单个操作超时30秒
        const overallTimeout = 300000; // 整体超时5分钟
        let lastError = null;
        
        // 为整个同步过程添加超时
        const syncPromise = (async () => {
            // 重试机制：对于网络错误、超时等概率性问题进行重试
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                let pop3 = null;
                try {
                    pop3 = new Pop3Command({ user: usr, password: pwd, host: host, port: port, tls: tls });

                    // 为UIDL操作添加超时
                    const allList = await withTimeout(
                        pop3.UIDL(),
                        operationTimeout,
                        'UIDL'
                    );
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
                            try {
                                // 为TOP操作添加超时
                                const rawEmailHeader = await withTimeout(
                                    pop3.TOP(index, 1),
                                    operationTimeout,
                                    `TOP(${index})`
                                );
                                pendingHeaders.push([uid, rawEmailHeader]);
                                await this.storage.saveRawEmailHeader(uid, rawEmailHeader);
                            } catch (topError) {
                                // 单个邮件头获取失败，记录错误但继续处理其他邮件
                                logger.warn(`failed to get email header for ${uid}, index ${index}: ${topError.message}`);
                                // 如果是超时或网络错误，且重试次数未用完，则重新抛出以触发外层重试
                                if (attempt < maxRetries - 1 && this.isRetryableError(topError)) {
                                    throw topError;
                                }
                                // 否则跳过这封邮件，继续处理下一封
                                continue;
                            }
                        }

                        // 每处理10封邮件记录一次进度
                        if ((i + 1) % 10 === 0 || i + 1 === newList.length) {
                            logger.info(`syncing pop3 email headers ${i + 1} / ${newList.length} emails`);
                        }

                        if (pendingHeaders.length >= 100) {
                            this.storage.saveRawEmailHeaders(...pendingHeaders);
                            pendingHeaders = [];
                        }
                    }

                    if (pendingHeaders.length > 0) {
                        this.storage.saveRawEmailHeaders(...pendingHeaders);
                    }

                    // 尝试关闭连接，但不让QUIT的错误影响整体结果
                    try {
                        await withTimeout(
                            pop3.QUIT(),
                            operationTimeout,
                            'QUIT'
                        );
                    } catch (quitError) {
                        logger.warn(`error during POP3 QUIT: ${quitError.message}`);
                        // QUIT失败不影响同步结果，忽略错误
                    }
                    
                    return newList.length;
                } catch (error) {
                    lastError = error;
                    // 判断是否应该重试
                    const shouldRetry = attempt < maxRetries - 1 && this.isRetryableError(error);
                    
                    if (shouldRetry) {
                        const delay = (attempt + 1) * 1000; // 递增延迟：1s, 2s
                        logger.warn(`retrying syncPOP3Inbox, attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms, error: ${error.message}`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        // 不应该重试或已达到最大重试次数
                        break;
                    }
                } finally {
                    // 确保在出错时也尝试关闭连接
                    if (pop3) {
                        try {
                            await withTimeout(
                                pop3.QUIT(),
                                5000, // QUIT操作使用较短的超时
                                'QUIT(cleanup)'
                            );
                        } catch (quitError) {
                            // 忽略QUIT错误
                        }
                    }
                }
            }
            
            // 所有重试都失败了
            logger.error(`failed to sync POP3 inbox after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`);
            throw lastError || new Error('同步邮件失败');
        })();

        // 为整个同步过程添加超时
        try {
            return await withTimeout(
                syncPromise,
                overallTimeout,
                'syncPOP3Inbox'
            );
        } catch (error) {
            if (error.message?.includes('超时')) {
                logger.error(`syncPOP3Inbox overall timeout after ${overallTimeout}ms`);
                throw new Error(`同步邮件超时，请检查网络连接或稍后重试`);
            }
            throw error;
        }
    }

    /**
     * 判断错误是否应该重试
     * @param {Error} error 
     * @returns {boolean}
     */
    isRetryableError(error) {
        if (!error) return false;
        
        const errorMessage = error.message?.toLowerCase() || String(error).toLowerCase();
        const retryablePatterns = [
            'timeout',
            'econnreset',
            'etimedout',
            'enotfound',
            'econnrefused',
            'network',
            '连接',
            '网络',
            '超时',
            'aggregateerror'
        ];
        
        return retryablePatterns.some(pattern => errorMessage.includes(pattern));
    }

    notifyEmailListUpdated() {
        this.emitEvent('emailListUpdated');
    }

    async sync() {
        let newEmailCount = 0;
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
                newEmailCount = await this.syncPOP3Inbox(
                    config.username, config.password,
                    config.inbox.pop3.tls, config.inbox.pop3.host, config.inbox.pop3.port
                );
            }
            logger.info('mailbox sync completed');
            if (newEmailCount > 0) {
                this.notifyEmailListUpdated(newEmailCount);
            }
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

    async getEmailHeaderList(offset = 0, pageSize = 20) {
        let startTime = Date.now();
        const result = await this.storage.getEmailHeaderList(offset, pageSize);
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


    async markEmailAsUnread(uid) {
        await this.storage.markEmailAsUnread(uid);
    }

    async deleteEmail(uid) {
        await this.storage.deleteEmail(uid);
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
            // 重试机制：对于概率性错误（如网络问题、超时等）进行重试
            const maxRetries = 2;
            let lastError = null;
            
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const pop3 = new POP3EmailClient(
                        config.username, config.password,
                        config.inbox.pop3.tls,
                        config.inbox.pop3.host,
                        config.inbox.pop3.port
                    );
                    // 为获取邮件内容添加整体超时（2分钟）
                    const result = await withTimeout(
                        pop3.getEmailContent(uid),
                        120000,
                        `getEmailContent(${uid})`
                    );
                    if (!result) {
                        // 如果返回 null，可能是邮件不存在，不重试
                        if (attempt === 0) {
                            logger.error(`failed to get email content from POP3 server: ${uid}`);
                        }
                        throw new Error(`无法获取邮件内容: ${uid}`);
                    }
                    await this.storage.saveEmailContent(uid, result);
                    return result;
                } catch (error) {
                    lastError = error;
                    // 判断是否应该重试：网络错误、超时错误、AggregateError 等
                    const shouldRetry = attempt < maxRetries && (
                        error instanceof AggregateError ||
                        error.message?.includes('timeout') ||
                        error.message?.includes('ECONNRESET') ||
                        error.message?.includes('ETIMEDOUT') ||
                        error.message?.includes('ENOTFOUND') ||
                        error.message?.includes('网络') ||
                        error.message?.includes('连接')
                    );
                    
                    if (shouldRetry) {
                        const delay = (attempt + 1) * 1000; // 递增延迟：1s, 2s
                        logger.warn(`retrying getEmailContent for ${uid}, attempt ${attempt + 1}/${maxRetries + 1}, delay ${delay}ms`);
                        await new Promise(resolve => setTimeout(resolve, delay));
                    } else {
                        // 不应该重试或已达到最大重试次数
                        break;
                    }
                }
            }
            
            // 所有重试都失败了
            logger.error(`failed to get email content from POP3 server after ${maxRetries + 1} attempts: ${uid}`);
            throw lastError || new Error(`无法获取邮件内容: ${uid}`);
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

    async sendEmail(sendEmailSchema) {
        logger.info(`sendEmail to ${sendEmailSchema.to}`)
        const config = EmailProfileSchema.parse(this.config);
        if (config.outbox?.smtp) {
            const smtp = new SmtpEmailClient(config.outbox.smtp.account? config.outbox.smtp.account : config.username,
                config.username, config.password, config.name,
                config.outbox.smtp.host, config.outbox.smtp.port, config.outbox.smtp.tls
            );
            return await smtp.sendMail(sendEmailSchema.to , sendEmailSchema.cc, sendEmailSchema.bcc,
                sendEmailSchema.subject, sendEmailSchema.text, sendEmailSchema.html, sendEmailSchema.attachments);
        } else {
            logger.error(`no valid outbox server configured: ${this.config}`);
            throw new Error('no valid outbox server configured');
        }
    }
}

export default MailboxWorker;
