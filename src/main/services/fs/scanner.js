const fastGlob = require('fast-glob');
const { z } = require('zod')
const { FSEntrySchema, Setting } = require('../../utils/setting');
const { logger } = require('../../utils/logger');
const { FileEntrySchema, FSStorage } = require('./storage');


/**
 * @typedef {z.core.output<FSEntrySchema>} FSEntry
 * @property {FSEntry} entry
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
        clearInterval(this._interval)
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
            logger.info(`-> updated file: ${file.path} ${file.stats.ctimeMs} ${file.stats.birthtimeMs} ${file.stats.atimeMs}`);
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

class FSService {
    /** @type {Map<string, FSScanner>}} */
    static scanners = new Map();

    static startFSService() {
        const storage = FSStorage.getInstance();
        Setting.getInstance().data.filesystems.forEach(fsEntry => {
            let instance = new FSScanner(fsEntry, storage);
            FSService.scanners.set(fsEntry.root, instance);
            instance.start();
        })
    }

    static stopFSService() {
        FSService.scanners.forEach(instance => {
            instance.stop();
        })
        FSService.scanners.clear();
    }
}


module.exports = { FSScanner, FSService };