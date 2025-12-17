const { getAppDirectory } = require('../../utils/setting');
const path = require('path');
const nedb = require('nedb');
const { z } = require('zod');
const { logger } = require('../../utils/logger');
const { promisify } = require('util');


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
        this.db.ensureIndex({ fieldName: 'path', unique: true, sparse: true })
        this.db.ensureIndex({ fieldName: 'filename', sparse: true })

        this.findOne = promisify(this.db.findOne.bind(this.db));
        this.update = promisify(this.db.update.bind(this.db));
        this.insert = promisify(this.db.insert.bind(this.db));
        this.remove = promisify(this.db.remove.bind(this.db));
        this.count = promisify(this.db.count.bind(this.db));
        this.find = promisify(this.db.find.bind(this.db));
        this.ensureIndex = promisify(this.db.ensureIndex.bind(this.db));
    }

    static getInstance() {
        if (!this.instance) {
            this.instance = new FSStorage();
        }
        return this.instance;
    }

    /**
     *
     * @param {z.core.output<FileEntrySchema>} files
     */
    async saveFiles(files) {
        const startTime = Date.now();

        for (const file of files) {
            await this.update(
                { path: file.path },
                { $set: file },
                { upsert: true }
            )
        }
        const totalTime = Date.now() - startTime;
        logger.info(`saving ${files.length} files to database: ${totalTime}ms`);
    }

    async searchFilesByKeyword(keyword) {
        const startTime = Date.now();
        const result = await this.find({ filename: { $regex: new RegExp(keyword, 'i') } })
        const totalTime = Date.now() - startTime;
        logger.info(`searching files by keyword ${keyword} in ${totalTime}ms`);
        return result;
    }

    async getFileScannerMetadata(root) {
        let metadata = await this.findOne({ root: root });
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
        this.db.update({ root: metadata.root }, { $set: metadata }, { upsert: true }, (err, numAffected) => {
            if (err) {
                logger.error(`error saving file scanner metadata: ${err}`);
            }
        });
    }

}

module.exports = { FileEntrySchema, FileScannerMetadataSchema, FSStorage };