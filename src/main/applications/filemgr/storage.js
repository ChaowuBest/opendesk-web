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

import { getAppDirectory, Setting } from '../../utils/setting.js';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { LocalIndex } from 'vectra';
import { LLM } from '../../aikernel/llm.js';
import { NotificationManager } from '../../utils/notificationmgr';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import nedb from 'nedb-promises';
import PQueue from 'p-queue';


const queue = new PQueue({ concurrency: 1 });

const FileEntrySchema = z.object({
    path: z.string(),
    filename: z.string(),
    size: z.number(),
    modified: z.number(),
    created: z.number(),
    accessed: z.number(),
    type: z.enum(['file', 'directory'])
})

const FileScannerMetadataSchema = z.object({
    type: z.literal('metadata').default('metadata'),
    root: z.string(),
    last_full_scan: z.number().default(0),
    total_files: z.number().default(0),
})


class FSStorage {

    /** @type {FSStorage | null} */
    static instance = null;

    /** @type {string} */
    static vectorCachePath = path.join(getAppDirectory(), 'vec_cache.jsonl');
    static dbPath = path.join(getAppDirectory(), 'fs_storage.db');

    constructor() {
        /** @type {nedb} */
        this.db = new nedb({ filename: FSStorage.dbPath, autoload: false });

        /** @type {Map<string, number[]>} */
        this.vec_cache = new Map();
        this.vecdb = new LocalIndex(path.join(getAppDirectory(), 'vec_storage.db'));
    }

    refreshLatestSetting() {
        Setting.clearCache();
        return Setting.getInstance();
    }

    async loaddb() {
        await this.db.load();
        await this.db.ensureIndex({ fieldName: 'path', unique: true, sparse: true });
        await this.db.ensureIndex({ fieldName: 'filename', sparse: true });
    }

