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
        host: z.string().default(''),
        tls: z.boolean().default(true),
        port: z.number().default(587),
    }).optional(),
});

const EmailProfileSchema = z.object({
    name: z.string().default(''),
    inbox: InboxServerSchema.optional(),
    outbox: OutboxServerSchema.optional(),
    username: z.string().default(''),
    password: z.string().default(''),
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
     * @param {string} messageId - The message id of the email
     * @param {string[]} relatedMessageIds - The related message ids of the email
     * @param {Date} date - The date of the email
     */
    constructor(uid, subject, from, to, date) {
        this.uid = uid;
        this.subject = subject;
        this.from = from;
        this.to = to;
        this.date = date;
        this.unread = true;
    }
}

class EmailContent {
    constructor(htmlContent, textContent) {
        this.htmlContent = htmlContent;
        this.textContent = textContent;
    }
}

export {
    EmailHeader,
    EmailContent,
    EmailProfileSchema,
    InboxServerSchema,
    OutboxServerSchema,
};