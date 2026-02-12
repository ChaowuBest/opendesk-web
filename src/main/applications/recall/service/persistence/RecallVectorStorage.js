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

/**
 * RecallVectorStorage - Recall 向量存储
 * 负责记忆的向量化存储和检索
 * 单例模式，参考 FSStorage 实现
 */

import path from 'path';
import fs from 'fs';
import readline from 'readline';
import { LocalIndex } from 'vectra';
import { LLM } from '../../../../agents/llm.js';
import { logger } from '../../../../utils/logger.js';
import PQueue from 'p-queue';

export class RecallVectorStorage {
    static vectorCachePath = '';
    static vecdbPath = '';

    constructor(appDataDirectory) {
        this.appDataDirectory = appDataDirectory;
        RecallVectorStorage.vectorCachePath = path.join(appDataDirectory, 'recall_vec_cache.jsonl');
        RecallVectorStorage.vecdbPath = path.join(appDataDirectory, 'recall_vec_storage.db');

        /** @type {Map<string, number[]>} */
        this.vecCache = new Map();
        this.vecdb = new LocalIndex(RecallVectorStorage.vecdbPath);
        this.writeQueue = new PQueue({ concurrency: 1 });
    }

    async initialize() {
        const startTime = Date.now();
        logger.info(`[RecallVectorStorage] Loading vector cache from ${this.vectorCachePath}`);

        // 加载向量缓存
        if (fs.existsSync(this.vectorCachePath)) {
            const fileStream = fs.createReadStream(this.vectorCachePath, { encoding: 'utf-8' });
            const rl = readline.createInterface({
                input: fileStream,
                crlfDelay: Infinity
            });

            for await (const line of rl) {
                if (!line.trim()) continue;
                try {
                    const cacheItem = JSON.parse(line);
                    if (cacheItem && cacheItem.key && Array.isArray(cacheItem.vec)) {
                        this.vecCache.set(cacheItem.key, cacheItem.vec);
                    }
                } catch (e) {
                    logger.warn(`[RecallVectorStorage] Error parsing cache line: ${e.message}`);
                }
            }
        }

        logger.info(`[RecallVectorStorage] Loaded ${this.vecCache.size} vectors: ${Date.now() - startTime}ms`);

        // 初始化向量数据库
        const indexStartTime = Date.now();
        try {
            await this.vecdb.createIndex({ deleteIfExists: true });
            await this.vecdb.beginUpdate();

            for (const [key, vector] of this.vecCache.entries()) {
                await this.vecdb.insertItem({ id: key, vector });
            }

            await this.vecdb.endUpdate();
            logger.info(`[RecallVectorStorage] Index created with ${this.vecCache.size} items: ${Date.now() - indexStartTime}ms`);
        } catch (error) {
            await this.vecdb.createIndex({ deleteIfExists: true });
            logger.error(`[RecallVectorStorage] Failed to create index: ${error.message}`);
        }
    }

    /**
     * 批量保存记忆（使用 batchEmbed 提高效率）
     * @param {Array<{snapshotId: string, summary: string}>} memories
     */
    async batchSaveMemories(memories) {
        logger.info(`[RecallVectorStorage] Batch saving ${memories.length} memories`);
        if (!memories || memories.length === 0) {
            return;
        }

        // 过滤已存在和空内容
        const newMemories = memories.filter(
            m => m.summary && m.summary.trim() !== '' && !this.vecCache.has(m.snapshotId)
        );

        if (newMemories.length === 0) {
            return;
        }

        try {
            const startTime = Date.now();
            logger.info(`[RecallVectorStorage] Batch embedding ${newMemories.length} memories`);

            // 使用 batchEmbed 批量生成向量
            const summaries = newMemories.map(m => m.summary);
            const embeddings = await LLM.batchEmbed(summaries);

            const embedTime = Date.now() - startTime;
            logger.info(`[RecallVectorStorage] Batch embed completed: ${embedTime}ms`);

            // 保存到内存缓存
            for (let i = 0; i < newMemories.length; i++) {
                this.vecCache.set(newMemories[i].snapshotId, embeddings[i]);
            }

            // 写入缓存文件
            const records = newMemories.map((m, i) =>
                JSON.stringify({ key: m.snapshotId, vec: embeddings[i] })
            );
            fs.appendFileSync(RecallVectorStorage.vectorCachePath, records.join('\n') + '\n');

            // 异步批量更新向量数据库
            await this.writeQueue.add(async () => {
                try {
                    await this.vecdb.beginUpdate();
                    for (let i = 0; i < newMemories.length; i++) {
                        await this.vecdb.insertItem({
                            id: newMemories[i].snapshotId,
                            vector: embeddings[i]
                        });
                    }
                    await this.vecdb.endUpdate();
                    logger.info(`[RecallVectorStorage] Saved ${newMemories.length} vectors to vecdb`);
                } catch (error) {
                    logger.error(`[RecallVectorStorage] Failed to save to vecdb: ${error.message}`);
                }
            });

        } catch (error) {
            logger.error(`[RecallVectorStorage] Batch save failed: ${error.message}`);
            throw error;
        }
    }

    /**
     * 单个保存记忆（向后兼容，实际调用 batchSaveMemories）
     */
    async saveMemory(snapshotId, summary) {
        await this.batchSaveMemories([{ snapshotId, summary }]);
    }

    async searchMemories(query, topK = 20, threshold = 0.5) {
        try {
            const embedding = await LLM.embed(query)
            const items = await this.vecdb.queryItems(embedding, topK);

            const results = [];
            for (const item of items) {
                if (item.score >= threshold) {
                    results.push({
                        snapshotId: item.item.id,
                        score: item.score
                    });
                }
            }

            return results;
        } catch (error) {
            logger.error(`[RecallVectorStorage] Search failed: ${error.message}`);
            throw error;
        }
    }

    async waitForWrites() {
        await this.writeQueue.onIdle();
    }
}