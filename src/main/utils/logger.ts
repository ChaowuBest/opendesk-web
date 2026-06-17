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

import { getLogDirectory } from './setting.js';
import { Writable } from 'stream';
import { isMainThread, parentPort } from 'worker_threads';
import { addLine } from './cliLogStore.js';
import path from 'path';
import winston from 'winston';
import Transport from 'winston-transport';

let debugMode: boolean = false;

export function setDebugMode(_debugMode: boolean) {
    debugMode = _debugMode;
}

export function getDebugMode() {
    return debugMode;
}

// 统一的日志格式化函数
const logFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf((info) => `[${info.timestamp} | ${info.level}] ${info.stack || info.message}`)
);

class CliLogTransport extends Transport {
    constructor(opts?: any) {
        super(opts);
    }

    log(info: any, callback: () => void) {
        setImmediate(() => this.emit('logged', info));

        // 直接手动格式化消息，不依赖 winston 的 format 链
        let message: string;
        if (info[Symbol.for('message')]) {
            message = info[Symbol.for('message')];
        } else {
            // 手动格式化
            const timestamp = info.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19);
            const level = info.level || 'info';
            const msg = info.stack || info.message || String(info);
            message = `[${timestamp} | ${level}] ${msg}`;
        }

        addLine(message);
        callback();
    }
}

interface LogEntry {
    level: string;
    timestamp: string;
    message: string;
}

const LOG_LINE_REGEX = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s*\|\s*(\S+)\]\s*(.*)$/s;

function stripAnsi(str: string): string {
    return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function parseLogLine(raw: string): LogEntry {
    const cleaned = stripAnsi(raw).trim();
    const m = cleaned.match(LOG_LINE_REGEX);
    if (m) {
        return { timestamp: m[1], level: m[2].toLowerCase(), message: m[3] };
    }
    return { timestamp: '', level: 'info', message: cleaned };
}

function formatLogEntry(entry: LogEntry): string {
    if (entry.timestamp) {
        return `[${entry.timestamp} | ${entry.level}] ${entry.message}`;
    }
    return entry.message;
}

class LogStream extends Writable {
    content: string = '';
    entries: LogEntry[] = [];
    static globalStream: LogStream | null = null;

    _write(chunk: string, encoding: string, callback: () => void) {
        this.content += chunk;
        const raw = typeof chunk === 'string' ? chunk : chunk.toString();
        const lines = raw.split('\n').filter((l: string) => l.trim().length > 0);
        for (const line of lines) {
            this.entries.push(parseLogLine(line));
        }
        callback();
    }

    getContent(): string {
        return this.content;
    }

    getEntries(
        options: {
            offset?: number;
            limit?: number;
            filter?: string;
            level?: string;
        } = {}
    ): { entries: LogEntry[]; total: number; offset: number; hasMore: boolean } {
        const { offset = 0, limit = 100, filter = '', level = '' } = options;
        let filtered: LogEntry[];
        if (level || filter) {
            filtered = this.entries;
            if (level) {
                filtered = filtered.filter((e) => e.level === level);
            }
            if (filter) {
                const kw = filter.toLowerCase();
                filtered = filtered.filter(
                    (e) =>
                        e.message.toLowerCase().includes(kw) ||
                        e.timestamp.toLowerCase().includes(kw) ||
                        e.level.includes(kw)
                );
            }
        } else {
            filtered = this.entries;
        }
        const total = filtered.length;
        const safeOffset = Math.max(0, Math.min(offset, total));
        const slice = filtered.slice(safeOffset, safeOffset + limit);
        return { entries: slice, total, offset: safeOffset, hasMore: safeOffset + limit < total };
    }

    formatEntries(
        options: {
            filter?: string;
            level?: string;
        } = {}
    ): string {
        const { entries } = this.getEntries({
            offset: 0,
            limit: Math.max(this.entries.length, 1),
            filter: options.filter,
            level: options.level
        });
        return entries.length > 0 ? `${entries.map(formatLogEntry).join('\n')}\n` : '';
    }

    static getStream(): LogStream {
        if (this.globalStream === null) {
            this.globalStream = new LogStream();
        }
        return this.globalStream;
    }
}

class WorkerLogTransport extends Transport {
    constructor(opts?: any) {
        super(opts);
    }

    log(info: any, callback: () => void) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        // 格式化消息
        let message: string;
        if (info[Symbol.for('message')]) {
            message = info[Symbol.for('message')];
        } else {
            // 手动格式化
            const timestamp = info.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19);
            const level = info.level || 'info';
            const msg = info.stack || info.message || String(info);
            message = `[${timestamp} | ${level}] ${msg}`;
        }

        // 将日志消息发送到主线程
        parentPort?.postMessage({ type: 'log', message: message });
        callback();
    }
}

