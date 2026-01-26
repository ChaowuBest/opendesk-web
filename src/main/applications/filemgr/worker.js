import { z } from 'zod';
import { Setting } from '../../utils/setting.js';
import { FileEntrySchema, FSStorage, FileScannerMetadataSchema } from './storage.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { logger } from '../../utils/logger.js';
import { BaseWorker } from '../base.js';
import fastGlob from 'fast-glob';


class FSScanner {
    /**
     * @param {FSEntry} entry
     */
    constructor(entry, storage, task_queue) {
        /** @type {FSEntry} */
        this.entry = entry;
        /** @type {string} */
        this.root = entry.root;
        /** @type {FSStorage} */
        this.storage = storage;
        /** @type {z.core.output<FileScannerMetadataSchema>} */
        this.metadata = FileScannerMetadataSchema.parse({ root: this.root });
        /** @type {NodeJS.Timeout | null} */
        this._interval = null;
        /** @type {number} */
        this._counter = 0;
        /** @type {PQueue} */
        this.task_queue = task_queue;
    }

    async start() {
        this.metadata = await this.storage.getFileScannerMetadata(this.root);
        this._counter = 0;
        logger.info(`starting scanner for ${this.root}, using metadata: ${JSON.stringify(this.metadata)}`);

        const scanTask = async () => {
            await this.scan().catch(error => {
                logger.error(`scan task error: ${error.message}`, error);
                NotificationManager.getInstance().error('文件系统', '扫描', `扫描失败: ${error.message}`);
            });

            this._counter++;
            setTimeout(() => {
                this.task_queue.add(scanTask);
            }, 10 * 1000);
        }

        this.task_queue.add(scanTask);
    }

    async stop() {
        await this.task_queue.add(async () => {
            clearInterval(this._interval);
            this._interval = null;
        });
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

        const lastScanningTime = this.metadata.last_full_scan;

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
            this.metadata.last_full_scan = Date.now();
            this.metadata.total_files = allFiles.length;
            await this.storage.saveFileScannerMetadata(this.metadata);
        }
    }
}


class FileManagerWorker extends BaseWorker {

    constructor(appDataDirectory) {
        super('filemgr', appDataDirectory);
        this.status = "idle";
        /** @type {Map<string, FSScanner>} */
        this.scanners = new Map();
        /** @type {FSStorage | null} */
        this.storage = null;
    }

    async getFileSystemStatus() {
        if (!this.storage) {
            return { status: 'idle' };
        }
        return {
            status: this.status,
            scanners: [
                ...this.scanners.values().map(instance => {
                    return {
                        entry: instance.entry,
                        lastFullScan: instance.metadata.last_full_scan,
                        totalFiles: instance.metadata.total_files
                    }
                })
            ],
            storage: await this.storage.getStatus(),
        };
    }

    async initialize() {
        this.runSequentially(async () => {
            this.storage = await FSStorage.getInstance();
            const filesystems = this.config?.entries;
            if (!filesystems) {
                logger.warn(`no filesystems configured, skipping initialization`);
                return;
            }
            for (const fsEntry of filesystems) {
                let instance = new FSScanner(fsEntry, this.storage, this.taskQueue);
                this.scanners.set(fsEntry.root, instance);
                instance.start();
            }
            this.status = "running";
        }).catch(error => {
            logger.error(`initialize error: ${error.message}`, error);
            this.status = "error";
        });
    }

    async finalize() {
        await this.runSequentially(async () => {
            this.scanners.forEach(instance => {
                instance.stop();
            });
            this.scanners.clear();
            this.status = "idle";
        }).catch(error => {
            logger.error(`finalize error: ${error.message}`, error);
        });
    }

    async resetFileSystemStorage() {
        if (!this.storage) {
            return { status: "error", message: 'storage not initialized' };
        }

        return this.runSequentially(async () => {
            return this.storage.reset().then(() => {
                return { status: "ok" };
            }).catch(error => {
                logger.error(`resetStorage error: ${error.message}`, error);
                return { status: "error", message: error.message };
            });
        })
    }

    async getStatus() {
        return { status: 'ok', data: await this.getFileSystemStatus() };
    }

    async searchFilesByKeyword(keyword) {
        if (!this.storage) {
            throw new Error('storage not initialized');
        }

        const result = await this.storage.searchFilesByKeyword(keyword);
        return result;
    }

    async searchFilesByNameSimilarity(query, topK = 20, threshold = 0.1) {
        if (!this.storage) {
            throw new Error('storage not initialized');
        }

        const result = await this.storage.searchFilesByNameSimilarity(query, topK, threshold);
        return result;
    }
}

export default FileManagerWorker;