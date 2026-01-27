import { z } from 'zod';

const InboxServerSchema = z.object({
    pop3: z.object({
        host: z.string().default(''),
        tls: z.boolean().default(true),
        port: z.number().default(995),
    }).optional(),
    imap: z.object({
        host: z.string().default(''),
        tls: z.boolean().default(true),
        port: z.number().default(993),
    }).optional(),
});

const OutboxServerSchema = z.object({
    smtp: z.object({
        account: z.string().default(''),
        host: z.string().default(''),
        tls: z.boolean().default(true),
        port: z.number().default(587),
    }).optional(),
});

// 单个账号的配置
const EmailProfileSchema = z.object({
    name: z.string().default(''),
    username: z.string().default(''),
    password: z.string().default(''),
    inbox: InboxServerSchema.optional(),
    outbox: OutboxServerSchema.optional(),
});

// 【核心修改】应用层级配置，包含 profiles 数组
const MailboxConfigSchema = z.object({
    currentProfileId: z.string().optional(),
    profiles: z.array(EmailProfileSchema).default([]),
});

const EmailHeaderQuerySchema = z.object({
    from: z.string().optional(),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    startDate: z.string().describe('开始日期，格式为YYYY-MM-DD').optional(),
    endDate: z.string().describe('结束日期，格式为YYYY-MM-DD').optional(),
    limit: z.number().describe('限制返回的邮件数量').optional(),
    offset: z.number().describe('偏移量').optional(),
});

const sendEmailSchema = z.object({
    to: z.string().optional(),
    cc: z.string().default(''),
    bcc: z.string().default(''),
    subject: z.string().default(''),
    text: z.string().default(''),
    html: z.string().default(''),
    attachments: z.array(z.string()).default([]),
});

class EmailAddress {
    constructor(name, address) {
        this.name = name;
        this.address = address;
    }
}

class EmailHeader {
    /**
     * Create a new email object
     * @param {string} uid - The unique identifier of the email
     * @param {string} subject - The subject of the email
     * @param {EmailAddress[]} from - The sender of the email
     * @param {EmailAddress[]} to - The recipient of the email
     * @param {EmailAddress[]} cc - The cc recipient of the email
     * @param {EmailAddress[]} bcc - The bcc recipient of the email
     * @param {Date} date - The date of the email
     */
    constructor(uid, subject, from, to, cc, bcc, date, unread = true, starred = false, deleted = false) {
        this.uid = uid;
        this.subject = subject;
        this.from = from;
        this.to = to;
        this.cc = cc;
        this.bcc = bcc;
        this.date = date;
        this.unread = unread;
        this.starred = starred;
        this.deleted = deleted
    }
}

class EmailAttachment {
    constructor(filename, path) {
        this.filename = filename;
        this.path = path;
    }
}

class EmailContent {
    constructor(htmlContent, textContent, attachments) {
        this.htmlContent = htmlContent;
        this.textContent = textContent;
        this.attachments = attachments;
    }
}

export {
    EmailHeader,
    EmailContent,
    EmailAttachment,
    EmailProfileSchema,
    MailboxConfigSchema, // 导出这个新的 Schema
    InboxServerSchema,
    OutboxServerSchema,
    sendEmailSchema,
};