// 存储 logger 实例的变量
let loggerInstance: winston.Logger | null = null;

export function useCliTransport() {
    if (loggerInstance) {
        loggerInstance.add(new CliLogTransport());
    }
}

/**
 * 拦截 console.log / console.warn / console.error / console.debug，
 * 将它们全部重定向到 winston logger。
 * 用于 CLI TUI 模式下防止外部插件直接向 stdout 输出破坏界面。
 */
type ConsoleInterceptHook = (level: string, message: string) => void;
const consoleInterceptHooks: ConsoleInterceptHook[] = [];

export function addConsoleInterceptHook(hook: ConsoleInterceptHook) {
    consoleInterceptHooks.push(hook);
}

export function interceptConsole() {
    const stringify = (...args: any[]) =>
        args
            .map((a) => {
                if (typeof a === 'string') return a;
                try {
                    return JSON.stringify(a, null, 2) ?? String(a);
                } catch {
                    return String(a);
                }
            })
            .join(' ');

    const notifyHooks = (level: string, msg: string) => {
        for (const hook of consoleInterceptHooks) {
            try {
                hook(level, msg);
            } catch {
                /* ignore hook errors */
            }
        }
    };

    console.log = (...args: any[]) => {
        const m = stringify(...args);
        logger.info(m);
        notifyHooks('info', m);
    };
    console.warn = (...args: any[]) => {
        const m = stringify(...args);
        logger.warn(m);
        notifyHooks('warn', m);
    };
    console.error = (...args: any[]) => {
        const m = stringify(...args);
        logger.error(m);
        notifyHooks('error', m);
    };
    console.debug = (...args: any[]) => {
        const m = `[debug] ${stringify(...args)}`;
        logger.info(m);
        notifyHooks('debug', m);
    };
    console.info = (...args: any[]) => {
        const m = stringify(...args);
        logger.info(m);
        notifyHooks('info', m);
    };
}

export function useConsoleTransport() {
    if (loggerInstance) {
        loggerInstance.add(new winston.transports.Console());
    }
}

export function useDumpLogTransport(filePath: string) {
    if (loggerInstance) {
        loggerInstance.add(
            new winston.transports.File({
                filename: filePath,
                options: { flags: 'w' }
            })
        );
    }
}

class LogStreamTransport extends Transport {
    constructor(opts?: any) {
        super(opts);
    }

    log(info: any, callback: () => void) {
        let message: string;
        if (info[Symbol.for('message')]) {
            message = info[Symbol.for('message')];
        } else {
            const timestamp = info.timestamp || new Date().toISOString().replace('T', ' ').substring(0, 19);
            const level = info.level || 'info';
            const msg = info.stack || info.message || String(info);
            message = `[${timestamp} | ${level}] ${msg}`;
        }

        LogStream.getStream().write(message + '\n');
        callback();
    }
}

function createLogger() {
    const transports: Transport[] = [];
    transports.push(new winston.transports.File({ filename: path.join(getLogDirectory(), 'app.log') }));

    if (!isMainThread) {
        transports.push(new WorkerLogTransport());
    } else {
        transports.push(new LogStreamTransport());
    }

    loggerInstance = winston.createLogger({
        level: 'info',
        format: logFormat,
        transports: transports
    });

    return loggerInstance;
}

const logger = createLogger();

export { logger, LogStream };
