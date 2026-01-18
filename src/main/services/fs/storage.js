import { getAppDirectory } from '../../utils/setting.js';
import path from 'path';
import fs from 'fs';
import readline from 'readline';
import nedb from 'nedb-promises';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { LocalIndex } from 'vectra';
import { LLM } from '../../agents/llm.js';
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

    async initialize() {
        await this.db.load().catch(err => {
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
        filenames = Array.from(new Set(filenames));
        let unexist_filenames = filenames.filter(filename => !this.vec_cache.has(filename));
        if (unexist_filenames.length === 0) {
            return;
        }

        let start_time = Date.now();
        logger.info(`${unexist_filenames.length} filenames not found in vector database`);
        let embeddings = await LLM.batchEmbed(unexist_filenames);
        logger.info(`creating embeddings for ${unexist_filenames.length} filenames: ${Date.now() - start_time}ms`);

        if (unexist_filenames.length === 0) {
            return;
        }

        // 先存到vec_cache里面，不容易坏掉
        for (const [index, filename] of unexist_filenames.entries()) {
            this.vec_cache.set(filename, embeddings[index]);
        }

        try {
            const records = unexist_filenames.map((filename, index) => {
                return JSON.stringify({ key: filename, vec: embeddings[index] });
            });
            // 使用同步方式避免并发写入问题
            fs.appendFileSync(FSStorage.vectorCachePath, records.join('\n') + '\n');
        } catch (e) {
            logger.warn(`Error appending to vec_cache.jsonl: ${e.message}`);
        }

        await queue.add(async () => {
            let start_time = Date.now();
            await this.vecdb.beginUpdate()
            for (const [index, filename] of unexist_filenames.entries()) {
                await this.vecdb.insertItem({
                    id: filename,
                    vector: embeddings[index]
                })
            }
            await this.vecdb.endUpdate();
            logger.info(`saving ${unexist_filenames.length} filenames to vector database: ${Date.now() - start_time}ms`);
        });
    }

    /**
     *
     * @param {z.core.output<FileEntrySchema>} files
     */
    async saveFiles(files) {
        if (files.length === 0) {
            return;
        }

        let startTime = Date.now();
        for (const file of files) {
            await this.db.update(
                { path: file.path },
                { $set: file },
                { upsert: true }
            )
        }
        let totalTime = Date.now() - startTime;
        logger.info(`saving ${files.length} files to nedb database: ${totalTime}ms`);

        // 这里按照扩展名统计一下不同扩展名的数量，打log出来
        const extensionCount = {};
        for (const file of files) {
            const ext = file.filename.lastIndexOf('.') !== -1 ? file.filename.slice(file.filename.lastIndexOf('.')).toLowerCase() : '';
            extensionCount[ext] = (extensionCount[ext] || 0) + 1;
        }
        logger.info(`Extension Distribution (filenames to embed): ${JSON.stringify(extensionCount)}`);

        await this.saveFilenameEmbeddings(files.map(file => file.filename));
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
        const embedding = await LLM.embed(query);
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
            return FileScannerMetadataSchema.parse({
                root: root,
                last_full_scan_timestamp: 0,
            });
        }
        try {
            let result = FileScannerMetadataSchema.parse(metadata);
            return result;
        } catch (error) {
            logger.warn(`error parsing existing file scanner metadata: ${error}`);
            return FileScannerMetadataSchema.parse({
                root: root,
                last_full_scan_timestamp: 0,
            });
        }
    }

    async saveFileScannerMetadata(metadata) {
        await this.db.update({ root: metadata.root }, { $set: metadata }, { upsert: true });
    }

}

export { FileEntrySchema, FileScannerMetadataSchema, FSStorage };
