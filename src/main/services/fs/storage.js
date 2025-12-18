const { getAppDirectory } = require('../../utils/setting');
const path = require('path');
const nedb = require('nedb-promises');
const { z } = require('zod');
const { logger } = require('../../utils/logger');
const { LocalIndex } = require('vectra');
const { LLM } = require('../../agents/llm');
const PQueue = require('p-queue');


const queue = new PQueue.default({ concurrency: 1 });

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
    root: z.string(),
    last_full_scan_timestamp: z.number(),
})


class FSStorage {
    /** @type {FSStorage | null} */
    static instance = null;

    constructor() {
        /** @type {nedb} */
        this.db = new nedb({
            filename: path.join(getAppDirectory(), 'fs_storage.db'),
            autoload: true
        });
        this.vecdb = new LocalIndex(path.join(getAppDirectory(), 'vec_storage.db'));
    }

    async initialize() {
        await this.db.ensureIndex({ fieldName: 'path', unique: true, sparse: true })
        await this.db.ensureIndex({ fieldName: 'filename', sparse: true })
        if (!await this.vecdb.isIndexCreated()) {
            logger.info(`vector index not created, creating new one`);
            await this.vecdb.createIndex();
        }
    }

    async finalize() {

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
        let unexist_filenames = [];
        for (const filename of filenames) {
            let item = await this.vecdb.getItem(filename);
            if (!item) {
                unexist_filenames.push(filename);
            }
        }

        if (unexist_filenames.length === 0) {
            return;
        }

        let start_time = Date.now();
        logger.info(`${unexist_filenames.length} filenames not found in vector database`);
        let embeddings = await LLM.batchEmbed(unexist_filenames);
        logger.info(`creating embeddings for ${unexist_filenames.length} filenames: ${Date.now() - start_time}ms`);


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
        const embedding = await LLM.embed(query);
        const items = await this.vecdb.queryItems(embedding, query, topK);
        const totalTime = Date.now() - startTime;
        logger.info(`searching files by name similarity ${query} in ${totalTime}ms`);

        /** @type {FileEntrySchema[]} */
        let result = [];

        logger.info(`found ${items.length} files by name similarity ${query}`);
        for (const item of items) {
            logger.info(`score: ${item.score} id: ${item.item.id}`);
            if (item.score < threshold) {
                break;
            }

            let files = await this.db.find({ filename: item.item.id });
            result.push(...files);
        }
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

module.exports = { FileEntrySchema, FileScannerMetadataSchema, FSStorage };