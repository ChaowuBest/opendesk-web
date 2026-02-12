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


class CliLogTransport extends Transport {
    log(info: any, callback: () => void) {
        setImmediate(() => this.emit('logged', info));
        const message = info[Symbol.for('message')] ?? info.message ?? String(info);
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
    log(info: any, callback: () => void) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        // 格式化消息 - 使用与主线程相同的格式
        // winston.format.cli() 会在 info 对象上设置 Symbol.for('message')
        const formattedMessage = info[Symbol.for('message')];
        const message = formattedMessage || info.message || JSON.stringify(info);

        // 将日志消息发送到主线程
        parentPort?.postMessage({ type: 'log', message: message });
        callback();
    }
}

export function useCliTransport() {
    logger.transports.push(new CliLogTransport());
}

export function useConsoleTransport() {
    logger.transports.push(new winston.transports.Console());
}

function createLogger() {
    var transports: Transport[] = [];
    transports.push(new winston.transports.File({ filename: path.join(getLogDirectory(), 'app.log') }));

    if (!isMainThread) {
        transports.push(new WorkerLogTransport());
    }

    return winston.createLogger({
        level: 'info',
        format: winston.format.combine(
            winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
            winston.format.errors({ stack: true }),
            winston.format.colorize(),
            winston.format.printf(
                (info) =>
                    `[${info.timestamp} | ${info.level}] ${info.stack || info.message}`
            )
        ),
        transports: transports
    });
}

const logger = createLogger();

export { logger, LogStream };
