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
        /** @type {boolean} */
        this._stopped = true; // 初始状态为已停止
        /** @type {NodeJS.Timeout | null} */
        this._scheduledTimeout = null;
    }

    async start() {
        // 如果已经在运行（有已调度的任务或未停止），先停止
        if (!this._stopped || this._scheduledTimeout !== null) {
            logger.warn(`scanner for ${this.root} is already running, stopping it first`);
            await this.stop();
        }

        this._stopped = false;
        this.metadata = await this.storage.getFileScannerMetadata(this.root);
        this._counter = 0;
        logger.info(`starting scanner for ${this.root}, using metadata: ${JSON.stringify(this.metadata)}`);

        const scanTask = async () => {
            // 检查是否已停止
            if (this._stopped) {
                logger.info(`scanner ${this.root} is stopped, skipping scan task`);
                return;
            }

            await this.scan().catch(error => {
                logger.error(`scan task error: ${error.message}`, error);
                NotificationManager.getInstance().error('文件系统', '扫描', `扫描失败: ${error.message}`);
            });

            // 再次检查是否已停止（可能在扫描过程中被停止）
            if (this._stopped) {
                logger.info(`scanner ${this.root} was stopped during scan, not scheduling next task`);
                return;
            }

            this._counter++;
            // 使用实例变量存储timeout，以便可以清除
            this._scheduledTimeout = setTimeout(() => {
                if (!this._stopped) {
                    this.task_queue.add(scanTask);
                }
            }, 15 * 1000);
        }

        this.task_queue.add(scanTask);
    }

    async stop() {
        logger.info(`stopping scanner for ${this.root}`);
        this._stopped = true;

        // 清除已调度的timeout
        if (this._scheduledTimeout) {
            clearTimeout(this._scheduledTimeout);
            this._scheduledTimeout = null;
        }

        // 清除interval（如果存在）
        if (this._interval) {
            clearInterval(this._interval);
            this._interval = null;
        }
        logger.info(`scanner for ${this.root} stopped`);
    }

    /**
     * 根据扫描计数器计算本次扫描的深度
     * @returns {number | undefined} 扫描深度，undefined表示全量扫描
     */
    _getScanDepth() {
        const counter = this._counter;
        // 每32次进行一次全量扫描
        if (counter % 32 === 0) {
            return undefined;
        }
        // 每16次深度为10
        if (counter % 16 === 0) {
            return 10;
        }
        // 每8次深度为8
        if (counter % 8 === 0) {
            return 8;
        }
        // 每4次深度为6
        if (counter % 4 === 0) {
            return 6;
        }
        // 默认深度为4
        return 4;
    }

    /**
     * 将fastGlob的Entry转换为FileEntry
     * @param {fastGlob.Entry} file
     * @returns {z.core.output<FileEntrySchema>}
     */
    _convertToFileEntry(file) {
        return FileEntrySchema.parse({
            path: file.path,
            filename: file.name,
            size: file.stats.size,
            modified: file.stats.ctimeMs,
            created: file.stats.birthtimeMs,
            accessed: file.stats.atimeMs,
            type: file.stats.isDirectory() ? 'directory' : 'file'
        });
    }

    /**
     * 判断文件是否在最后一次全量扫描后更新过
     * @param {fastGlob.Entry} file
     * @param {number} lastScanningTime
     * @returns {boolean}
     */
    _isFileUpdated(file, lastScanningTime) {
        return file.stats.ctimeMs > lastScanningTime || file.stats.birthtimeMs > lastScanningTime;
    }

    async scan() {
        const deep = this._getScanDepth();
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
        };

        const scanStartTime = Date.now();
        let allFiles;
        try {
            /** @type {fastGlob.Entry[]} */
            allFiles = await fastGlob(this.entry.include_patterns, options);
        } catch (error) {
            logger.error(`fastGlob scan failed for ${this.root}: ${error.message}`, error);
            throw error;
        }

        const scanTime = Date.now() - scanStartTime;
        const totalFiles = allFiles.length;

        // 流式处理：边过滤边转换边保存，避免一次性占用大量内存
        const BATCH_SIZE = 500; // 减小批次大小，更频繁地释放内存
        let updatedCount = 0;
        let savedCount = 0;
        const debugFiles = []; // 只收集前20个用于日志

        const filterStartTime = Date.now();
        for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
            const batch = allFiles.slice(i, i + BATCH_SIZE);

            // 过滤并转换批次
            const batchStartTime = Date.now();
            const updatedBatch = [];
            for (const file of batch) {
                if (this._isFileUpdated(file, lastScanningTime)) {
                    updatedBatch.push(file);
                    updatedCount++;

                    // 收集前20个用于调试日志
                    if (debugFiles.length < 20) {
                        debugFiles.push(file);
                    }
                }
            }

            // 转换文件条目
            const fileEntries = updatedBatch.map(file => this._convertToFileEntry(file));
            const batchProcessTime = Date.now() - batchStartTime;

            // 立即保存批次，释放内存
            if (fileEntries.length > 0) {
                try {
                    await this.storage.saveFiles(fileEntries);
                    savedCount += fileEntries.length;
                } catch (error) {
                    logger.error(`failed to save batch (${i}-${i + batch.length}) to storage: ${error.message}`, error);
                    throw error;
                }
            }

            // 每处理一定数量的文件后记录进度（避免日志过多）
            if ((i + BATCH_SIZE) % (BATCH_SIZE * 10) === 0 || i + BATCH_SIZE >= allFiles.length) {
                const progress = ((i + BATCH_SIZE) / allFiles.length * 100).toFixed(1);
                logger.debug(`scan progress: ${progress}% (${i + BATCH_SIZE}/${allFiles.length} files processed, ${updatedCount} updated)`);
            }
        }

        const filterTime = Date.now() - filterStartTime;
        const totalTime = Date.now() - scanStartTime;

        logger.info(`[depth ${deep ?? 'full'}] scanning ${this.root}: ${totalFiles} files found (${updatedCount} updated, ${savedCount} saved), scan: ${scanTime}ms, filter+save: ${filterTime}ms, total: ${totalTime}ms`);

        // 记录前20个更新文件的详细信息
        if (debugFiles.length > 0) {
            for (const file of debugFiles) {
                logger.debug(`-> updated file: ${file.path} ctime:${file.stats.ctimeMs} birthtime:${file.stats.birthtimeMs} atime:${file.stats.atimeMs}`);
            }
            if (updatedCount > 20) {
                logger.debug(`... and ${updatedCount - 20} more updated files`);
            }
        }

        // 如果是全量扫描，更新元数据
        if (deep === undefined) {
            const now = Date.now();
            logger.info(`finished full scan for ${this.root}, setting metadata timestamp to ${now}`);
            this.metadata.last_full_scan = now;
            this.metadata.total_files = totalFiles;
            try {
                await this.storage.saveFileScannerMetadata(this.metadata);
            } catch (error) {
                logger.error(`failed to save scanner metadata: ${error.message}`, error);
                throw error;
            }
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
        /** @type {boolean} */
        this._initializing = false;
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
        this._initializing = true;
        return this.runSequentially(async () => {
            try {
                this.storage = await FSStorage.getInstance();
                const filesystems = this.config?.entries;
                if (!filesystems) {
                    logger.warn(`no filesystems configured, skipping initialization`);
                    this.status = "idle";
                    return;
                }
                for (const fsEntry of filesystems) {
                    let instance = new FSScanner(fsEntry, this.storage, this.taskQueue);
                    this.scanners.set(fsEntry.root, instance);
                    instance.start();
                }
                this.status = "running";
            } finally {
                this._initializing = false;
            }
        }).catch(error => {
            this._initializing = false;
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
            try {
                // 重置存储
                await this.storage.reset();
                logger.info('file system storage reset successfully');

                // 重置后重启scanners，以便重新开始扫描
                await this._restartScanners();

                return { status: "ok" };
            } catch (error) {
                logger.error(`resetStorage error: ${error.message}`, error);
                return { status: "error", message: error.message };
            }
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

    /**
     * 重启所有scanners
     * 注意：这个方法可能已经在 runSequentially 内部被调用，所以不再使用 runSequentially
     */
    async _restartScanners() {
        logger.info('_restartScanners called', { storage: !!this.storage, status: this.status });

        if (!this.storage) {
            logger.warn('storage not initialized, cannot restart scanners');
            return;
        }

        try {
            logger.info('restarting scanners');

            // 停止所有现有的scanners
            const stopPromises = [];
            for (const scanner of this.scanners.values()) {
                stopPromises.push(scanner.stop().catch(error => {
                    logger.error(`error stopping scanner ${scanner.root}: ${error.message}`, error);
                }));
            }
            logger.info(`stopping ${this.scanners.size} scanners`);
            await Promise.all(stopPromises);
            this.scanners.clear();
            logger.info('all scanners stopped');

            // 根据新配置重新创建和启动scanners
            const filesystems = this.config?.entries;
            if (!filesystems || filesystems.length === 0) {
                logger.warn('no filesystems configured, scanners will not be started');
                this.status = "idle";
                return;
            }

            logger.info(`starting ${filesystems.length} scanners`);
            for (const fsEntry of filesystems) {
                try {
                    const instance = new FSScanner(fsEntry, this.storage, this.taskQueue);
                    this.scanners.set(fsEntry.root, instance);
                    instance.start();
                    logger.info(`started scanner for ${fsEntry.root}`);
                } catch (error) {
                    logger.error(`failed to start scanner for ${fsEntry.root}: ${error.message}`, error);
                }
            }

            this.status = "running";
            logger.info(`restarted ${this.scanners.size} scanners`);
        } catch (error) {
            logger.error(`error in _restartScanners: ${error.message}`, error);
            this.status = "error";
            throw error;
        }
    }

    /**
     * 配置更新时调用，重启scanners以应用新配置
     * @param {object} config
     */
    async applicationConfigChanged(config) {
        await super.applicationConfigChanged(config);

        // 如果正在初始化中，不要重启，避免重复启动
        // 初始化完成后，如果配置发生变化，initialize()会使用新配置
        if (this._initializing) {
            logger.debug('skipping scanner restart during initialization');
            return;
        }

        // 如果已经初始化且状态是running，则重启scanners
        // 使用 runSequentially 确保顺序执行
        if (this.storage && this.status === "running") {
            await this.runSequentially(async () => {
                await this._restartScanners();
            });
        }
    }
}

export default FileManagerWorker;