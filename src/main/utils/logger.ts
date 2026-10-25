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
import fs from 'fs';
import winston from 'winston';
import Transport from 'winston-transport';

let debugMode: boolean = false;

export function setDebugMode(_debugMode: boolean) {
    debugMode = _debugMode;
    // winston 级别跟随 debugMode：logger.debug 的日志仅在调试模式开启时落盘，
    // 默认 info 级别下被过滤，避免诊断类 debug 日志刷屏
    if (loggerInstance) {
        loggerInstance.level = _debugMode ? 'debug' : 'info';
    }
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
    /**
     * 内存缓冲上限。主进程每条日志都会进入 content/entries 缓冲区（供设置页日志
     * 查看器与导出使用），若无上限，长跑场景（如 LLM Raw 响应高频日志）会无界
     * 累积直至 V8 堆耗尽（OOM）。超过上限后丢弃最旧日志，只保留最近窗口。
     */
    static readonly maxEntries = 2000;
    static readonly maxContentBytes = 2 * 1024 * 1024;
    static readonly maxLineLength = 16 * 1024;
    private static readonly truncatedSuffix = '…[truncated]';

    content: string = '';
    entries: LogEntry[] = [];
    static globalStream: LogStream | null = null;

    _write(chunk: string | Buffer, encoding: string, callback: () => void) {
        const raw = typeof chunk === 'string' ? chunk : chunk.toString();
        // 单条超长日志截断，防止一次性写入撑大缓冲区
        const capped =
            raw.length > LogStream.maxLineLength
                ? raw.slice(0, LogStream.maxLineLength - LogStream.truncatedSuffix.length) +
                  LogStream.truncatedSuffix +
                  '\n'
                : raw;
        this.content += capped;
        const lines = capped.split('\n').filter((l: string) => l.trim().length > 0);
        for (const line of lines) {
            this.entries.push(parseLogLine(line));
        }
        this.trim();
        callback();
    }

    /**
     * 丢弃最旧日志：entries 按条数、content 按字节各自收敛到上限内。
     * 采用高水位淘汰——触发上限后一次性裁剪到上限的一半，避免逐行
     * slice 带来的大字符串反复拷贝。
     */
    private trim(): void {
        if (this.entries.length > LogStream.maxEntries) {
            this.entries = this.entries.slice(this.entries.length - LogStream.maxEntries / 2);
        }
        if (this.content.length > LogStream.maxContentBytes) {
            const keepFrom = Math.max(0, this.content.length - LogStream.maxContentBytes / 2);
            const newline = this.content.indexOf('\n', keepFrom);
            this.content = newline >= 0 ? this.content.slice(newline + 1) : '';
        }
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
let fileTransport: Transport | null = null;
let fileTransportFilename: string | undefined;

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

function getLogFilename(): string {
    const date = new Date().toISOString().slice(0, 10);
    return `app-${date}.log`;
}

function getCurrentLogFilePath(): string {
    return path.join(getLogDirectory(), getLogFilename());
}

/**
 * 文件 transport 的懒激活门卫：import logger 不得打开任何日志文件，否则纯构建
 * 脚本/CLI 工具链经 import 链加载 logger 就会触碰 ~/.opendesk/logs，在动态沙箱
 * 下演变成无意义的权限弹窗。真正写下第一条日志时才创建并挂载文件 transport，
 * 转发本条日志后自移除，此后日志由挂载的真实 File transport 承载。
 */
class LazyFileTransport extends Transport {
    private activated = false;

    log(info: any, callback: () => void) {
        if (this.activated) {
            callback();
            return;
        }
        this.activated = true;
        const target = ensureFileTransport();
        target.log(info, callback);
        // 延迟到下一个 tick 自移除：winston 正在本条日志的分发过程中遍历
        // transports，同步增删数组可能跳过后续 transport
        setImmediate(() => {
            loggerInstance?.remove(this);
        });
    }
}

/**
 * 确保文件 transport 存在且指向当前日期与日志目录；跨天或日志目录变更时
 * 关闭旧的并重建。只在真正产生日志时被调用（懒激活/显式 reload）。
 */
function ensureFileTransport(): Transport {
    const nextFilename = getCurrentLogFilePath();
    if (fileTransport && fileTransportFilename === nextFilename) {
        return fileTransport;
    }

    const previous = fileTransport;
    fileTransportFilename = nextFilename;
    fileTransport = new winston.transports.File({ filename: nextFilename });
    if (previous) {
        loggerInstance?.remove(previous);
        (previous as { close?: () => void }).close?.();
    }
    loggerInstance?.add(fileTransport);
    return fileTransport;
}

function reloadLoggerFileTransport(): string {
    const nextFilename = getCurrentLogFilePath();
    if (!loggerInstance || !fileTransport) {
        // 文件 transport 尚未懒激活：首次写日志时会按最新目录创建，此处保持零副作用
        return nextFilename;
    }
    ensureFileTransport();
    return nextFilename;
}

function createLogger() {
    const transports: Transport[] = [];
    transports.push(new LazyFileTransport());

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

const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;

async function dropDeprecatedLogs(): Promise<void> {
    try {
        const logDir = getLogDirectory();
        const entries = await fs.promises.readdir(logDir, { withFileTypes: true });
        const now = Date.now();
        const logPattern = /^app-\d{4}-\d{2}-\d{2}\.log$/;

        for (const entry of entries) {
            if (!entry.isFile() || !logPattern.test(entry.name)) {
                continue;
            }
            try {
                const fullPath = path.join(logDir, entry.name);
                const stat = await fs.promises.stat(fullPath);
                if (now - stat.mtimeMs > ONE_WEEK_MS) {
                    await fs.promises.unlink(fullPath);
                }
            } catch {
                // 单个文件操作失败不影响其他文件的清理
            }
        }
    } catch {
        // 目录读取失败静默忽略，不拖慢启动
    }
}

const logger = createLogger();

export { logger, LogStream, dropDeprecatedLogs, getLogFilename, reloadLoggerFileTransport };
