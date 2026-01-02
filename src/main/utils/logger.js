import { getLogDirectory } from './setting.js';
import { Writable } from 'stream';
import { isMainThread, parentPort } from 'worker_threads';
import path from 'path';
import winston from 'winston';


class LogStream extends Writable {

    /** @type {Writable | null} */
    static globalStream = null;

    constructor(filename) {
        super();
        this.content = '';
    }

    _write(chunk, encoding, callback) {
        this.content += chunk.toString();
        callback();
    }

    getContent() {
        return this.content;
    }

    static getStream() {
        if (this.globalStream === null) {
            this.globalStream = new LogStream();
        }
        return this.globalStream;
    }
}

// 创建自定义的 winston transport，将日志转发到主线程
class WorkerLogTransport extends winston.Transport {
    constructor(options) {
        super(options);
    }

    log(info, callback) {
        setImmediate(() => {
            this.emit('logged', info);
        });

        // 格式化消息 - 使用与主线程相同的格式
        // winston.format.cli() 会在 info 对象上设置 Symbol.for('message')
        const formattedMessage = info[Symbol.for('message')];
        const message = formattedMessage || info.message || JSON.stringify(info);

        // 将日志消息发送到主线程
        parentPort.postMessage({
            type: 'log',
            message: message
        });

        callback();
    }
}

/** @type {winston.Logger} */
const logger = winston.createLogger({
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
    transports: [
        new winston.transports.File({ filename: path.join(getLogDirectory(), 'app.log') }),
        new winston.transports.Console(),
        isMainThread ?
            new winston.transports.Stream({ stream: LogStream.getStream() }) :
            new WorkerLogTransport()
    ]
});

export { logger, LogStream };