    async initialize() {
        await this.loaddb().catch(err => {
            logger.error(`error loading fs_storage.db: ${err}`);
            fs.rmSync(FSStorage.dbPath);
            this.db = new nedb({ filename: FSStorage.dbPath, autoload: true });
            NotificationManager.getInstance().error('文件系统', '文件系统扫描', `文件系统数据库损坏，已删除并重新创建`);
        }).finally(() => {
            this.db.ensureIndex({ fieldName: 'path', unique: true, sparse: true });
            this.db.ensureIndex({ fieldName: 'filename', sparse: true });
        })

        let startTime = Date.now();
        logger.info(`loading vector cache from ${FSStorage.vectorCachePath}`);
        if (fs.existsSync(FSStorage.vectorCachePath)) {
            const fileStream = fs.createReadStream(FSStorage.vectorCachePath, { encoding: 'utf-8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
              });
              for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    const cacheItem = JSON.parse(line);
                    // 假定 cacheItem 格式：{ key: string, vec: number[] }
                    if (cacheItem && cacheItem.key && Array.isArray(cacheItem.vec)) {
                        this.vec_cache.set(cacheItem.key, cacheItem.vec);
                    }
                } catch (e) {
                    logger.warn(`Error parsing vec_cache.jsonl line: ${e.message}`);
                }
            }
        }
        logger.info(`loaded ${this.vec_cache.size} vector entries from vec_cache.jsonl: ${Date.now() - startTime}ms`);

        startTime = Date.now();
        await this.vecdb.createIndex({ deleteIfExists: true });
        try {
            await this.vecdb.beginUpdate();
            for (const [key, vector] of this.vec_cache.entries()) {
                await this.vecdb.insertItem({ id: key, vector: vector });
            }
            await this.vecdb.endUpdate();
            logger.info(`creating vector index and inserting ${this.vec_cache.size} items to vector database: ${Date.now() - startTime}ms`);
        } catch (e) {
            await this.vecdb.createIndex({ deleteIfExists: true });
            logger.error(`error creating vector index, using empty index instead`);
        }
    }

    async reset() {
        await this.db.remove({}, { multi: true });
        await this.vecdb.createIndex({ deleteIfExists: true });
        this.vec_cache.clear();
        fs.rmSync(FSStorage.vectorCachePath, { force: true });
        logger.info('storage reset finished')
    }

    async getStatus() {
        let vecdb_stats = await this.vecdb.getIndexStats();
        let db_count = await this.db.count({ type: { $ne: 'metadata' } });
        return {
            veccache_size: this.vec_cache.size,
            vecdb_size: vecdb_stats.items,
            db_size: db_count,
        };
    }

    static async getInstance() {
        if (!this.instance) {
            this.instance = new FSStorage();
            await this.instance.initialize();
        }
        return this.instance;
    }

    async saveFilenameEmbeddings(filenames) {
        if (!filenames || filenames.length === 0) {
            return true;
        }

        // 去重并过滤已存在的文件名
        const uniqueFilenames = Array.from(new Set(filenames));
        const unexistFilenames = uniqueFilenames.filter(filename => !this.vec_cache.has(filename));

        if (unexistFilenames.length === 0) {
            return true;
        }

        const embedStartTime = Date.now();
        logger.info(`${unexistFilenames.length} filenames not found in vector database, creating embeddings...`);

        let embeddings;
        try {
            this.refreshLatestSetting();
            embeddings = await LLM.batchEmbed(unexistFilenames);
            const embedTime = Date.now() - embedStartTime;
            logger.info(`created embeddings for ${unexistFilenames.length} filenames: ${embedTime}ms`);
        } catch (error) {
            logger.error(`failed to create embeddings: ${error.message}`, error);
            throw error;
        }

        // 先存到vec_cache里面，不容易坏掉
        const cacheStartTime = Date.now();
        for (let i = 0; i < unexistFilenames.length; i++) {
            this.vec_cache.set(unexistFilenames[i], embeddings[i]);
        }
        const cacheTime = Date.now() - cacheStartTime;
        if (cacheTime > 10) {
            logger.debug(`updated vec_cache for ${unexistFilenames.length} filenames: ${cacheTime}ms`);
        }

        // 写入缓存文件
        try {
            const records = unexistFilenames.map((filename, index) => {
                return JSON.stringify({ key: filename, vec: embeddings[index] });
            });
            // 使用同步方式避免并发写入问题
            fs.appendFileSync(FSStorage.vectorCachePath, records.join('\n') + '\n');
        } catch (e) {
            logger.warn(`Error appending to vec_cache.jsonl: ${e.message}`);
        }

        // 保存到向量数据库（使用队列确保顺序）
        await queue.add(async () => {
            const vecdbStartTime = Date.now();
            try {
                await this.vecdb.beginUpdate();
                for (let i = 0; i < unexistFilenames.length; i++) {
                    await this.vecdb.insertItem({
                        id: unexistFilenames[i],
                        vector: embeddings[i]
                    });
                }
                await this.vecdb.endUpdate();
                const vecdbTime = Date.now() - vecdbStartTime;
                logger.info(`saved ${unexistFilenames.length} filenames to vector database: ${vecdbTime}ms`);
            } catch (error) {
                logger.error(`failed to save to vector database: ${error.message}`, error);
                throw error;
            }
        });

        return true;
    }

    /**
     * 提取文件扩展名（优化版本）
     * @param {string} filename
     * @returns {string}
     */
    _getFileExtension(filename) {
        const lastDot = filename.lastIndexOf('.');
        return lastDot !== -1 ? filename.slice(lastDot).toLowerCase() : '';
    }

    /**
     * 批量保存文件到数据库
     * @param {z.core.output<FileEntrySchema>[]} files
     */
    async saveFiles(files) {
        if (files.length === 0) {
            return 0;
        }

        // 1. 批量查询 base_db 中已有记录（按 path 索引，性能可接受）
        const paths = files.map(f => f.path);
        const existingRecords = await this.db.find({ path: { $in: paths }, type: { $ne: 'metadata' } });
        const existingMap = new Map(existingRecords.map(r => [r.path, r]));

        // 2. Per-file checkpoint：跳过 modified 未变化的文件
        const filesToProcess = files.filter(file => {
            const existing = existingMap.get(file.path);
            if (!existing) return true;               // 新文件，需处理
            return file.modified !== existing.modified; // modified 变化，需处理
        });

        const skippedCount = files.length - filesToProcess.length;
        if (filesToProcess.length === 0) {
            logger.debug(`saveFiles: all ${files.length} files already indexed (modified unchanged), skipping`);
            return 0;
        }
        if (skippedCount > 0) {
            logger.debug(`saveFiles: ${filesToProcess.length} to process, ${skippedCount} skipped (modified unchanged)`);
        }

        // 3. Embedding 先于 base_db 更新。
        //    所有 embedding 阶段错误统一在这里收口：本批不写 base_db，不推进 checkpoint。
        const filenames = filesToProcess.map(f => f.filename);
        try {
            await this.saveFilenameEmbeddings(filenames);
        } catch (error) {
            logger.warn(`saveFiles: embedding failed, skipping base_db update: ${error.message}`, error);
            return 0;
        }

        // 4. Embedding 成功后再更新 base_db
        const startTime = Date.now();
        const CONCURRENT_UPDATES = 10;
        const updatePromises = [];

        for (let i = 0; i < filesToProcess.length; i++) {
            const file = filesToProcess[i];
            updatePromises.push(
                this.db.update({ path: file.path }, { $set: file }, { upsert: true })
            );

            if (updatePromises.length >= CONCURRENT_UPDATES || i === filesToProcess.length - 1) {
                await Promise.all(updatePromises);
                updatePromises.length = 0;
            }
        }

        const dbTime = Date.now() - startTime;
        logger.info(`saveFiles: processed ${filesToProcess.length} files (${skippedCount} skipped), db update: ${dbTime}ms`);
        return filesToProcess.length;
    }

    async searchFilesByKeyword(keyword) {
        const startTime = Date.now();
        const result = await this.db.find({ filename: { $regex: new RegExp(keyword, 'i') } })
        const totalTime = Date.now() - startTime;
        logger.info(`searching files by keyword ${keyword} in ${totalTime}ms`);
        return result;
    }

    /**
     * Search files by name similarity
     * @param {string} query
     * @param {number} topK
     * @param {number} threshold
     * @returns {Promise<FileEntrySchema[]>}
     */
    async searchFilesByNameSimilarity(query, topK = 20, threshold = 0.5) {
        const startTime = Date.now();
        logger.info(`[vector] start name similarity search: query="${query}" topK=${topK} threshold=${threshold}`);
        const embedStart = Date.now();
        let embedding;
        try {
            this.refreshLatestSetting();
            embedding = await LLM.embed(query);
        } catch (error) {
            logger.warn(`[vector] failed to create embedding for query="${query}", skipping similarity search: ${error.message}`, error);
            return [];
        }
        const embedTime = Date.now() - embedStart;
        logger.info(`[vector] embedding ok: ${embedTime}ms`);
        const queryStart = Date.now();
        const items = await this.vecdb.queryItems(embedding, query, topK);
        const queryTime = Date.now() - queryStart;
        const totalTime = Date.now() - startTime;
        logger.info(`[vector] query ok: ${queryTime}ms, total ${totalTime}ms`);

        /** @type {FileEntrySchema[]} */
        let result = [];

        logger.info(`[vector] found ${items.length} candidate items for query="${query}"`);
        for (const item of items) {
            logger.info(`[vector] score: ${item.score} id: ${item.item.id}`);
            if (item.score < threshold) {
                break;
            }

            let files = await this.db.find({ filename: item.item.id });
            result.push(...files);
        }

        try {
            result = await LLM.rerank(query, result, (item) => item.filename);
        } catch (error) {
            logger.error(`[vector] failed to rerank the results: ${error}`);
        }
        logger.info(`[vector] returning ${result.length} files after threshold filter`);
        return result;
    }

    async getFileScannerMetadata(root) {
        let metadata = await this.db.findOne({ root: root });
        if (!metadata) {
            logger.info(`no file scanner metadata found for ${root}, creating new one`);
            // 使用Schema的默认值，last_full_scan默认为0
            return FileScannerMetadataSchema.parse({
                root: root,
            });
        }
        try {
            let result = FileScannerMetadataSchema.parse(metadata);
            return result;
        } catch (error) {
            logger.warn(`error parsing existing file scanner metadata: ${error}`);
            // 解析失败时，创建新的metadata，使用Schema的默认值
            return FileScannerMetadataSchema.parse({
                root: root,
            });
        }
    }

    async saveFileScannerMetadata(metadata) {
        await this.db.update({ root: metadata.root }, { $set: metadata }, { upsert: true });
    }

}

export { FileEntrySchema, FileScannerMetadataSchema, FSStorage };
