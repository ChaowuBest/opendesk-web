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
 * RecallRepository - Recall 数据仓储
 *
 * 职责：
 * - 封装所有 7 个 NeDB 实例的初始化
 * - 建立所有数据库索引
 * - 提供语义化的 CRUD 方法
 * - 统一错误处理和日志记录
 */

import nedb from 'nedb-promises';
import path from 'path';
import { logger } from '../../../../utils/logger.js';
import { RecallMapper } from './RecallMapper.js';

export class RecallRepository {
    /**
     * 创建 RecallRepository 实例
     * @param {string} appDataDirectory 应用数据目录
     */
    constructor(appDataDirectory) {
        this.appDataDirectory = appDataDirectory;

        // 初始化 7 个数据库实例
        this.activityDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_activities.db'),
            autoload: true
        });

        this.captureDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_captures.db'),
            autoload: true
        });

        this.snapshotDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_snapshots.db'),
            autoload: true
        });

        this.extractionDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_extractions.db'),
            autoload: true
        });

        this.tagDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_tags.db'),
            autoload: true
        });

        this.taggingDb = nedb.create({
            filename: path.join(appDataDirectory, 'recall_taggings.db'),
            autoload: true
        });

        // 初始化索引
        this._initializeIndexes();
    }

    /**
     * 初始化数据库索引（31 个索引）
     * @private
     */
    async _initializeIndexes() {
        try {
            // Activity 表索引 (4个)
            await this.activityDb.ensureIndex({ fieldName: 'activityId', unique: true });
            await this.activityDb.ensureIndex({ fieldName: 'startTime' });
            await this.activityDb.ensureIndex({ fieldName: 'status' });
            await this.activityDb.ensureIndex({ fieldName: 'pdfStatus' });

            // Capture 表索引 (4个)
            await this.captureDb.ensureIndex({ fieldName: 'captureId', unique: true });
            await this.captureDb.ensureIndex({ fieldName: 'activityId' });
            await this.captureDb.ensureIndex({ fieldName: 'captureTime' });
            await this.captureDb.ensureIndex({ fieldName: 'isMarked' });

            // Snapshot 表索引 (9个)
            await this.snapshotDb.ensureIndex({ fieldName: 'snapshotId', unique: true });
            await this.snapshotDb.ensureIndex({ fieldName: 'captureId' });
            await this.snapshotDb.ensureIndex({ fieldName: 'activityId' });
            await this.snapshotDb.ensureIndex({ fieldName: 'sourceType' });
            await this.snapshotDb.ensureIndex({ fieldName: 'isMarked' });
            await this.snapshotDb.ensureIndex({ fieldName: 'hasAnnotation' });
            await this.snapshotDb.ensureIndex({ fieldName: 'hasExtraction' });
            await this.snapshotDb.ensureIndex({ fieldName: ['sourceType', 'sourceId'] }); // 复合索引
            await this.snapshotDb.ensureIndex({ fieldName: 'sourceIndex' });

            // Extraction 表索引 (4个)
            await this.extractionDb.ensureIndex({ fieldName: 'extractionId', unique: true });
            await this.extractionDb.ensureIndex({ fieldName: 'snapshotId' });
            await this.extractionDb.ensureIndex({ fieldName: 'activityId' });
            await this.extractionDb.ensureIndex({ fieldName: 'contentType' });

            // Tag 表索引 (2个)
            await this.tagDb.ensureIndex({ fieldName: 'tagId', unique: true });
            await this.tagDb.ensureIndex({ fieldName: 'tagName', unique: true });

            // Tagging 表索引 (5个)
            await this.taggingDb.ensureIndex({ fieldName: 'taggingId', unique: true });
            await this.taggingDb.ensureIndex({ fieldName: 'entityType' });
            await this.taggingDb.ensureIndex({ fieldName: 'entityId' });
            await this.taggingDb.ensureIndex({ fieldName: 'tagId' });
            await this.taggingDb.ensureIndex({ fieldName: 'tagName' });
        } catch (error) {
            logger.error('Failed to initialize database indexes', error);
        }
    }

    // ==================== Activity 操作 ====================

    /**
     * 保存或更新活动（upsert）
     * @param {RecallActivity} activity 活动实体
     * @returns {Promise<RecallActivity>} 保存后的活动实体
     */
    async saveActivity(activity) {
        try {
            const dbData = RecallMapper.activityToDb(activity);
            await this.activityDb.update(
                { activityId: activity.activityId },
                dbData,
                { upsert: true }
            );
            return activity;
        } catch (error) {
            logger.error(`Failed to save activity ${activity.activityId}:`, error);
            throw error;
        }
    }

    /**
     * 按 ID 查找活动
     * @param {string} activityId 活动ID
     * @returns {Promise<RecallActivity|null>} 活动实体或 null
     */
    async findActivityById(activityId) {
        try {
            const raw = await this.activityDb.findOne({ activityId });
            return raw ? RecallMapper.activityFromDb(raw) : null;
        } catch (error) {
            logger.error(`Failed to find activity ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 按时间范围查找活动
     * @param {number} startTime 开始时间戳
     * @param {number} endTime 结束时间戳
     * @returns {Promise<RecallActivity[]>} 活动列表（按 startTime 降序）
     */
    async findActivitiesByTimeRange(startTime, endTime) {
        try {
            const rawList = await this.activityDb.find({
                activityId: { $ne: null },
                startTime: { $gte: startTime, $lte: endTime }
            }).sort({ startTime: -1 });

            return rawList.map(raw => RecallMapper.activityFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find activities in time range [${startTime}, ${endTime}]:`, error);
            throw error;
        }
    }

    /**
     * 级联删除活动及其所有关联数据
     * 删除顺序：Activity → Captures → Snapshots → Annotations → Extractions → Taggings
     * @param {string} activityId 活动ID
     * @returns {Promise<void>}
     */
    async deleteActivityCascade(activityId) {
        try {
            // 1. 先查询所有关联的 Capture IDs 和 Snapshot IDs（在删除之前）
            const captures = await this.captureDb.find({ activityId });
            const captureIds = captures.map(c => c.captureId);

            const snapshots = await this.snapshotDb.find({ activityId });
            const snapshotIds = snapshots.map(s => s.snapshotId);

            logger.debug(`Found ${captureIds.length} captures and ${snapshotIds.length} snapshots for activity ${activityId}`);

            // 2. 删除 Snapshot 级别的 Taggings
            let snapshotTaggingCount = 0;
            if (snapshotIds.length > 0) {
                snapshotTaggingCount = await this.taggingDb.remove(
                    { entityType: 'snapshot', entityId: { $in: snapshotIds } },
                    { multi: true }
                );
                logger.debug(`Deleted ${snapshotTaggingCount} snapshot-level taggings`);
            }

            // 3. 删除 Capture 级别的 Taggings
            let captureTaggingCount = 0;
            if (captureIds.length > 0) {
                captureTaggingCount = await this.taggingDb.remove(
                    { entityType: 'capture', entityId: { $in: captureIds } },
                    { multi: true }
                );
                logger.debug(`Deleted ${captureTaggingCount} capture-level taggings`);
            }

            // 4. 删除 Activity 级别的 Taggings
            const activityTaggingCount = await this.taggingDb.remove(
                { entityType: 'activity', entityId: activityId },
                { multi: true }
            );
            logger.debug(`Deleted ${activityTaggingCount} activity-level taggings`);

            // 5. 删除所有 Extractions
            const extractionResult = await this.extractionDb.remove({ activityId }, { multi: true });
            logger.debug(`Deleted ${extractionResult} extractions for activity ${activityId}`);

            // 6. 删除所有 Snapshots
            const snapshotResult = await this.snapshotDb.remove({ activityId }, { multi: true });
            logger.debug(`Deleted ${snapshotResult} snapshots for activity ${activityId}`);

            // 7. 删除所有 Captures
            const captureResult = await this.captureDb.remove({ activityId }, { multi: true });
            logger.debug(`Deleted ${captureResult} captures for activity ${activityId}`);

            // 8. 删除 Activity
            await this.activityDb.remove({ activityId });
        } catch (error) {
            logger.error(`Failed to cascade delete activity ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 更新活动的元数据（整体替换）
     * @param {string} activityId 活动ID
     * @param {Object} metadata 新的元数据
     * @returns {Promise<void>}
     */
    async updateActivityMetadata(activityId, metadata) {
        try {
            await this.activityDb.update(
                { activityId },
                { $set: { metadata, updatedAt: Date.now() } }
            );
        } catch (error) {
            logger.error(`Failed to update activity metadata for ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 更新活动字段（支持嵌套字段，使用 $set 操作符）
     * @param {string} activityId 活动ID
     * @param {Object} updates $set 更新对象（如 { 'metadata.pdf.status': 'processing' }）
     * @returns {Promise<void>}
     */
    async updateActivityFields(activityId, updates) {
        try {
            // 自动添加 updatedAt 字段
            const setUpdates = {
                ...updates,
                updatedAt: Date.now()
            };

            await this.activityDb.update(
                { activityId },
                { $set: setUpdates }
            );
        } catch (error) {
            logger.error(`Failed to update activity fields for ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 批量查询活动（按 ID 列表）
     * @param {string[]} activityIds 活动ID列表
     * @returns {Promise<RecallActivity[]>} 活动列表
     */
    async findActivitiesByIds(activityIds) {
        try {
            const rawList = await this.activityDb.find({
                activityId: { $in: activityIds }
            });
            return rawList.map(raw => RecallMapper.activityFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find activities by IDs:`, error);
            throw error;
        }
    }

    // ==================== Snapshot 操作 ====================

    /**
     * 保存快照
     * @param {RecallSnapshot} snapshot 快照实体
     * @returns {Promise<RecallSnapshot>} 保存后的快照实体
     */
    async saveSnapshot(snapshot) {
        try {
            const dbData = RecallMapper.snapshotToDb(snapshot);
            await this.snapshotDb.insert(dbData);
            return snapshot;
        } catch (error) {
            logger.error(`Failed to save snapshot ${snapshot.snapshotId}:`, error);
            throw error;
        }
    }

    /**
     * 查找活动的所有快照
     * @param {string} activityId 活动ID
     * @returns {Promise<RecallSnapshot[]>} 快照列表（按 createdAt 升序）
     */
    async findSnapshotsByActivity(activityId) {
        try {
            const rawList = await this.snapshotDb.find({ activityId }).sort({ createdAt: 1 });
            return rawList.map(raw => RecallMapper.snapshotFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find snapshots for activity ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 查找活动的关键帧
     * @param {string} activityId 活动ID
     * @returns {Promise<RecallSnapshot[]>} 关键帧列表（按 createdAt 升序）
     */
    async findKeyframesByActivity(activityId) {
        try {
            const rawList = await this.snapshotDb.find({
                activityId,
                isKeyframe: true
            }).sort({ createdAt: 1 });

            return rawList.map(raw => RecallMapper.snapshotFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find keyframes for activity ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 更新快照的标记状态
     * @param {string} snapshotId 快照ID
     * @param {boolean} isMarked 是否标记
     * @returns {Promise<void>}
     */
    async updateSnapshotMark(snapshotId, isMarked) {
        try {
            await this.snapshotDb.update(
                { snapshotId },
                { $set: { isMarked: isMarked ? 1 : 0 } }
            );
        } catch (error) {
            logger.error(`Failed to update snapshot mark for ${snapshotId}:`, error);
            throw error;
        }
    }

    async findSnapshotsByIds(snapshotIds) {
        try {
            const rawList = await this.snapshotDb.find({
                snapshotId: { $in: snapshotIds }
            });
            return rawList.map(raw => RecallMapper.snapshotFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find snapshots by IDs:`, error);
            throw error;
        }
    }

    /**
     * 通用快照查询（支持任意查询条件和排序）
     * @param {Object} query 查询条件（NeDB 格式）
     * @param {Object} options 查询选项 { sort: {field: 1/-1}, limit, skip }
     * @returns {Promise<RecallSnapshot[]>} 快照列表
     */
    async findSnapshotsByQuery(query, options = {}) {
        try {
            let cursor = this.snapshotDb.find(query);

            if (options.sort) {
                cursor = cursor.sort(options.sort);
            }

            if (options.limit) {
                cursor = cursor.limit(options.limit);
            }

            if (options.skip) {
                cursor = cursor.skip(options.skip);
            }

            const rawList = await cursor;
            return rawList.map(raw => RecallMapper.snapshotFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find snapshots by query:`, error);
            throw error;
        }
    }

    /**
     * 更新快照字段（使用 $set 操作符）
     * @param {string} snapshotId 快照ID
     * @param {Object} updates $set 更新对象
     * @returns {Promise<void>}
     */
    async updateSnapshotFields(snapshotId, updates) {
        try {
            await this.snapshotDb.update(
                { snapshotId },
                { $set: updates }
            );
        } catch (error) {
            logger.error(`Failed to update snapshot fields for ${snapshotId}:`, error);
            throw error;
        }
    }

    // ==================== Capture 操作 ====================

    /**
     * 保存捕获记录
     * @param {RecallCapture} capture 捕获实体
     * @returns {Promise<RecallCapture>} 保存后的捕获实体
     */
    async saveCapture(capture) {
        try {
            const dbData = RecallMapper.captureToDb(capture);
            await this.captureDb.insert(dbData);
            return capture;
        } catch (error) {
            logger.error(`Failed to save capture ${capture.captureId}:`, error);
            throw error;
        }
    }

    /**
     * 查找活动的所有捕获记录
     * @param {string} activityId 活动ID
     * @returns {Promise<RecallCapture[]>} 捕获记录列表
     */
    async findCapturesByActivity(activityId) {
        try {
            const rawList = await this.captureDb.find({ activityId }).sort({ captureTime: 1 });
            return rawList.map(raw => RecallMapper.captureFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find captures for activity ${activityId}:`, error);
            throw error;
        }
    }

    /**
     * 批量查询多个活动的捕获记录
     * @param {string[]} activityIds 活动ID列表
     * @returns {Promise<RecallCapture[]>} 捕获记录列表
     */
    async findCapturesByActivityIds(activityIds) {
        try {
            const rawList = await this.captureDb.find({
                activityId: { $in: activityIds }
            });
            return rawList.map(raw => RecallMapper.captureFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find captures by activity IDs:`, error);
            throw error;
        }
    }

    // ==================== Extraction 操作 ====================

    /**
     * 保存提取内容
     * @param {RecallExtraction} extraction 提取实体
     * @returns {Promise<RecallExtraction>} 保存后的提取实体
     */
    async saveExtraction(extraction) {
        try {
            const dbData = RecallMapper.extractionToDb(extraction);
            await this.extractionDb.insert(dbData);
            return extraction;
        } catch (error) {
            logger.error(`Failed to save extraction ${extraction.extractionId}:`, error);
            throw error;
        }
    }

    /**
     * 查找快照的所有提取内容
     * @param {string} snapshotId 快照ID
     * @returns {Promise<RecallExtraction[]>} 提取内容列表
     */
    async findExtractionsBySnapshot(snapshotId) {
        try {
            const rawList = await this.extractionDb.find({ snapshotId });
            return rawList.map(raw => RecallMapper.extractionFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find extractions for snapshot ${snapshotId}:`, error);
            throw error;
        }
    }

    // ==================== Tag 操作（纯 CRUD）====================

    /**
     * 按名称查找标签
     * @param {string} tagName 标签名称
     * @returns {Promise<RecallTag|null>} 标签实体或 null
     */
    async findTagByName(tagName) {
        try {
            const raw = await this.tagDb.findOne({ tagName });
            return raw ? RecallMapper.tagFromDb(raw) : null;
        } catch (error) {
            logger.error(`Failed to find tag by name ${tagName}:`, error);
            throw error;
        }
    }

    /**
     * 插入新标签
     * @param {RecallTag} tag 标签实体
     * @returns {Promise<RecallTag>} 插入后的标签实体
     */
    async insertTag(tag) {
        try {
            const dbData = RecallMapper.tagToDb(tag);
            await this.tagDb.insert(dbData);
            return tag;
        } catch (error) {
            logger.error(`Failed to insert tag ${tag.tagName}:`, error);
            throw error;
        }
    }

    /**
     * 查找已存在的标签关联
     * @param {string} entityType 实体类型
     * @param {string} entityId 实体ID
     * @param {string} tagName 标签名称
     * @returns {Promise<RecallTagging|null>} 标签关联实体或 null
     */
    async findTagging(entityType, entityId, tagName) {
        try {
            const raw = await this.taggingDb.findOne({ entityType, entityId, tagName });
            return raw ? RecallMapper.taggingFromDb(raw) : null;
        } catch (error) {
            logger.error(`Failed to find tagging ${tagName} → ${entityType}:${entityId}:`, error);
            throw error;
        }
    }

    /**
     * 插入标签关联
     * @param {RecallTagging} tagging 标签关联实体
     * @returns {Promise<RecallTagging>} 插入后的标签关联实体
     */
    async insertTagging(tagging) {
        try {
            const dbData = RecallMapper.taggingToDb(tagging);
            await this.taggingDb.insert(dbData);
            return tagging;
        } catch (error) {
            logger.error(`Failed to insert tagging:`, error);
            throw error;
        }
    }

    /**
     * 增加标签使用计数
     * @param {string} tagId 标签ID
     * @param {number} increment 增量（正数增加，负数减少）
     * @returns {Promise<void>}
     */
    async incrementTagUsageCount(tagId, increment = 1) {
        try {
            await this.tagDb.update(
                { tagId },
                { $inc: { usageCount: increment }, $set: { updatedAt: Date.now() } }
            );
        } catch (error) {
            logger.error(`Failed to increment tag usage count for ${tagId}:`, error);
            throw error;
        }
    }

    /**
     * 查询所有标签
     * @param {Object} options 查询选项 { sort: {field: 1/-1}, limit }
     * @returns {Promise<RecallTag[]>} 标签列表
     */
    async findAllTags(options = {}) {
        try {
            let cursor = this.tagDb.find({});

            if (options.sort) {
                cursor = cursor.sort(options.sort);
            }

            if (options.limit) {
                cursor = cursor.limit(options.limit);
            }

            const rawList = await cursor;
            return rawList.map(raw => RecallMapper.tagFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find all tags:`, error);
            throw error;
        }
    }

    /**
     * 批量查询标签（按 ID 列表）
     * @param {string[]} tagIds 标签ID列表
     * @returns {Promise<RecallTag[]>} 标签列表
     */
    async findTagsByIds(tagIds) {
        try {
            const rawList = await this.tagDb.find({
                tagId: { $in: tagIds }
            });
            return rawList.map(raw => RecallMapper.tagFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find tags by IDs:`, error);
            throw error;
        }
    }

    /**
     * 删除标签关联（支持任意查询条件）
     * @param {Object} query 查询条件（NeDB 格式）
     * @returns {Promise<number>} 删除的记录数
     */
    async removeTaggings(query) {
        try {
            const result = await this.taggingDb.remove(query, { multi: true });
            return result;
        } catch (error) {
            logger.error(`Failed to remove taggings:`, error);
            throw error;
        }
    }

    /**
     * 查询标签关联（支持任意查询条件和排序）
     * @param {Object} query 查询条件（NeDB 格式）
     * @param {Object} options 查询选项 { sort: {field: 1/-1}, limit }
     * @returns {Promise<RecallTagging[]>} 标签关联列表
     */
    async findTaggings(query, options = {}) {
        try {
            let cursor = this.taggingDb.find(query);

            if (options.sort) {
                cursor = cursor.sort(options.sort);
            }

            if (options.limit) {
                cursor = cursor.limit(options.limit);
            }

            const rawList = await cursor;
            return rawList.map(raw => RecallMapper.taggingFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find taggings:`, error);
            throw error;
        }
    }

    /**
     * 批量查询多个活动的标签关联
     * @param {string[]} activityIds 活动ID列表
     * @returns {Promise<RecallTagging[]>} 标签关联列表
     */
    async findTaggingsByActivityIds(activityIds) {
        try {
            const rawList = await this.taggingDb.find({
                entityType: 'activity',
                entityId: { $in: activityIds }
            });
            return rawList.map(raw => RecallMapper.taggingFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find taggings by activity IDs:`, error);
            throw error;
        }
    }

    /**
     * 批量查询多个实体的标签关联（支持 $or 查询）
     * @param {Object[]} entityQueries 实体查询数组 [{ entityType, entityId }, ...]
     * @returns {Promise<RecallTagging[]>} 标签关联列表
     */
    async findTaggingsByEntityQueries(entityQueries) {
        try {
            if (!entityQueries || entityQueries.length === 0) {
                return [];
            }

            const rawList = await this.taggingDb.find({
                $or: entityQueries
            });
            return rawList.map(raw => RecallMapper.taggingFromDb(raw));
        } catch (error) {
            logger.error(`Failed to find taggings by entity queries:`, error);
            throw error;
        }
    }

    // ==================== 辅助方法 ====================

    /**
     * 获取活动的统计信息
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 统计信息
     */
    async getActivityStats(activityId) {
        try {
            const captureCount = await this.captureDb.count({ activityId });
            const snapshotCount = await this.snapshotDb.count({ activityId });
            const keyframeCount = await this.snapshotDb.count({
                activityId,
                isKeyframe: 1
            });

            return {
                captureCount,
                snapshotCount,
                keyframeCount
            };
        } catch (error) {
            logger.error(`Failed to get activity stats for ${activityId}:`, error);
            throw error;
        }
    }
}
