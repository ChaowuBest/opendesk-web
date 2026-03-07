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


var debugMode: boolean = false;

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
    winston.format.printf(
        (info) =>
            `[${info.timestamp} | ${info.level}] ${info.stack || info.message}`
    )
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

class LogStream extends Writable {

    content: string = '';
    static globalStream: LogStream | null = null;

    _write(chunk: string, encoding: string, callback: () => void) {
        this.content += chunk;
        callback();
    }

    getContent(): string {
        return this.content;
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
export function interceptConsole() {
    const stringify = (...args: any[]) =>
        args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a, null, 2) ?? String(a); }
            catch { return String(a); }
        }).join(' ');

    console.log = (...args: any[]) => { logger.info(stringify(...args)); };
    console.warn = (...args: any[]) => { logger.warn(stringify(...args)); };
    console.error = (...args: any[]) => { logger.error(stringify(...args)); };
    console.debug = (...args: any[]) => { logger.info(`[debug] ${stringify(...args)}`); };
    console.info = (...args: any[]) => { logger.info(stringify(...args)); };
}

export function useConsoleTransport() {
    if (loggerInstance) {
        loggerInstance.add(new winston.transports.Console());
    }
}

function createLogger() {
    var transports: Transport[] = [];
    transports.push(new winston.transports.File({ filename: path.join(getLogDirectory(), 'app.log') }));

    if (!isMainThread) {
        transports.push(new WorkerLogTransport());
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
