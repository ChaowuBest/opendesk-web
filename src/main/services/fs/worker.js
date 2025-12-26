const { parentPort } = require('worker_threads');
const fastGlob = require('fast-glob');
const { z } = require('zod');
const { FSEntrySchema, Setting } = require('../../utils/setting');
const { FileEntrySchema, FSStorage } = require('./storage');
const { logger } = require('../../utils/logger');


/**
 * @typedef {z.core.output<FSEntrySchema>} FSEntry
 */
class FSScanner {
    /**
     * @param {FSEntry} entry
     */
    constructor(entry, storage) {
        /** @type {FSEntry} */
        this.entry = entry;
        /** @type {string} */
        this.root = entry.root;
        /** @type {FSStorage} */
        this.storage = storage;
        /** @type {FileScannerMetadataSchema} */
        this.metadata = undefined;

        /** @type {NodeJS.Timeout | null} */
        this._interval = null;
        /** @type {number} */
        this._counter = 0;
    }

    async start() {
        this.metadata = await this.storage.getFileScannerMetadata(this.root);
        logger.info(`starting scanner for ${this.root}, using metadata: ${JSON.stringify(this.metadata)}`);
        await this.scan();
        this._interval = setInterval(() => {
            this._counter++;
            this.scan();
        }, 10 * 1000);
    }

    async stop() {
        clearInterval(this._interval);
    }

    async scan() {
        /** @type {number | undefined} */
        var deep = 4;
        if (this._counter % 32 === 0) {
            deep = undefined;
        } else if (this._counter % 16 === 0) {
            deep = 10;
        } else if (this._counter % 8 === 0) {
            deep = 8;
        } else if (this._counter % 4 === 0) {
            deep = 6;
        }

        const lastScanningTime = this.metadata.last_full_scan_timestamp;

        /** @type {fastGlob.Options} */
        const options = {
            cwd: this.root,
            deep: deep,
            dot: false,
            stats: true,
            objectMode: true,
            suppressErrors: true,
            followSymbolicLinks: false,
            absolute: true,
            caseSensitiveMatch: false,
            ignore: this.entry.exclude_patterns
        }

        const startTime = Date.now();
        /** @type {fastGlob.Entry[]} */
        const allFiles = await fastGlob(this.entry.include_patterns, options);
        const updatedFiles = allFiles.filter(file => (file.stats.ctimeMs > lastScanningTime || file.stats.birthtimeMs > lastScanningTime))
        const totalTime = Date.now() - startTime;
        logger.info(`[depth ${deep}] scanning ${this.root}: ${allFiles.length} files found (${updatedFiles.length} updated), time cost ${totalTime}ms`);

        for (const file of updatedFiles.slice(0, 20)) {
            logger.debug(`-> updated file: ${file.path} ${file.stats.ctimeMs} ${file.stats.birthtimeMs} ${file.stats.atimeMs}`);
        }

        const fileEntries = updatedFiles.map(file => {
            return FileEntrySchema.parse({
                path: file.path,
                filename: file.name,
                size: file.stats.size,
                modified: file.stats.ctimeMs,
                created: file.stats.birthtimeMs,
                accessed: file.stats.atimeMs,
                type: file.stats.isDirectory() ? 'directory' : 'file'
            })
        })

        await this.storage.saveFiles(fileEntries);
        if (deep === undefined) {
            logger.info(`finished full scan for ${this.root}, setting metadata timestamp to ${Date.now()}`);
            this.metadata.last_full_scan_timestamp = Date.now();
            await this.storage.saveFileScannerMetadata(this.metadata);
        }
    }
}

/** @type {Map<string, FSScanner>} */
const scanners = new Map();

/** @type {FSStorage | null} */
let storage = null;

// 处理来自主线程的消息
parentPort.on('message', async (message) => {
    try {
        const { type, id, payload } = message;

        switch (type) {
            case 'init': {
                // 初始化 storage
                storage = await FSStorage.getInstance();
                parentPort.postMessage({ type: 'response', id, status: 'ok' });
                break;
            }

            case 'startService': {
                if (!storage) {
                    storage = await FSStorage.getInstance();
                }
                const filesystems = Setting.getInstance().data.filesystems;
                for (const fsEntry of filesystems) {
                    let instance = new FSScanner(fsEntry, storage);
                    scanners.set(fsEntry.root, instance);
                    instance.start();
                }
                parentPort.postMessage({ type: 'response', id, status: 'ok' });
                break;
            }

            case 'stopService': {
                scanners.forEach(instance => {
                    instance.stop();
                });
                scanners.clear();
                parentPort.postMessage({ type: 'response', id, status: 'ok' });
                break;
            }

            case 'searchFilesByKeyword': {
                if (!storage) {
                    storage = await FSStorage.getInstance();
                }
                const result = await storage.searchFilesByKeyword(payload.keyword);
                parentPort.postMessage({ type: 'response', id, status: 'ok', data: result });
                break;
            }

            case 'searchFilesByNameSimilarity': {
                if (!storage) {
                    storage = await FSStorage.getInstance();
                }
                try {
                    const result = await storage.searchFilesByNameSimilarity(payload.query, payload.topK, payload.threshold);
                    parentPort.postMessage({ type: 'response', id, status: 'ok', data: result });
                } catch (ex) {
                    parentPort.postMessage({ type: 'response', id, status: 'error', message: ex.message });
                }
                break;
            }

            default:
                parentPort.postMessage({ type: 'response', id, status: 'error', message: `Unknown message type: ${type}` });
        }
    } catch (error) {
        logger.error(`Worker error: ${error.message}`, error);
        parentPort.postMessage({ type: 'response', id, status: 'error', message: error.message });
    }
});
