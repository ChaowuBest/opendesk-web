/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { EmailHeader, EmailProfileSchema, MailboxConfigSchema, EmailContent, EmailAttachment } from '../common.js';
import { BaseWorker } from '../../base';
import { logger } from '../../../utils/logger.js';
import { NotificationManager } from '../../../utils/notificationmgr.js';
import {
    saveAttachmentFile as copyAttachmentFile,
    saveAllAttachmentFiles as copyAllAttachmentFiles
} from './attachment-files.js';

import Pop3Command from 'node-pop3';
import Imap from 'node-imap';
import nodemailer from 'nodemailer';
import fs from 'fs';
import nedb from 'nedb-promises';
import path from 'path';
import pMap from 'p-map';
import { simpleParser } from 'mailparser';

const mailboxDataDirectory = null;

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

class EmailContentHelper {
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
                        gb2312: 'gbk',
                        gb_2312: 'gbk',
                        'x-gbk': 'gbk'
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
            'message/rfc822-headers': '.eml'
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
                        gb2312: 'utf-8', // Node.js 不支持 GBK，先尝试 utf-8
                        gb_2312: 'utf-8',
                        'x-gbk': 'utf-8',
                        gbk: 'utf-8',
                        gb18030: 'utf-8',
                        'windows-1252': 'latin1',
                        'iso-8859-1': 'latin1',
                        cp936: 'utf-8'
                    };
                    const normalizedCharset = charsetMap[charsetLower] || charsetLower;

                    try {
                        if (['utf8', 'utf-8', 'utf16le', 'latin1', 'ascii'].includes(normalizedCharset)) {
                            decoded = buffer.toString(normalizedCharset);
                        } else if (
                            charsetLower.includes('gb') ||
                            charsetLower.includes('gbk') ||
                            charsetLower.includes('gb2312')
                        ) {
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
                        gb2312: 'utf-8',
                        gb_2312: 'utf-8',
                        'x-gbk': 'utf-8',
                        gbk: 'utf-8',
                        gb18030: 'utf-8',
                        'windows-1252': 'latin1',
                        'iso-8859-1': 'latin1',
                        cp936: 'utf-8'
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
                logger.warn(
                    `Failed to decode RFC 2047: charset=${charset}, encoding=${encoding}, error=${error.message}`
                );
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
                let subject = subjectMatch[1].replace(/\r?\n[\s\t]+/g, ' ').trim();
                subject = this.decodeRfc2047(subject);
                return subject || null;
            }
        } catch (error) {
            logger.warn(`Failed to extract subject from RFC822 attachment: ${error.message}`);
            // 如果解析失败，尝试简单的字符串提取作为备用
            try {
                const contentStr = Buffer.isBuffer(content) ? content.toString('utf-8', 'replace') : String(content);
                const subjectMatch = contentStr.match(/^Subject:\s*((?:.|\r?\n(?:\s|\t).*)*)/im);
                if (subjectMatch && subjectMatch[1]) {
                    let subject = subjectMatch[1].replace(/\r?\n[\s\t]+/g, ' ').trim();
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

    async prepareAttachments(uid, attachments, attachmentDirectory) {
        if (!attachments || attachments.length === 0) {
            return [];
        }

        const emailAttachmentDir = path.join(attachmentDirectory, uid);
        const result = [];
        if (!fs.existsSync(emailAttachmentDir)) {
            fs.mkdirSync(emailAttachmentDir, { recursive: true });
        }

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
            while (fs.existsSync(path.join(emailAttachmentDir, finalFilename))) {
                finalFilename = `${baseName}_${counter}${ext}`;
                counter++;
            }

            try {
                const attachmentPath = path.join(emailAttachmentDir, finalFilename);
                fs.writeFileSync(attachmentPath, attachment.content);
                result.push(new EmailAttachment(finalFilename, attachmentPath));
            } catch (error) {
                logger.error(`保存附件失败: ${finalFilename}: ${error.message}`);
            }
        }

        return result;
    }
}

class POP3EmailClient extends EmailContentHelper {
    constructor(usr, pwd, tls, host, port) {
        super();
        this.usr = usr;
        this.pwd = pwd;
        this.tls = tls;
        this.host = host;
        this.port = port;
    }

    pop3() {
        return new Pop3Command({
            user: this.usr,
            password: this.pwd,
            host: this.host,
            port: this.port,
            tls: this.tls
        });
    }

    async getEmail(uid, attachmentDirectory) {
        const pop3 = this.pop3();
        const operationTimeout = 60000; // 单个操作超时60秒（获取完整邮件可能需要更长时间）
        try {
            // 为UIDL操作添加超时
            const uidlist = await withTimeout(pop3.UIDL(), operationTimeout, `UIDL(${uid})`);
            const uidmapping = new Map(uidlist.map(([index, uid]) => [uid, index]));
            const index = uidmapping.get(uid);
            if (index === undefined) {
                logger.error(`email not found: ${uid}`);
                return null;
            }
            // 为RETR操作添加超时
            const email = await withTimeout(pop3.RETR(index), operationTimeout, `RETR(${index}, ${uid})`);
            const parsed = await simpleParser(email);

            const attachments = await this.prepareAttachments(uid, parsed.attachments, attachmentDirectory);
            const content = new EmailContent(parsed.html, parsed.text, attachments);
            const header = new EmailHeader(
                uid,
                parsed.subject,
                parsed.from?.value,
                parsed.to?.value,
                parsed.cc?.value,
                parsed.bcc?.value,
                parsed.date?.getTime()
            );
            header.protocol = 'pop3';
            return { header, content };
        } catch (error) {
            // 处理 AggregateError，记录所有错误信息
            if (error instanceof AggregateError) {
                const errorMessages =
                    error.errors?.map((err) => err.message || String(err)).join('; ') || error.message;
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
                await withTimeout(pop3.QUIT(), 5000, `QUIT(${uid})`);
            } catch (quitError) {
                // 忽略 QUIT 操作的错误，避免掩盖原始错误
                logger.warn(`error during POP3 QUIT for ${uid}: ${quitError.message || String(quitError)}`);
            }
        }
    }

    async getEmailContent(uid, attachmentDirectory) {
        const emailResult = await this.getEmail(uid, attachmentDirectory);
        if (!emailResult) {
            logger.error(`failed to get email content: ${uid}, getEmail returned null`);
            return null;
        }
        const { _, content } = emailResult;
        return content;
    }
}

class IMAPEmailClient extends EmailContentHelper {
    constructor(usr, pwd, tls, host, port) {
        super();
        this.usr = usr;
        this.pwd = pwd;
        this.tls = tls;
        this.host = host;
        this.port = port;
    }

    static encodeMailboxName(mailbox) {
        if (!mailbox) return '';
        const base64 = Buffer.from(mailbox, 'utf-8').toString('base64');
        return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    static buildLocalUid(mailbox, imapUid) {
        const encoded = IMAPEmailClient.encodeMailboxName(mailbox);
        return `imap_${encoded}_${imapUid}`;
    }

    static ensureHeaderTerminated(rawHeader) {
        if (!rawHeader) return '';
        if (rawHeader.includes('\r\n\r\n')) {
            return rawHeader;
        }
        return `${rawHeader}\r\n\r\n`;
    }

    static getOneMonthAgoDateStr() {
        const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const now = new Date();
        const targetMonth = now.getMonth() - 1;
        const targetYear = now.getFullYear() + (targetMonth < 0 ? -1 : 0);
        const adjustedMonth = ((targetMonth % 12) + 12) % 12;
        const maxDay = new Date(targetYear, adjustedMonth + 1, 0).getDate();
        const day = Math.min(now.getDate(), maxDay);
        return `${String(day).padStart(2, '0')}-${MONTH_NAMES[adjustedMonth]}-${targetYear}`;
    }

    static flattenBoxes(boxes, prefix = '') {
        const result = [];
        if (!boxes) return result;
        for (const [name, box] of Object.entries(boxes)) {
            const delimiter = box.delimiter || '/';
            const path = prefix ? `${prefix}${delimiter}${name}` : name;
            result.push({ path, attribs: box.attribs || [] });
            if (box.children) {
                result.push(...IMAPEmailClient.flattenBoxes(box.children, path));
            }
        }
        return result;
    }

    static findBoxByAttrib(flatBoxes, attrib) {
        if (!flatBoxes || flatBoxes.length === 0) return null;
        const match = flatBoxes.find((box) => box.attribs?.some((a) => a.toLowerCase() === attrib.toLowerCase()));
        return match?.path || null;
    }

    static findBoxByName(flatBoxes, keywords) {
        if (!flatBoxes || flatBoxes.length === 0) return null;
        const lowered = flatBoxes.map((box) => ({ path: box.path, name: box.path.toLowerCase() }));
        for (const keyword of keywords) {
            const match = lowered.find((box) => box.name.includes(keyword));
            if (match) return match.path;
        }
        return null;
    }

    static buildImapIdInfo(host) {
        return {
            name: 'OpenDesk',
            version: '0.3.3',
            vendor: 'OpenDesk',
            'support-email': 'support@opendesk.local'
        };
    }

    static async buildRawEmailMessage(mailOptions) {
        const transport = nodemailer.createTransport({
            streamTransport: true,
            buffer: true,
            newline: 'unix'
        });
        const info = await transport.sendMail(mailOptions);
        if (Buffer.isBuffer(info.message)) {
            return info.message;
        }
        if (typeof info.message === 'string') {
            return Buffer.from(info.message);
        }
        return Buffer.from('');
    }

    static sanitizeRecipientField(value) {
        if (!value) return null;
        if (Array.isArray(value)) {
            const cleaned = value.map((v) => String(v).trim()).filter(Boolean);
            return cleaned.length > 0 ? cleaned : null;
        }
        if (typeof value === 'string') {
            const cleaned = value.trim();
            return cleaned.length > 0 ? cleaned : null;
        }
        return null;
    }

    static applyDraftEnvelope(mailOptions, fallbackAddress) {
        const to = IMAPEmailClient.sanitizeRecipientField(mailOptions.to);
        const cc = IMAPEmailClient.sanitizeRecipientField(mailOptions.cc);
        const bcc = IMAPEmailClient.sanitizeRecipientField(mailOptions.bcc);

        if (to === null) delete mailOptions.to;
        else mailOptions.to = to;
        if (cc === null) delete mailOptions.cc;
        else mailOptions.cc = cc;
        if (bcc === null) delete mailOptions.bcc;
        else mailOptions.bcc = bcc;

        const hasRecipients = Boolean(
            (Array.isArray(to) ? to.length > 0 : to) ||
            (Array.isArray(cc) ? cc.length > 0 : cc) ||
            (Array.isArray(bcc) ? bcc.length > 0 : bcc)
        );

        if (!hasRecipients && fallbackAddress) {
            mailOptions.envelope = {
                from: mailOptions.from || fallbackAddress,
                to: fallbackAddress
            };
        }
        return mailOptions;
    }

    static normalizeMailboxName(boxName) {
        if (!boxName) return '';
        if (typeof boxName === 'object' && boxName.path) {
            boxName = boxName.path;
        }
        return String(boxName)
            .replace(/[\r\n\0]/g, '')
            .trim();
    }

    createImap() {
        return new Imap({
            user: this.usr,
            password: this.pwd,
            host: this.host,
            port: this.port,
            tls: this.tls,
            tlsOptions: {
                rejectUnauthorized: false
            }
        });
    }

    getImapIdInfo() {
        return IMAPEmailClient.buildImapIdInfo(this.host);
    }

    connect(imap, context = '') {
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                imap.removeListener('ready', onReady);
                imap.removeListener('error', onError);
            };
            const onReady = () => {
                if (settled) return;
                settled = true;
                cleanup();
                // 连接成功后，注册一个持久的 error 监听器，防止后续 socket 错误
                // （如 ECONNRESET）变成未捕获异常导致进程崩溃
                imap.on('error', (err) => {
                    logger.warn(
                        `IMAP socket error after connect${context ? ` (${context})` : ''}: ${err.message || err}`
                    );
                });
                const idInfo = this.getImapIdInfo();
                if (idInfo && imap.serverSupports && imap.serverSupports('ID')) {
                    try {
                        imap.id(idInfo, (err) => {
                            if (err) {
                                logger.warn(`IMAP ID failed${context ? ` (${context})` : ''}: ${err.message}`);
                            }
                            resolve(imap);
                        });
                    } catch (error) {
                        logger.warn(`IMAP ID failed${context ? ` (${context})` : ''}: ${error.message}`);
                        resolve(imap);
                    }
                } else {
                    resolve(imap);
                }
            };
            const onError = (err) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(err);
            };
            imap.once('ready', onReady);
            imap.once('error', onError);
            imap.connect();
        });
    }

    end(imap) {
        return new Promise((resolve) => {
            let settled = false;
            const cleanup = () => {
                imap.removeListener('end', onEnd);
                imap.removeListener('close', onEnd);
            };
            const onEnd = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve();
            };
            imap.once('end', onEnd);
            imap.once('close', onEnd);
            try {
                imap.end();
            } catch (error) {
                cleanup();
                resolve();
            }
            setTimeout(() => {
                if (!settled) {
                    cleanup();
                    resolve();
                }
            }, 2000);
        });
    }

    openBox(imap, boxName, readOnly = true) {
        return new Promise((resolve, reject) => {
            imap.openBox(boxName, readOnly, (err, box) => {
                if (err) reject(err);
                else resolve(box);
            });
        });
    }

    getBoxes(imap) {
        return new Promise((resolve, reject) => {
            imap.getBoxes((err, boxes) => {
                if (err) reject(err);
                else resolve(boxes);
            });
        });
    }

    search(imap, criteria) {
        return new Promise((resolve, reject) => {
            imap.search(criteria, (err, uids) => {
                if (err) reject(err);
                else resolve(uids || []);
            });
        });
    }

    append(imap, raw, options) {
        return new Promise((resolve, reject) => {
            imap.append(raw, options, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    addBox(imap, name) {
        return new Promise((resolve, reject) => {
            imap.addBox(name, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    move(imap, uids, boxTo) {
        return new Promise((resolve, reject) => {
            imap.move(uids, boxTo, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    expunge(imap, uids = null) {
        return new Promise((resolve, reject) => {
            if (uids === null || uids === undefined) {
                imap.expunge((err) => {
                    if (err) reject(err);
                    else resolve(true);
                });
            } else {
                imap.expunge(uids, (err) => {
                    if (err) reject(err);
                    else resolve(true);
                });
            }
        });
    }

    addFlags(imap, uid, flags) {
        return new Promise((resolve, reject) => {
            imap.addFlags(uid, flags, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    delFlags(imap, uid, flags) {
        return new Promise((resolve, reject) => {
            imap.delFlags(uid, flags, (err) => {
                if (err) reject(err);
                else resolve(true);
            });
        });
    }

    async fetchRawMessage(imap, uid) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            const fetcher = imap.fetch(uid, { bodies: '', struct: true, uid: true });
            fetcher.on('message', (msg) => {
                msg.on('body', (stream) => {
                    stream.on('data', (chunk) => chunks.push(chunk));
                });
            });
            fetcher.once('error', reject);
            fetcher.once('end', () => resolve(Buffer.concat(chunks)));
        });
    }

    async resolveBoxMap(cache, imap = null, forceRefresh = false) {
        if (!cache) return null;
        const cacheKey = this.usr;
        if (!forceRefresh && cache.has(cacheKey)) {
            return cache.get(cacheKey);
        }

        let localImap = imap;
        let shouldClose = false;
        try {
            if (!localImap) {
                localImap = this.createImap();
                await withTimeout(
                    this.connect(localImap, 'IMAP connect (resolve boxes)'),
                    30000,
                    'IMAP connect (resolve boxes)'
                );
                shouldClose = true;
            }

            const boxes = await withTimeout(this.getBoxes(localImap), 30000, 'IMAP getBoxes');
            const flat = IMAPEmailClient.flattenBoxes(boxes);

            const inboxBox =
                flat.find((box) => box.path.toUpperCase() === 'INBOX')?.path ||
                IMAPEmailClient.findBoxByAttrib(flat, '\\Inbox') ||
                'INBOX';

            const sentBox =
                IMAPEmailClient.findBoxByAttrib(flat, '\\Sent') ||
                IMAPEmailClient.findBoxByName(flat, [
                    'sent items',
                    'sent mail',
                    'sent',
                    '已发送',
                    '已發送',
                    '发件箱',
                    '已寄',
                    '已送'
                ]);

            const draftsBox =
                IMAPEmailClient.findBoxByAttrib(flat, '\\Drafts') ||
                IMAPEmailClient.findBoxByName(flat, ['drafts', 'draft', '草稿箱', '草稿']);

            const trashBox =
                IMAPEmailClient.findBoxByAttrib(flat, '\\Trash') ||
                IMAPEmailClient.findBoxByName(flat, [
                    'trash',
                    'deleted',
                    'bin',
                    'junk',
                    '垃圾箱',
                    '已删除',
                    '已刪除',
                    '回收站',
                    '废纸篓',
                    '已删除邮件'
                ]);

            const map = {
                inbox: inboxBox,
                sent: sentBox,
                drafts: draftsBox,
                trash: trashBox
            };
            cache.set(cacheKey, map);
            return map;
        } finally {
            if (shouldClose && localImap) {
                await this.end(localImap);
            }
        }
    }

    async fetchHeaders(imap, uids) {
        if (!uids || uids.length === 0) return [];
        return new Promise((resolve, reject) => {
            const results = [];
            const fetcher = imap.fetch(uids, {
                bodies: 'HEADER.FIELDS (FROM TO CC BCC SUBJECT DATE MESSAGE-ID)',
                struct: false,
                uid: true
            });
            fetcher.on('message', (msg) => {
                let uid = null;
                let flags = [];
                const chunks = [];
                msg.on('attributes', (attrs) => {
                    uid = attrs.uid;
                    flags = attrs.flags || [];
                });
                msg.on('body', (stream) => {
                    stream.on('data', (chunk) => chunks.push(chunk));
                });
                msg.once('end', () => {
                    results.push({
                        uid,
                        flags,
                        raw: Buffer.concat(chunks).toString('utf-8')
                    });
                });
            });
            fetcher.once('error', reject);
            fetcher.once('end', () => resolve(results));
        });
    }

    async syncMailbox(storage, imap, boxName, type) {
        if (!boxName) return 0;
        await this.openBox(imap, boxName, true);

        const sinceDate = IMAPEmailClient.getOneMonthAgoDateStr();
        const serverUids = await this.search(imap, ['ALL', ['SINCE', sinceDate]]);
        const unreadUids =
            type === 'inbox' ? new Set(await this.search(imap, ['UNSEEN', ['SINCE', sinceDate]])) : new Set();

        const localMeta = await storage.getImapMetaByBox(boxName);
        const localImapUidSet = new Set(localMeta.map((doc) => doc.imapUid));

        const newUids = serverUids.filter((uid) => !localImapUidSet.has(uid));
        if (type === 'inbox' && newUids.length > 0) {
            logger.info(`IMAP syncing inbox for ${this.usr}, new emails: ${newUids.length}`);
            NotificationManager.getInstance().info(
                '邮箱',
                '收取新邮件',
                `即将从${this.usr}收取 ${newUids.length} 封新邮件`
            );
        }
        if (newUids.length > 0) {
            const fetched = await this.fetchHeaders(imap, newUids);
            const headers = await pMap(
                fetched,
                async (item) => {
                    if (!item?.uid) return null;
                    const rawHeader = IMAPEmailClient.ensureHeaderTerminated(item.raw || '');
                    try {
                        const parsed = await simpleParser(rawHeader);
                        const messageId = parsed.messageId || null;

                        let existingDoc = null;
                        if (messageId) {
                            existingDoc = await storage.getEmailMetaByMessageId(messageId, type);
                        }
                        const localUid = existingDoc?.uid || IMAPEmailClient.buildLocalUid(boxName, item.uid);

                        await storage.saveRawEmailHeader(localUid, rawHeader);

                        const header = new EmailHeader(
                            localUid,
                            parsed.subject,
                            parsed.from?.value,
                            parsed.to?.value,
                            parsed.cc?.value,
                            parsed.bcc?.value,
                            parsed.date?.getTime(),
                            type === 'inbox' ? unreadUids.has(item.uid) : false,
                            item.flags?.includes('\\Flagged') || false,
                            false,
                            type
                        );
                        header.imapUid = item.uid;
                        header.imapBox = boxName;
                        header.messageId = messageId;
                        header.protocol = 'imap';
                        return header;
                    } catch (error) {
                        logger.error(`error parsing IMAP header: ${item.uid}: ${error.message}`);
                        return null;
                    }
                },
                { concurrency: 8 }
            );

            const filteredHeaders = headers.filter(Boolean);
            if (filteredHeaders.length > 0) {
                await storage.saveEmailHeaders(...filteredHeaders);
            }
        }

        if (type === 'inbox') {
            await storage.updateImapUnread(boxName, unreadUids);
        }

        try {
            const serverLocalUidSet = new Set(serverUids.map((uid) => IMAPEmailClient.buildLocalUid(boxName, uid)));
            const cleanedCount = await storage.pruneExpiredEmailsByBox(boxName, serverLocalUidSet);
            if (cleanedCount > 0) {
                logger.info(`[IMAP Sync] Physically removed ${cleanedCount} expired emails in ${boxName}.`);
            }
        } catch (e) {
            logger.warn(`[IMAP Sync] Failed to prune expired emails in ${boxName}: ${e.message}`);
        }

        return newUids.length;
    }

    async syncAll(storage, cache, isRetryableError = null) {
        const maxRetries = 2;
        const overallTimeout = 300000;
        let lastError = null;

        const syncPromise = (async () => {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                let imap = null;
                try {
                    imap = this.createImap();
                    await withTimeout(this.connect(imap, 'IMAP connect'), 30000, 'IMAP connect');
                    const boxMap = await this.resolveBoxMap(cache, imap, true);

                    let totalNew = 0;
                    if (boxMap?.inbox) {
                        totalNew = await this.syncMailbox(storage, imap, boxMap.inbox, 'inbox');
                    }
                    if (boxMap?.drafts) {
                        await this.syncMailbox(storage, imap, boxMap.drafts, 'draft');
                    }
                    if (boxMap?.sent) {
                        await this.syncMailbox(storage, imap, boxMap.sent, 'sent');
                    }

                    return totalNew;
                } catch (error) {
                    lastError = error;
                    const retryable = typeof isRetryableError === 'function' ? isRetryableError(error) : false;
                    const shouldRetry = attempt < maxRetries - 1 && retryable;
                    if (shouldRetry) {
                        const delay = (attempt + 1) * 1000;
                        logger.warn(
                            `retrying syncIMAPInbox, attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms, error: ${error.message}`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    } else {
                        break;
                    }
                } finally {
                    if (imap) {
                        await this.end(imap);
                    }
                }
            }
            logger.error(
                `failed to sync IMAP inbox after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`
            );
            throw lastError || new Error('同步邮件失败');
        })();

        try {
            return await withTimeout(syncPromise, overallTimeout, 'syncIMAPInbox');
        } catch (error) {
            if (error.message?.includes('超时')) {
                logger.error(`syncIMAPInbox overall timeout after ${overallTimeout}ms`);
                throw new Error(`同步邮件超时，请检查网络连接或稍后重试`);
            }
            throw error;
        }
    }

    async updateSeen(imapBox, imapUid, seen) {
        if (!imapBox || !imapUid) return;
        const imap = this.createImap();
        try {
            await withTimeout(this.connect(imap, 'IMAP connect (flags)'), 30000, 'IMAP connect (flags)');
            await withTimeout(this.openBox(imap, imapBox, false), 30000, `IMAP open ${imapBox}`);
            if (seen) {
                await withTimeout(this.addFlags(imap, imapUid, ['\\Seen']), 30000, 'IMAP add \\Seen');
            } else {
                await withTimeout(this.delFlags(imap, imapUid, ['\\Seen']), 30000, 'IMAP del \\Seen');
            }
        } catch (error) {
            logger.warn(`failed to update IMAP seen flag: ${error.message}`);
        } finally {
            await this.end(imap);
        }
    }

    async appendMessage(boxName, rawMessage, flags = []) {
        const normalizedBox = IMAPEmailClient.normalizeMailboxName(boxName);
        if (!normalizedBox || !rawMessage) return false;
        if (Buffer.isBuffer(rawMessage) && rawMessage.length === 0) {
            logger.warn(`skip IMAP append: empty raw message for ${normalizedBox}`);
            return false;
        }
        const safeFlags = Array.isArray(flags) ? flags.filter(Boolean) : flags ? [flags] : [];
        const imap = this.createImap();
        try {
            await withTimeout(this.connect(imap, 'IMAP connect (append)'), 30000, 'IMAP connect (append)');
            try {
                const options = { mailbox: normalizedBox };
                if (safeFlags.length > 0) {
                    options.flags = safeFlags;
                }
                await withTimeout(this.append(imap, rawMessage, options), 30000, `IMAP append ${normalizedBox}`);
                return true;
            } catch (error) {
                logger.warn(`failed to append to IMAP ${normalizedBox}: ${error.message}`);
                if (error?.stack) {
                    logger.warn(`append IMAP stack: ${error.stack}`);
                }
                try {
                    await withTimeout(this.openBox(imap, normalizedBox, false), 30000, `IMAP open ${normalizedBox}`);
                } catch (openError) {
                    const openMessage = openError?.message || '';
                    if (/not found|no such|does not exist|mailbox/i.test(openMessage)) {
                        try {
                            await withTimeout(this.addBox(imap, normalizedBox), 30000, `IMAP add ${normalizedBox}`);
                        } catch (addError) {
                            logger.warn(
                                `failed to create IMAP mailbox ${normalizedBox}: ${addError.message || addError}`
                            );
                        }
                    }
                }
                try {
                    const fallbackOptions = { mailbox: normalizedBox };
                    await withTimeout(
                        this.append(imap, rawMessage, fallbackOptions),
                        30000,
                        `IMAP append fallback ${normalizedBox}`
                    );
                    return true;
                } catch (fallbackError) {
                    logger.warn(`fallback append to IMAP ${normalizedBox} failed: ${fallbackError.message}`);
                    if (fallbackError?.stack) {
                        logger.warn(`append fallback stack: ${fallbackError.stack}`);
                    }
                    return false;
                }
            }
        } finally {
            await this.end(imap);
        }
    }

    async deleteMessage(imapBox, imapUid, trashBox = null) {
        if (!imapBox || !imapUid) return false;
        const normalizedBox = IMAPEmailClient.normalizeMailboxName(imapBox);
        const normalizedTrash = IMAPEmailClient.normalizeMailboxName(trashBox);
        const imap = this.createImap();
        try {
            await withTimeout(this.connect(imap, 'IMAP connect (delete)'), 30000, 'IMAP connect (delete)');
            await withTimeout(this.openBox(imap, normalizedBox, false), 30000, `IMAP open ${normalizedBox}`);

            if (normalizedTrash && normalizedTrash !== normalizedBox) {
                try {
                    await withTimeout(this.move(imap, imapUid, normalizedTrash), 30000, `IMAP move ${normalizedTrash}`);
                    return true;
                } catch (moveError) {
                    logger.warn(`failed to move IMAP message to trash: ${moveError.message}`);
                }
            }

            await withTimeout(this.addFlags(imap, imapUid, ['\\Deleted']), 30000, 'IMAP add \\Deleted');
            if (imap.serverSupports && imap.serverSupports('UIDPLUS')) {
                try {
                    await withTimeout(this.expunge(imap, imapUid), 30000, 'IMAP expunge');
                } catch (expungeError) {
                    logger.warn(`failed to expunge IMAP message: ${expungeError.message}`);
                }
            }
            return true;
        } catch (error) {
            logger.warn(`failed to delete IMAP message: ${error.message}`);
            return false;
        } finally {
            await this.end(imap);
        }
    }

    async getEmail(localUid, imapBox, imapUid, attachmentDirectory) {
        const imap = this.createImap();
        const operationTimeout = 120000;
        try {
            await withTimeout(this.connect(imap, 'IMAP connect'), 30000, 'IMAP connect');
            await withTimeout(this.openBox(imap, imapBox, true), 30000, `IMAP open ${imapBox}`);
            const rawMessage = await withTimeout(
                this.fetchRawMessage(imap, imapUid),
                operationTimeout,
                `IMAP fetch ${imapUid}`
            );
            if (!rawMessage || rawMessage.length === 0) {
                logger.warn(`IMAP empty message for uid ${imapUid} in ${imapBox}`);
                return null;
            }
            const parsed = await simpleParser(rawMessage);
            const attachments = await this.prepareAttachments(localUid, parsed.attachments, attachmentDirectory);
            const content = new EmailContent(parsed.html, parsed.text, attachments);
            const header = new EmailHeader(
                localUid,
                parsed.subject,
                parsed.from?.value,
                parsed.to?.value,
                parsed.cc?.value,
                parsed.bcc?.value,
                parsed.date?.getTime()
            );
            header.messageId = parsed.messageId || null;
            header.imapUid = imapUid;
            header.imapBox = imapBox;
            header.protocol = 'imap';
            return { header, content };
        } catch (error) {
            logger.error(`IMAP error getting email content: ${localUid}: ${error.message || String(error)}`);
            return null;
        } finally {
            await this.end(imap);
        }
    }

    async getEmailContent(localUid, imapBox, imapUid, attachmentDirectory) {
        const emailResult = await this.getEmail(localUid, imapBox, imapUid, attachmentDirectory);
        if (!emailResult) {
            logger.error(`failed to get email content: ${localUid}, IMAP getEmail returned null`);
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

    async sendMail(to, cc, bcc, subject, text, html, attachments, messageId = null, headers = null) {
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
        if (messageId) {
            mailOptions.messageId = messageId;
        }
        if (headers) {
            mailOptions.headers = headers;
        }
        return await this.sendMailWithOptions(mailOptions);
    }

    async sendMailWithOptions(mailOptions) {
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
            },
            // 增加连接和发送超时设置
            connectionTimeout: 5 * 60 * 1000, // 5分钟
            socketTimeout: 5 * 60 * 1000 // 5分钟
        });

        try {
            await transport.sendMail(mailOptions);
            NotificationManager.getInstance().info('邮箱', '发送成功', '邮件发送成功');
            return true;
        } catch (error) {
            logger.error(`SMTP send error: ${error.message}`);
            NotificationManager.getInstance().error(error, '邮箱', '发送失败', '邮件发送失败');
            return false;
        }
    }
}

class MailboxStorage {
    constructor(dbPath) {
        /** @type {nedb} */
        this.dbPath = dbPath;
        this.db = new nedb({ filename: dbPath + '.db' });
        this.rawdb = new nedb({ filename: dbPath + '_raw.db' });
        this.contentdb = new nedb({ filename: dbPath + '_content.db' });
    }

    async initialize() {
        const baseDir = path.dirname(this.dbPath);
        if (!fs.existsSync(baseDir)) {
            fs.mkdirSync(baseDir, { recursive: true });
        }

        const dbFile = this.dbPath + '.db';
        const rawFile = this.dbPath + '_raw.db';
        const contentFile = this.dbPath + '_content.db';

        await this.db
            .load()
            .catch((err) => {
                logger.error(`error loading mailbox_header_storage.db: ${err}`);
                fs.rmSync(dbFile, { force: true });
                this.db = new nedb({ filename: dbFile, autoload: true });
                NotificationManager.getInstance().error('邮箱', '收取新邮件', `邮箱数据库(db)损坏，已删除并重新创建`);
            })
            .finally(() => {
                this.db.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
            });
        await this.rawdb
            .load()
            .catch((err) => {
                logger.error(`error loading mailbox_header_storage.db.raw: ${err}`);
                fs.rmSync(rawFile, { force: true });
                this.rawdb = new nedb({ filename: rawFile, autoload: true });
                NotificationManager.getInstance().error(
                    '邮箱',
                    '收取新邮件',
                    `邮箱数据库(rawdb)损坏，已删除并重新创建`
                );
            })
            .finally(() => {
                this.rawdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
            });
        await this.contentdb
            .load()
            .catch((err) => {
                logger.error(`error loading mailbox_header_storage.db.content: ${err}`);
                fs.rmSync(contentFile, { force: true });
                this.contentdb = new nedb({ filename: contentFile, autoload: true });
                NotificationManager.getInstance().error(
                    '邮箱',
                    '收取新邮件',
                    `邮箱数据库(contentdb)损坏，已删除并重新创建`
                );
            })
            .finally(() => {
                this.contentdb.ensureIndex({ fieldName: 'uid', unique: true, sparse: true });
            });
    }

    async saveRawEmailHeader(uid, header) {
        await this.rawdb.update({ uid: uid }, { $set: { uid: uid, header: header } }, { upsert: true });
    }

    async getRawEmailHeader(uid) {
        const doc = await this.rawdb.findOne({ uid: uid });
        return doc?.header;
    }

    async getEmailMeta(uid) {
        return await this.db.findOne({ uid: uid });
    }

    async getEmailMetaByMessageId(messageId, type = null) {
        if (!messageId) return null;
        const query = { messageId: messageId };
        if (type) query.type = type;
        return await this.db.findOne(query);
    }

    async getImapMetaByBox(imapBox) {
        if (!imapBox) return [];
        return await this.db.find({ imapBox: imapBox });
    }

    async markEmailAsRead(uid) {
        logger.info(`marking email as read: ${uid}`);
        await this.db.update({ uid: uid }, { $set: { unread: false } });
    }

    async markEmailAsUnread(uid) {
        logger.info(`marking email as unread: ${uid}`);
        await this.db.update({ uid: uid }, { $set: { unread: true } });
    }

    async deleteEmail(uid) {
        logger.info(`deleting email: ${uid}`);
        await this.db.update({ uid: uid }, { $set: { deleted: true } });
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
        await this.db.update({ uid: uid }, { $set: { starred: starred } });
    }

    async saveEmailContent(uid, content) {
        try {
            await this.contentdb.update(
                { uid: uid },
                {
                    $set: {
                        uid: uid,
                        htmlContent: content.htmlContent,
                        textContent: content.textContent,
                        attachments: content.attachments
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error(`error saving email content: ${uid}: ${error}`);
        }
    }

    async saveRawEmailHeaders(protocol, ...rawHeaders) {
        const headers = await pMap(
            rawHeaders,
            async ([uid, header]) => {
                const parsed = await simpleParser(header);
                try {
                    const header = new EmailHeader(
                        uid,
                        parsed.subject,
                        parsed.from?.value,
                        parsed.to?.value,
                        parsed.cc?.value,
                        parsed.bcc?.value,
                        parsed.date?.getTime()
                    );
                    header.protocol = protocol;
                    return header;
                } catch (error) {
                    logger.error(`error parsing email header: ${uid}: ${error}`);
                    return null;
                }
            },
            { concurrency: 16 }
        );
        await this.saveEmailHeaders(...headers.filter((header) => header !== null));
    }

    async saveEmailHeader(header) {
        await this.saveEmailHeaders(header);
    }

    async saveEmailHeaders(...emails) {
        for (const email of emails) {
            try {
                await this.db.update({ uid: email.uid }, { $set: email }, { upsert: true });
            } catch (error) {
                logger.error(`error saving email: ${email.uid}: ${error}`);
            }
        }
    }

    async getUIDSet() {
        const docs = await this.db.find({});
        const set = new Set(docs.map((doc) => doc.uid));
        return set;
    }

    async getEmailHeaderList(protocol, offset = 0, pageSize = 20) {
        const dbQuery = {
            deleted: { $ne: true },
            $and: [{ type: { $ne: 'draft' } }, { type: { $ne: 'sent' } }]
        };
        if (protocol) {
            dbQuery.protocol = protocol;
        }
        const docs = await this.db.find(dbQuery).sort({ date: -1 }).skip(offset).limit(pageSize);
        return docs.map(
            (doc) =>
                new EmailHeader(
                    doc.uid,
                    doc.subject,
                    doc.from,
                    doc.to,
                    doc.cc,
                    doc.bcc,
                    doc.date,
                    doc.unread,
                    doc.starred,
                    doc.deleted,
                    doc.type || 'inbox'
                )
        );
    }

    async getDraftList(protocol, offset = 0, pageSize = 20) {
        const dbQuery = { deleted: { $ne: true }, type: 'draft' };
        if (protocol) {
            dbQuery.protocol = protocol;
        }
        const docs = await this.db.find(dbQuery).sort({ date: -1 }).skip(offset).limit(pageSize);
        return docs.map(
            (doc) =>
                new EmailHeader(
                    doc.uid,
                    doc.subject,
                    doc.from,
                    doc.to,
                    doc.cc,
                    doc.bcc,
                    doc.date,
                    doc.unread,
                    doc.starred,
                    doc.deleted,
                    doc.type
                )
        );
    }

    async getSentList(protocol, offset = 0, pageSize = 20) {
        const dbQuery = { deleted: { $ne: true }, type: 'sent' };
        if (protocol) {
            dbQuery.protocol = protocol;
        }
        const docs = await this.db.find(dbQuery).sort({ date: -1 }).skip(offset).limit(pageSize);
        return docs.map(
            (doc) =>
                new EmailHeader(
                    doc.uid,
                    doc.subject,
                    doc.from,
                    doc.to,
                    doc.cc,
                    doc.bcc,
                    doc.date,
                    doc.unread,
                    doc.starred,
                    doc.deleted,
                    doc.type
                )
        );
    }

    async saveDraft(uid, emailHeader, emailContent, protocol = null) {
        const draftData = {
            uid: uid,
            subject: emailHeader.subject,
            from: emailHeader.from,
            to: emailHeader.to,
            cc: emailHeader.cc,
            bcc: emailHeader.bcc,
            messageId: emailHeader.messageId || null,
            date: Date.now(),
            unread: false,
            starred: false,
            deleted: false,
            type: 'draft'
        };
        if (protocol) {
            draftData.protocol = protocol;
        }
        await this.db.update({ uid: uid }, { $set: draftData }, { upsert: true });
        await this.contentdb.update(
            { uid: uid },
            {
                $set: {
                    uid: uid,
                    htmlContent: emailContent.htmlContent,
                    textContent: emailContent.textContent,
                    attachments: emailContent.attachments || []
                }
            },
            { upsert: true }
        );
    }

    async deleteDraft(uid) {
        await this.db.remove({ uid: uid, type: 'draft' });
        await this.contentdb.remove({ uid: uid });
    }

    async saveSentEmail(uid, emailHeader, emailContent, protocol = null) {
        const sentData = {
            uid: uid,
            subject: emailHeader.subject,
            from: emailHeader.from,
            to: emailHeader.to,
            cc: emailHeader.cc,
            bcc: emailHeader.bcc,
            messageId: emailHeader.messageId || null,
            date: Date.now(),
            unread: false,
            starred: false,
            deleted: false,
            type: 'sent'
        };
        if (protocol) {
            sentData.protocol = protocol;
        }
        await this.db.update({ uid: uid }, { $set: sentData }, { upsert: true });
        await this.contentdb.update(
            { uid: uid },
            {
                $set: {
                    uid: uid,
                    htmlContent: emailContent.htmlContent,
                    textContent: emailContent.textContent,
                    attachments: emailContent.attachments || []
                }
            },
            { upsert: true }
        );
    }

    async searchEmails(protocol, query) {
        const dbQuery = {};
        const orConditions = [];

        if (query.general) {
            const generalRegex = new RegExp(query.general, 'i');
            const matchingUids = new Set();
            const subjectQuery = { subject: { $regex: generalRegex } };
            if (protocol) subjectQuery.protocol = protocol;
            const subjectDocs = await this.db.find(subjectQuery);
            for (const doc of subjectDocs) matchingUids.add(doc.uid);

            const fromQuery = {
                $or: [{ 'from.address': { $regex: generalRegex } }, { 'from.name': { $regex: generalRegex } }]
            };
            if (protocol) fromQuery.protocol = protocol;
            const fromDocs = await this.db.find(fromQuery);
            for (const doc of fromDocs) matchingUids.add(doc.uid);

            const bodyRegex = new RegExp(query.general, 'i');
            const contentDocs = await this.contentdb.find({
                $or: [{ htmlContent: { $regex: bodyRegex } }, { textContent: { $regex: bodyRegex } }]
            });
            for (const contentDoc of contentDocs) matchingUids.add(contentDoc.uid);

            if (matchingUids.size > 0) dbQuery.uid = { $in: Array.from(matchingUids) };
            else return [];
        } else {
            if (query.subject) dbQuery.subject = { $regex: new RegExp(query.subject, 'i') };
            if (query.from) {
                orConditions.push({ 'from.address': { $regex: new RegExp(query.from, 'i') } });
                orConditions.push({ 'from.name': { $regex: new RegExp(query.from, 'i') } });
            }
            if (query.to) {
                orConditions.push({ 'to.address': { $regex: new RegExp(query.to, 'i') } });
                orConditions.push({ 'to.name': { $regex: new RegExp(query.to, 'i') } });
            }
            if (orConditions.length > 0) dbQuery.$or = orConditions;
        }

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

        // Type filter (draft, sent, inbox)
        if (query.type !== undefined) {
            dbQuery.type = query.type;
        }

        // Protocol filter
        if (protocol) {
            dbQuery.protocol = protocol;
        }

        // Always exclude deleted emails
        dbQuery.deleted = { $ne: true };

        // Execute the query
        let docs = await this.db.find(dbQuery).sort({ date: -1 });

        if (query.body && !query.general) {
            const bodyRegex = new RegExp(query.body, 'i');
            const matchingUids = new Set();
            const contentDocs = await this.contentdb.find({
                $or: [{ htmlContent: { $regex: bodyRegex } }, { textContent: { $regex: bodyRegex } }]
            });
            for (const contentDoc of contentDocs) matchingUids.add(contentDoc.uid);
            docs = docs.filter((doc) => matchingUids.has(doc.uid));
        }

        if (query.attachmentName) {
            const attachRegex = new RegExp(query.attachmentName, 'i');
            const docUids = docs.map((doc) => doc.uid);
            const contentDocs = await this.contentdb.find({ uid: { $in: docUids } });
            const matchingUids = new Set();
            for (const contentDoc of contentDocs) {
                const attachments = contentDoc.attachments || [];
                if (attachments.some((a) => a.filename && attachRegex.test(a.filename))) {
                    matchingUids.add(contentDoc.uid);
                }
            }
            docs = docs.filter((doc) => matchingUids.has(doc.uid));
        }

        // Apply limit and offset for pagination (after all filtering)
        if (query.offset !== undefined) {
            docs = docs.slice(query.offset);
        }
        if (query.limit !== undefined) {
            docs = docs.slice(0, query.limit);
        }

        return docs.map(
            (doc) =>
                new EmailHeader(
                    doc.uid,
                    doc.subject,
                    doc.from,
                    doc.to,
                    doc.cc,
                    doc.bcc,
                    doc.date,
                    doc.unread,
                    doc.starred,
                    doc.deleted,
                    doc.type || 'inbox'
                )
        );
    }

    /**
     * 彻底删除那些服务器上已不存在，且本地没有正文内容的"僵尸"邮件
     * 同时从 header db 和 raw db 中物理删除
     * @param {Set<string>} serverUidSet 服务器端当前的UID集合
     */
    async pruneExpiredEmails(serverUidSet) {
        // 1. 找出所有本地显示为"未删除"的邮件 (只查 uid 字段)
        const localActiveDocs = await this.db.find({ deleted: { $ne: true } }, { uid: 1 });

        let cleanedCount = 0;
        for (const doc of localActiveDocs) {
            // 2. 如果本地 UID 不在服务器列表中
            if (!serverUidSet.has(doc.uid)) {
                // 3. 再次确认本地没有正文内容 (防止误删已归档邮件)
                const contentCount = await this.contentdb.count({ uid: doc.uid });

                if (contentCount === 0) {
                    // 4. 执行物理删除 (Hard Delete)
                    // 删除 header 数据库记录
                    await this.db.remove({ uid: doc.uid }, { multi: false });
                    // 删除 raw header 数据库记录
                    await this.rawdb.remove({ uid: doc.uid }, { multi: false });

                    cleanedCount++;
                }
            }
        }
        return cleanedCount;
    }

    async pruneExpiredEmailsByBox(imapBox, serverUidSet) {
        if (!imapBox) return 0;
        const localActiveDocs = await this.db.find({ deleted: { $ne: true }, imapBox: imapBox }, { uid: 1 });
        let cleanedCount = 0;
        for (const doc of localActiveDocs) {
            if (!serverUidSet.has(doc.uid)) {
                const contentCount = await this.contentdb.count({ uid: doc.uid });
                if (contentCount === 0) {
                    await this.db.remove({ uid: doc.uid }, { multi: false });
                    await this.rawdb.remove({ uid: doc.uid }, { multi: false });
                    cleanedCount++;
                }
            }
        }
        return cleanedCount;
    }

    async updateImapUnread(imapBox, unreadUids) {
        if (!imapBox) return;
        const unreadArray = Array.from(unreadUids || []);
        if (unreadArray.length > 0) {
            await this.db.update(
                { imapBox: imapBox, imapUid: { $in: unreadArray } },
                { $set: { unread: true } },
                { multi: true }
            );
            await this.db.update(
                { imapBox: imapBox, imapUid: { $nin: unreadArray } },
                { $set: { unread: false } },
                { multi: true }
            );
        } else {
            await this.db.update({ imapBox: imapBox }, { $set: { unread: false } }, { multi: true });
        }
    }
}

class MailboxWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);
        this.appDataDirectory = appDataDirectory;
        // 使用 Map 管理多个 storage 和 profile
        this.storageMap = new Map(); // username -> MailboxStorage
        this.profileMap = new Map(); // username -> EmailProfileSchema
        this.currentProfileId = null; // 当前选中的 profile username
        this.isSyncing = false;
        // 跟踪每个账号的新邮件数量（基于同步时新增的邮件）
        this.newEmailCounts = new Map(); // username -> number
        this.isMailboxOpened = false;
        this.imapBoxCache = new Map(); // username -> { inbox, sent, drafts }
        // 同步状态追踪
        this.syncStatus = {
            isSyncing: false,
            currentProfileId: null,
            lastSyncTime: null,
            lastSyncResults: {},
            syncStartTime: null
        };
    }

    resolveInboxProtocol(profile) {
        const inbox = profile?.inbox;
        if (!inbox) return null;

        if (inbox.protocol === 'imap' && inbox.imap) return 'imap';
        if (inbox.protocol === 'pop3' && inbox.pop3) return 'pop3';

        if (inbox.imap && !inbox.pop3) return 'imap';
        if (inbox.pop3 && !inbox.imap) return 'pop3';

        if (inbox.imap) return 'imap';
        if (inbox.pop3) return 'pop3';

        return null;
    }

    async syncPOP3Inbox(profile, storage) {
        const { username, password, inbox } = profile;
        if (!inbox?.pop3) return 0;

        const pop3 = new Pop3Command({
            user: username,
            password: password,
            host: inbox.pop3.host,
            port: inbox.pop3.port,
            tls: inbox.pop3.tls
        });
        const maxRetries = 3;
        const operationTimeout = 30000; // 单个操作超时30秒
        const overallTimeout = 300000; // 整体超时5分钟
        let lastError = null;

        // 为整个同步过程添加超时
        const syncPromise = (async () => {
            // 重试机制：对于网络错误、超时等概率性问题进行重试
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    // 为UIDL操作添加超时
                    const allList = await withTimeout(pop3.UIDL(), operationTimeout, 'UIDL');
                    // 1. 构建服务器 UID 集合
                    const serverUidSet = new Set(allList.map(([_, uid]) => uid));

                    // 2. 执行物理清理
                    try {
                        const cleanedCount = await storage.pruneExpiredEmails(serverUidSet);

                        if (cleanedCount > 0) {
                            logger.info(
                                `[Sync] Physically removed ${cleanedCount} expired emails (header & raw) without content.`
                            );
                        }
                    } catch (e) {
                        logger.warn(`[Sync] Failed to prune expired emails: ${e.message}`);
                    }
                    const uidSet = await storage.getUIDSet();
                    const newList = allList.filter(([_, uid]) => !uidSet.has(uid)).reverse();

                    let pendingHeaders = [];
                    if (newList.length > 0) {
                        NotificationManager.getInstance().info(
                            '邮箱',
                            '收取新邮件',
                            `即将从${username}收取 ${newList.length} 封新邮件`
                        );
                    }

                    for (const [i, [index, uid]] of newList.entries()) {
                        const cachedRawEmail = await storage.getRawEmailHeader(uid);
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
                                await storage.saveRawEmailHeader(uid, rawEmailHeader);
                            } catch (topError) {
                                // 单个邮件头获取失败，记录错误但继续处理其他邮件
                                logger.warn(
                                    `failed to get email header for ${uid}, index ${index}: ${topError.message}`
                                );
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
                            // 在收取的过程中也及时通知前端刷新邮件列表，避免前端卡住太久
                            this.notifyEmailListUpdated(this.currentProfileId);
                        }

                        if (pendingHeaders.length >= 100) {
                            storage.saveRawEmailHeaders('pop3', ...pendingHeaders);
                            pendingHeaders = [];
                        }
                    }

                    if (pendingHeaders.length > 0) {
                        storage.saveRawEmailHeaders('pop3', ...pendingHeaders);
                    }

                    // 尝试关闭连接，但不让QUIT的错误影响整体结果
                    try {
                        await withTimeout(pop3.QUIT(), operationTimeout, 'QUIT');
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
                        logger.warn(
                            `retrying syncPOP3Inbox, attempt ${attempt + 1}/${maxRetries}, delay ${delay}ms, error: ${error.message}`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
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
            logger.error(
                `failed to sync POP3 inbox after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`
            );
            throw lastError || new Error('同步邮件失败');
        })();

        // 为整个同步过程添加超时
        try {
            return await withTimeout(syncPromise, overallTimeout, 'syncPOP3Inbox');
        } catch (error) {
            if (error.message?.includes('超时')) {
                logger.error(`syncPOP3Inbox overall timeout after ${overallTimeout}ms`);
                throw new Error(`同步邮件超时，请检查网络连接或稍后重试`);
            }
            throw error;
        }
    }

    getCurrentStorage() {
        if (!this.currentProfileId) return null;
        return this.storageMap.get(this.currentProfileId);
    }

    getCurrentProfile() {
        if (!this.currentProfileId) return null;
        return this.profileMap.get(this.currentProfileId);
    }

    getCurrentAttachmentDir() {
        if (!this.currentProfileId) return null;
        const safeEmail = this.currentProfileId.replace(/[^a-zA-Z0-9@.-]/g, '_');
        return path.join(this.appDataDirectory, 'attachments', safeEmail);
    }

    async initializeAccount(profile) {
        const email = profile.username;
        // 使用安全的邮件地址作为文件名的一部分，避免特殊字符问题
        const safeEmail = email.replace(/[^a-zA-Z0-9@.-]/g, '_');

        // 每个账号独立数据库
        const dbName = `mailbox_data_${safeEmail}`;
        const dbPath = path.join(this.appDataDirectory, 'db', safeEmail, dbName);

        const storage = new MailboxStorage(dbPath);
        await storage.initialize();

        this.storageMap.set(email, storage);
        this.profileMap.set(email, profile);
        logger.info(`initialized storage for profile: ${email}`);
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

        return retryablePatterns.some((pattern) => errorMessage.includes(pattern));
    }

    notifyEmailListUpdated(profileId) {
        if (this.currentProfileId === profileId) {
            this.emitEvent('emailListUpdated');
        }
    }

    async sync() {
        if (this.profileMap.size === 0) {
            return;
        }

        if (this.isSyncing) {
            logger.info('another syncing process is running, skip');
            return;
        }

        this.isSyncing = true;
        this.syncStatus.isSyncing = true;
        this.syncStatus.syncStartTime = new Date().toISOString();
        this.syncStatus.lastSyncResults = {};
        try {
            for (const [id, profile] of this.profileMap) {
                const storage = this.storageMap.get(id);
                if (!storage) continue;

                this.syncStatus.currentProfileId = id;
                try {
                    logger.info(`starting sync for profile: ${id}`);
                    let newEmailCount = 0;
                    const protocol = this.resolveInboxProtocol(profile);
                    if (protocol === 'imap') {
                        const imapClient = new IMAPEmailClient(
                            profile.username,
                            profile.password,
                            profile.inbox.imap.tls,
                            profile.inbox.imap.host,
                            profile.inbox.imap.port
                        );
                        newEmailCount = await imapClient.syncAll(
                            storage,
                            this.imapBoxCache,
                            this.isRetryableError.bind(this)
                        );
                    } else if (protocol === 'pop3') {
                        newEmailCount = await this.syncPOP3Inbox(profile, storage);
                    } else {
                        logger.warn(`no valid inbox protocol configured for profile: ${id}`);
                    }
                    if (newEmailCount > 0) {
                        // 只有当 isMailboxOpened 为true且currentProfileId = id 时，才认为用户正在查看该账号，不增加计数
                        const isViewingThisAccount = this.isMailboxOpened === true && this.currentProfileId === id;
                        if (!isViewingThisAccount) {
                            const currentNewCount = this.newEmailCounts.get(id) || 0;
                            this.newEmailCounts.set(id, currentNewCount + newEmailCount);
                            this.emitEvent('newEmailCountsUpdated', this.getAllNewEmailCounts());
                        }
                        this.notifyEmailListUpdated(id);
                    }
                    this.syncStatus.lastSyncResults[id] = {
                        status: 'success',
                        newEmailCount,
                        protocol: this.resolveInboxProtocol(profile)
                    };
                } catch (accError) {
                    logger.error(`error syncing profile ${id}: ${accError.message}`);
                    this.syncStatus.lastSyncResults[id] = {
                        status: 'error',
                        error: accError.message
                    };
                    NotificationManager.getInstance().error(
                        '邮箱',
                        '收取新邮件',
                        `账号 ${id} 同步失败: ${accError.message}`
                    );
                }
            }
            logger.info('all mailboxes sync completed');
            this.syncStatus.lastSyncTime = new Date().toISOString();
        } catch (error) {
            logger.error(`error syncing mailbox: ${error.message}`);
        } finally {
            this.isSyncing = false;
            this.syncStatus.isSyncing = false;
            this.syncStatus.currentProfileId = null;
            this.syncStatus.syncStartTime = null;
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
        await this.sync();
    }

    async getSyncStatus() {
        const accounts = [];
        for (const [id, profile] of this.profileMap) {
            const result = this.syncStatus.lastSyncResults[id];
            accounts.push({
                email: id,
                protocol: this.resolveInboxProtocol(profile),
                lastSyncResult: result || null
            });
        }
        return {
            isSyncing: this.syncStatus.isSyncing,
            currentSyncingAccount: this.syncStatus.currentProfileId,
            syncStartTime: this.syncStatus.syncStartTime,
            lastSyncTime: this.syncStatus.lastSyncTime,
            accounts
        };
    }

    async verifyAccount(config) {
        const { email, protocol, imap, pop3, smtp, password, authUsername } = config;
        const username = authUsername || email;
        const results = { inbox: null, smtp: null };

        if (protocol === 'imap' && imap) {
            try {
                const imapClient = new IMAPEmailClient(username, password, imap.tls, imap.host, imap.port);
                const imapConn = imapClient.createImap();
                await withTimeout(imapClient.connect(imapConn, 'IMAP verify'), 30000, 'IMAP verify');
                await imapClient.end(imapConn);
                results.inbox = { status: 'success', protocol: 'imap' };
            } catch (err) {
                results.inbox = { status: 'error', protocol: 'imap', error: err.message };
            }
        } else if (protocol === 'pop3' && pop3) {
            try {
                const pop3Client = new POP3EmailClient(username, password, pop3.tls, pop3.host, pop3.port);
                const pop3Conn = pop3Client.pop3();
                await withTimeout(pop3Conn._connect(), 15000, 'POP3 verify');
                await withTimeout(pop3Conn.QUIT(), 10000, 'POP3 QUIT');
                results.inbox = { status: 'success', protocol: 'pop3' };
            } catch (err) {
                results.inbox = { status: 'error', protocol: 'pop3', error: err.message };
            }
        }

        if (smtp) {
            try {
                const transporter = nodemailer.createTransport({
                    host: smtp.host,
                    port: smtp.port,
                    secure: smtp.tls && smtp.port === 465,
                    auth: { user: username, pass: password },
                    tls: { rejectUnauthorized: false },
                    connectionTimeout: 15000,
                    greetingTimeout: 10000
                });
                await transporter.verify();
                transporter.close();
                results.smtp = { status: 'success' };
            } catch (err) {
                results.smtp = { status: 'error', error: err.message };
            }
        }

        return results;
    }

    // ====== 给前端调用：获取账号列表 ======
    async getAccountList() {
        const accounts = [];
        for (const [id, profile] of this.profileMap) {
            accounts.push({
                email: id, // 这里对应前端的 email 字段
                name: profile.name || id,
                active: id === this.currentProfileId
            });
        }
        return accounts;
    }

    async switchAccount(email) {
        if (!this.storageMap.has(email)) {
            await this.reloadProfilesFromConfig();
            if (!this.storageMap.has(email)) {
                throw new Error(`Profile ${email} not found`);
            }
        }
        this.currentProfileId = email;
        // 清除该账号的新邮件标记（用户已进入邮件应用并切换到此账号）
        // 无论之前是否是不同的账号，都清除新邮件标记
        this.clearNewEmailCount(email);
        return true;
    }

    notifyMailboxClosed() {
        this.isMailboxOpened = false;
    }

    notifyMailboxOpened() {
        this.isMailboxOpened = true;
        this.clearNewEmailCount(this.currentProfileId);
    }

    async reloadProfilesFromConfig() {
        if (!this.config) {
            logger.warn('mailbox service not configured');
            this.profileMap.clear();
            this.storageMap.clear();
            this.currentProfileId = null;
            this.imapBoxCache.clear();
            this.emitEvent('accountsUpdated', []);
            return;
        }

        logger.info(`Reloading mailbox profiles...`);

        let profiles = [];
        let configCurrentProfileId = null;

        if (this.config.profiles && Array.isArray(this.config.profiles)) {
            profiles = this.config.profiles;
            configCurrentProfileId = this.config.currentProfileId;
        } else if (this.config.username) {
            logger.info('detect legacy single-account config, adapting...');
            profiles = [this.config];
        }

        const validUsernamesInConfig = new Set();
        for (const p of profiles) {
            try {
                const parsedProfile = EmailProfileSchema.parse(p);
                validUsernamesInConfig.add(parsedProfile.username);

                if (!this.storageMap.has(parsedProfile.username)) {
                    await this.initializeAccount(parsedProfile);
                } else {
                    this.profileMap.set(parsedProfile.username, parsedProfile);
                }
            } catch (e) {
                logger.error(`failed to initialize profile: ${e}`);
            }
        }

        for (const existingUsername of this.profileMap.keys()) {
            if (!validUsernamesInConfig.has(existingUsername)) {
                logger.info(`Profile removed from config, cleaning up: ${existingUsername}`);
                this.profileMap.delete(existingUsername);
                this.storageMap.delete(existingUsername);
                this.imapBoxCache.delete(existingUsername);
            }
        }

        if (this.currentProfileId && !this.profileMap.has(this.currentProfileId)) {
            logger.warn(`Current profile ${this.currentProfileId} was removed, switching context...`);
            this.currentProfileId = null;
        }

        if (!this.currentProfileId) {
            if (configCurrentProfileId && this.storageMap.has(configCurrentProfileId)) {
                this.currentProfileId = configCurrentProfileId;
            } else if (this.profileMap.size > 0) {
                this.currentProfileId = this.profileMap.keys().next().value;
            }
        }

        this.emitEvent('accountsUpdated', await this.getAccountList());
        logger.info(
            `mailbox initialized/reloaded with ${this.profileMap.size} profiles. Current: ${this.currentProfileId}`
        );
    }

    async initialize() {
        await this.runSequentially(async () => {
            await this.reloadProfilesFromConfig();
        });
        setTimeout(async () => {
            await this.trySync();
            setInterval(
                async () => {
                    await this.trySync();
                },
                1000 * 60 * 5
            );
        }, 1000 * 5);
    }

    async applicationConfigChanged(config) {
        super.applicationConfigChanged(config);
        await this.runSequentially(async () => {
            await this.reloadProfilesFromConfig();
        });
        this.trySync();
    }

    async getEmailHeaderList(offset = 0, pageSize = 20) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (!storage || !profile) return [];

        const protocol = this.resolveInboxProtocol(profile);
        const startTime = Date.now();
        const result = await storage.getEmailHeaderList(protocol, offset, pageSize);
        const cost = (Date.now() - startTime) / 1000;
        logger.info(`get email list cost: ${cost.toFixed(2)}s`);
        return result;
    }

    async searchEmails(query) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (!storage || !profile) return [];

        const protocol = this.resolveInboxProtocol(profile);
        const startTime = Date.now();
        const result = await storage.searchEmails(protocol, query);
        const cost = (Date.now() - startTime) / 1000;
        logger.info(`search emails cost: ${cost.toFixed(2)}s, found ${result.length} results`);
        return result;
    }

    async markEmailAsRead(uid) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (storage) await storage.markEmailAsRead(uid);
        const protocol = this.resolveInboxProtocol(profile);
        if (storage && protocol === 'imap') {
            const meta = await storage.getEmailMeta(uid);
            if (meta?.imapUid && meta?.imapBox) {
                const imapClient = new IMAPEmailClient(
                    profile.username,
                    profile.password,
                    profile.inbox.imap.tls,
                    profile.inbox.imap.host,
                    profile.inbox.imap.port
                );
                await imapClient.updateSeen(meta.imapBox, meta.imapUid, true);
            }
        }
    }

    async markEmailAsUnread(uid) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (storage) await storage.markEmailAsUnread(uid);
        const protocol = this.resolveInboxProtocol(profile);
        if (storage && protocol === 'imap') {
            const meta = await storage.getEmailMeta(uid);
            if (meta?.imapUid && meta?.imapBox) {
                const imapClient = new IMAPEmailClient(
                    profile.username,
                    profile.password,
                    profile.inbox.imap.tls,
                    profile.inbox.imap.host,
                    profile.inbox.imap.port
                );
                await imapClient.updateSeen(meta.imapBox, meta.imapUid, false);
            }
        }
    }

    async deleteEmail(uid) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (storage) await storage.deleteEmail(uid);
        const protocol = this.resolveInboxProtocol(profile);
        if (storage && protocol === 'imap') {
            const meta = await storage.getEmailMeta(uid);
            if (meta?.imapUid && meta?.imapBox) {
                const imapClient = new IMAPEmailClient(
                    profile.username,
                    profile.password,
                    profile.inbox.imap.tls,
                    profile.inbox.imap.host,
                    profile.inbox.imap.port
                );
                const boxMap = await imapClient.resolveBoxMap(this.imapBoxCache);
                await imapClient.deleteMessage(meta.imapBox, meta.imapUid, boxMap?.trash);
            }
        }
    }

    getNewEmailCount(username) {
        return this.newEmailCounts.get(username) || 0;
    }

    getAllNewEmailCounts() {
        const counts = {};
        for (const [username, _] of this.profileMap) {
            counts[username] = this.getNewEmailCount(username);
        }
        return counts;
    }

    clearNewEmailCount(username) {
        // 无论该账号是否在 Map 中，都设置为 0（确保清除标记）
        this.newEmailCounts.set(username, 0);
        // 无论之前是否有数量，都通知前端更新标记（确保标记被清除）
        const allCounts = this.getAllNewEmailCounts();
        this.emitEvent('newEmailCountsUpdated', allCounts);
    }

    async getEmailContent(uid) {
        logger.info(`getting email content: ${uid}`);
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (!storage || !profile) return null;

        const cachedContent = await storage.getEmailContent(uid);
        if (cachedContent) {
            return cachedContent;
        }

        const meta = await storage.getEmailMeta(uid);

        const protocol = this.resolveInboxProtocol(profile);
        if (protocol === 'imap' && meta?.imapUid && meta?.imapBox) {
            const maxRetries = 2;
            let lastError = null;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const imapClient = new IMAPEmailClient(
                        profile.username,
                        profile.password,
                        profile.inbox.imap.tls,
                        profile.inbox.imap.host,
                        profile.inbox.imap.port
                    );
                    const attachmentDir = this.getCurrentAttachmentDir();
                    const result = await withTimeout(
                        imapClient.getEmailContent(uid, meta.imapBox, meta.imapUid, attachmentDir),
                        120000,
                        `getEmailContent(IMAP:${uid})`
                    );
                    if (!result) {
                        if (attempt === 0) {
                            logger.error(`failed to get email content from IMAP server: ${uid}`);
                        }
                        throw new Error(`无法获取邮件内容: ${uid}`);
                    }
                    await storage.saveEmailContent(uid, result);
                    return result;
                } catch (error) {
                    lastError = error;
                    const shouldRetry = attempt < maxRetries && this.isRetryableError(error);
                    if (shouldRetry) {
                        const delay = (attempt + 1) * 1000;
                        logger.warn(
                            `retrying getEmailContent(IMAP) for ${uid}, attempt ${attempt + 1}/${maxRetries + 1}, delay ${delay}ms`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
                    } else {
                        break;
                    }
                }
            }

            logger.error(`failed to get email content from IMAP server after ${maxRetries + 1} attempts: ${uid}`);
            throw lastError || new Error(`无法获取邮件内容: ${uid}`);
        } else if (protocol === 'pop3') {
            // 重试机制：对于概率性错误（如网络问题、超时等）进行重试
            const maxRetries = 2;
            let lastError = null;

            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                try {
                    const pop3 = new POP3EmailClient(
                        profile.username,
                        profile.password,
                        profile.inbox.pop3.tls,
                        profile.inbox.pop3.host,
                        profile.inbox.pop3.port
                    );
                    const attachmentDir = this.getCurrentAttachmentDir();
                    // 为获取邮件内容添加整体超时（2分钟）
                    const result = await withTimeout(
                        pop3.getEmailContent(uid, attachmentDir),
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
                    await storage.saveEmailContent(uid, result);
                    return result;
                } catch (error) {
                    lastError = error;
                    // 判断是否应该重试：网络错误、超时错误、AggregateError 等
                    const shouldRetry =
                        attempt < maxRetries &&
                        (error instanceof AggregateError ||
                            error.message?.includes('timeout') ||
                            error.message?.includes('ECONNRESET') ||
                            error.message?.includes('ETIMEDOUT') ||
                            error.message?.includes('ENOTFOUND') ||
                            error.message?.includes('网络') ||
                            error.message?.includes('连接'));

                    if (shouldRetry) {
                        const delay = (attempt + 1) * 1000; // 递增延迟：1s, 2s
                        logger.warn(
                            `retrying getEmailContent for ${uid}, attempt ${attempt + 1}/${maxRetries + 1}, delay ${delay}ms`
                        );
                        await new Promise((resolve) => setTimeout(resolve, delay));
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
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();

        if (!storage || !profile) throw new Error('No active profile');

        const meta = await storage.getEmailMeta(uid);
        const protocol = this.resolveInboxProtocol(profile);

        if (protocol === 'imap' && meta?.imapUid && meta?.imapBox) {
            const imapClient = new IMAPEmailClient(
                profile.username,
                profile.password,
                profile.inbox.imap.tls,
                profile.inbox.imap.host,
                profile.inbox.imap.port
            );
            const attachmentDir = this.getCurrentAttachmentDir();
            const result = await imapClient.getEmail(uid, meta.imapBox, meta.imapUid, attachmentDir);
            if (!result) throw new Error('无法通过IMAP重新下载邮件');
            const { header, content } = result;
            await storage.saveEmailContent(uid, content);
            await storage.saveEmailHeader(header);
            return content;
        } else if (protocol === 'pop3') {
            const pop3 = new POP3EmailClient(
                profile.username,
                profile.password,
                profile.inbox.pop3.tls,
                profile.inbox.pop3.host,
                profile.inbox.pop3.port
            );
            const attachmentDir = this.getCurrentAttachmentDir();
            const { header, content } = await pop3.getEmail(uid, attachmentDir);
            await storage.saveEmailContent(uid, content);
            await storage.saveEmailHeader(header);
            return content;
        } else {
            throw new Error('no valid inbox server configured');
        }
    }

    async starEmail(starOptions) {
        const storage = this.getCurrentStorage();
        if (storage) await storage.starEmail(starOptions.uid, starOptions.starred);
    }

    async sendEmail(sendEmailSchema) {
        logger.info(`sendEmail to ${sendEmailSchema.to}`);
        const profile = this.getCurrentProfile();
        const storage = this.getCurrentStorage();
        if (!profile) throw new Error('No active profile');

        if (profile.outbox?.smtp) {
            const smtpAccount = profile.outbox.smtp.account ? profile.outbox.smtp.account : profile.username;
            const attachments = Array.isArray(sendEmailSchema.attachments) ? sendEmailSchema.attachments : [];
            let text = typeof sendEmailSchema.text === 'string' ? sendEmailSchema.text : '';
            let html = typeof sendEmailSchema.html === 'string' ? sendEmailSchema.html : '';
            // Avoid clients treating text attachments as body when body is empty.
            if (attachments.length > 0 && text.trim() === '' && html.trim() === '') {
                text = ' ';
                html = '<p>&nbsp;</p>';
            }
            const smtp = new SmtpEmailClient(
                smtpAccount,
                profile.username,
                profile.password,
                profile.name,
                profile.outbox.smtp.host,
                profile.outbox.smtp.port,
                profile.outbox.smtp.tls
            );
            const sentUid = `sent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const draftUid =
                sendEmailSchema.draftUid || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const messageId =
                sendEmailSchema.messageId ||
                `<fillipdesk-${Date.now()}-${Math.random().toString(36).slice(2)}@fillipdesk>`;

            const sentHeaders = { 'X-Fillipdesk-UID': sentUid };
            const sentMailOptions = {
                from: `"${profile.name}" <${smtpAccount}>`,
                to: Array.isArray(sendEmailSchema.to) ? sendEmailSchema.to.join(', ') : sendEmailSchema.to,
                cc: Array.isArray(sendEmailSchema.cc) ? sendEmailSchema.cc.join(', ') : sendEmailSchema.cc,
                bcc: Array.isArray(sendEmailSchema.bcc) ? sendEmailSchema.bcc.join(', ') : sendEmailSchema.bcc,
                subject: sendEmailSchema.subject,
                text: text,
                html: html,
                attachments: attachments,
                messageId: messageId,
                headers: sentHeaders
            };

            // 增加发送邮件的超时时间到 5 分钟
            const sendTimeout = 5 * 60 * 1000; // 5分钟
            const result = await withTimeout(smtp.sendMailWithOptions(sentMailOptions), sendTimeout, 'SMTP send email');

            if (result && storage) {
                // 发送成功后保存到已发送
                const emailHeader = {
                    subject: sendEmailSchema.subject,
                    from: [{ name: profile.name, address: profile.username }],
                    to: Array.isArray(sendEmailSchema.to)
                        ? sendEmailSchema.to.map((addr) => ({ name: '', address: addr }))
                        : [{ name: '', address: sendEmailSchema.to }],
                    cc: Array.isArray(sendEmailSchema.cc)
                        ? sendEmailSchema.cc.map((addr) => ({ name: '', address: addr }))
                        : sendEmailSchema.cc
                          ? [{ name: '', address: sendEmailSchema.cc }]
                          : [],
                    bcc: Array.isArray(sendEmailSchema.bcc)
                        ? sendEmailSchema.bcc.map((addr) => ({ name: '', address: addr }))
                        : sendEmailSchema.bcc
                          ? [{ name: '', address: sendEmailSchema.bcc }]
                          : []
                };
                emailHeader.messageId = messageId;
                const emailContent = {
                    htmlContent: html,
                    textContent: text,
                    attachments: attachments
                };
                const protocol = this.resolveInboxProtocol(profile);
                await storage.saveSentEmail(sentUid, emailHeader, emailContent, protocol);

                if (protocol === 'imap') {
                    try {
                        const imapClient = new IMAPEmailClient(
                            profile.username,
                            profile.password,
                            profile.inbox.imap.tls,
                            profile.inbox.imap.host,
                            profile.inbox.imap.port
                        );
                        const boxMap = await imapClient.resolveBoxMap(this.imapBoxCache);
                        if (boxMap?.sent) {
                            const rawMessage = await IMAPEmailClient.buildRawEmailMessage(sentMailOptions);
                            await imapClient.appendMessage(boxMap.sent, rawMessage, ['\\Seen']);
                        }
                    } catch (e) {
                        logger.warn(`failed to append sent mail to IMAP: ${e.message}`);
                    }
                }
            } else if (!result && storage) {
                // 发送失败，保存到草稿箱
                const draftHeaders = { 'X-Fillipdesk-UID': draftUid };
                const emailHeader = {
                    subject: sendEmailSchema.subject,
                    from: [{ name: profile.name, address: profile.username }],
                    to: Array.isArray(sendEmailSchema.to)
                        ? sendEmailSchema.to.map((addr) => ({ name: '', address: addr }))
                        : sendEmailSchema.to
                          ? [{ name: '', address: sendEmailSchema.to }]
                          : [],
                    cc: Array.isArray(sendEmailSchema.cc)
                        ? sendEmailSchema.cc.map((addr) => ({ name: '', address: addr }))
                        : sendEmailSchema.cc
                          ? [{ name: '', address: sendEmailSchema.cc }]
                          : [],
                    bcc: Array.isArray(sendEmailSchema.bcc)
                        ? sendEmailSchema.bcc.map((addr) => ({ name: '', address: addr }))
                        : sendEmailSchema.bcc
                          ? [{ name: '', address: sendEmailSchema.bcc }]
                          : []
                };
                emailHeader.messageId = messageId;
                const emailContent = {
                    htmlContent: html,
                    textContent: text,
                    attachments: attachments
                };
                const protocol = this.resolveInboxProtocol(profile);
                await storage.saveDraft(draftUid, emailHeader, emailContent, protocol);
                logger.info(`email send failed, saved to drafts: ${draftUid}`);

                if (this.resolveInboxProtocol(profile) === 'imap') {
                    try {
                        const imapClient = new IMAPEmailClient(
                            profile.username,
                            profile.password,
                            profile.inbox.imap.tls,
                            profile.inbox.imap.host,
                            profile.inbox.imap.port
                        );
                        const boxMap = await imapClient.resolveBoxMap(this.imapBoxCache);
                        if (boxMap?.drafts) {
                            const draftMailOptions = {
                                ...sentMailOptions,
                                headers: draftHeaders
                            };
                            IMAPEmailClient.applyDraftEnvelope(draftMailOptions, profile.username);
                            const rawMessage = await IMAPEmailClient.buildRawEmailMessage(draftMailOptions);
                            await imapClient.appendMessage(boxMap.drafts, rawMessage, ['\\Draft']);
                        }
                    } catch (e) {
                        logger.warn(`failed to append draft mail to IMAP: ${e.message}`);
                    }
                }
            }

            return result;
        } else {
            logger.error(`no valid outbox server configured`);
            throw new Error('no valid outbox server configured');
        }
    }

    async saveDraft(draftSchema) {
        logger.info(`saveDraft: ${draftSchema.subject}`);
        const profile = this.getCurrentProfile();
        const storage = this.getCurrentStorage();
        if (!profile || !storage) throw new Error('No active profile');

        const uid = draftSchema.uid || `draft_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const messageId = draftSchema.messageId || `<fillipdesk-${uid}@fillipdesk>`;
        const emailHeader = {
            subject: draftSchema.subject,
            from: [{ name: profile.name, address: profile.username }],
            to: Array.isArray(draftSchema.to)
                ? draftSchema.to.map((addr) => ({ name: '', address: addr }))
                : draftSchema.to
                  ? [{ name: '', address: draftSchema.to }]
                  : [],
            cc: Array.isArray(draftSchema.cc)
                ? draftSchema.cc.map((addr) => ({ name: '', address: addr }))
                : draftSchema.cc
                  ? [{ name: '', address: draftSchema.cc }]
                  : [],
            bcc: Array.isArray(draftSchema.bcc)
                ? draftSchema.bcc.map((addr) => ({ name: '', address: addr }))
                : draftSchema.bcc
                  ? [{ name: '', address: draftSchema.bcc }]
                  : []
        };
        emailHeader.messageId = messageId;
        const emailContent = {
            htmlContent: draftSchema.html,
            textContent: draftSchema.text,
            attachments: draftSchema.attachments || []
        };
        const protocol = this.resolveInboxProtocol(profile);
        await storage.saveDraft(uid, emailHeader, emailContent, protocol);

        if (protocol === 'imap') {
            try {
                const imapClient = new IMAPEmailClient(
                    profile.username,
                    profile.password,
                    profile.inbox.imap.tls,
                    profile.inbox.imap.host,
                    profile.inbox.imap.port
                );
                const boxMap = await imapClient.resolveBoxMap(this.imapBoxCache);
                if (boxMap?.drafts) {
                    const smtpAccount = profile.outbox?.smtp?.account ? profile.outbox.smtp.account : profile.username;
                    const mailOptions = {
                        from: `"${profile.name}" <${smtpAccount}>`,
                        to: Array.isArray(draftSchema.to) ? draftSchema.to.join(', ') : draftSchema.to,
                        cc: Array.isArray(draftSchema.cc) ? draftSchema.cc.join(', ') : draftSchema.cc,
                        bcc: Array.isArray(draftSchema.bcc) ? draftSchema.bcc.join(', ') : draftSchema.bcc,
                        subject: draftSchema.subject,
                        text: draftSchema.text,
                        html: draftSchema.html,
                        attachments: draftSchema.attachments,
                        messageId: messageId,
                        headers: { 'X-Fillipdesk-UID': uid }
                    };
                    IMAPEmailClient.applyDraftEnvelope(mailOptions, profile.username);
                    const rawMessage = await IMAPEmailClient.buildRawEmailMessage(mailOptions);
                    await imapClient.appendMessage(boxMap.drafts, rawMessage, ['\\Draft']);
                }
            } catch (e) {
                logger.warn(`failed to append draft to IMAP: ${e.message}`);
            }
        }

        return uid;
    }

    async getDraftList(offset = 0, pageSize = 20) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (!storage || !profile) return [];
        const protocol = this.resolveInboxProtocol(profile);
        return await storage.getDraftList(protocol, offset, pageSize);
    }

    async getSentList(offset = 0, pageSize = 20) {
        const storage = this.getCurrentStorage();
        const profile = this.getCurrentProfile();
        if (!storage || !profile) return [];
        const protocol = this.resolveInboxProtocol(profile);
        return await storage.getSentList(protocol, offset, pageSize);
    }

    async deleteDraft(uid) {
        const storage = this.getCurrentStorage();
        if (!storage) throw new Error('No active profile');
        await storage.deleteDraft(uid);
    }

    async getEmailMeta(uid) {
        const storage = this.getCurrentStorage();
        if (!storage) throw new Error('No active profile');
        return await storage.getEmailMeta(uid);
    }

    async saveAttachmentFile(sourcePath, destinationPath) {
        return await copyAttachmentFile(sourcePath, destinationPath);
    }

    async saveAllAttachmentFiles(attachments, destinationDirectory) {
        return await copyAllAttachmentFiles(attachments, destinationDirectory);
    }
}

export default MailboxWorker;
