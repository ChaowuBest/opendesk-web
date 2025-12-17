const winston = require('winston');
const { Setting, getLogDirectory } = require('./setting');
const path = require('path');
const { Writable } = require('stream');


class LogStream extends Writable {

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

/** @type {winston.Logger} */
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.cli(),
    transports: [
        new winston.transports.File({ filename: path.join(getLogDirectory(), 'app.log') }),
        new winston.transports.Console(),
        new winston.transports.Stream({ stream: LogStream.getStream() })
    ]
});

module.exports = { logger, LogStream };
