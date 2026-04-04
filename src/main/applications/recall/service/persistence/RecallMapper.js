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
 * RecallMapper - 实体与数据库转换器
 *
 * 职责：
 * - 实体对象 ↔ 数据库原始数据的双向转换
 * - 白名单策略：自动过滤 _ 开头的运行时字段
 * - 类型转换：Boolean isMarked ↔ 0/1（数据库存储）
 */

import {
    RecallActivity,
    RecallCapture,
    RecallSnapshot,
    RecallExtraction,
    RecallTag,
    RecallTagging
} from '../entities/index.js';

export class RecallMapper {
    // ==================== Activity 转换 ====================

    /**
     * 将 RecallActivity 实体转换为数据库格式
     * @param {RecallActivity} activity 活动实体
     * @returns {Object} 数据库记录
     */
    static activityToDb(activity) {
        const dbData = {
            activityId: activity.activityId,
            activityName: activity.activityName,
            activityPath: activity.activityPath,
            startTime: activity.startTime,
            endTime: activity.endTime,
            duration: activity.duration,
            status: activity.status,
            captureMode: activity.captureMode,
            type: activity.type,
            thumbnailPath: activity.thumbnailPath,
            metadata: activity.metadata,
            pdfPath: activity.pdfPath,
            pdfStatus: activity.pdfStatus,
            captureCount: activity.captureCount,
            snapshotCount: activity.snapshotCount,
            keyframeCount: activity.keyframeCount,
            totalSize: activity.totalSize,
            createdAt: activity.createdAt,
            updatedAt: activity.updatedAt
        };

        return this._sanitizeForDb(dbData);
    }

    /**
     * 从数据库记录恢复 RecallActivity 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallActivity} 活动实体
     */
    static activityFromDb(raw) {
        // 处理 metadata 的兼容性（可能是字符串格式）
        const metadata = typeof raw.metadata === 'string' ? JSON.parse(raw.metadata) : raw.metadata || {};

        const activity = new RecallActivity(raw.activityId, raw.activityName, raw.activityPath, {
            captureMode: raw.captureMode,
            type: raw.type,
            metadata: metadata,
            pdfPath: raw.pdfPath,
            pdfStatus: raw.pdfStatus
        });

        // 恢复时间信息
        activity.startTime = raw.startTime;
        activity.endTime = raw.endTime;
        activity.duration = raw.duration;

        // 恢复状态
        activity.status = raw.status;

        // 恢复 PDF 相关
        activity.pdfPath = raw.pdfPath || null;
        activity.pdfStatus = raw.pdfStatus || null;

        // 恢复统计信息
        activity.captureCount = raw.captureCount || 0;
        activity.snapshotCount = raw.snapshotCount || 0;
        activity.keyframeCount = raw.keyframeCount || 0;
        activity.totalSize = raw.totalSize || 0;

        // 恢复元数据
        activity.thumbnailPath = raw.thumbnailPath;

        // 恢复时间戳
        activity.createdAt = raw.createdAt;
        activity.updatedAt = raw.updatedAt;

        // 运行时字段保持为 null（不从数据库恢复）
        activity._interval = null;
        activity._latestThumbnails = [];
        activity._captureStrategy = null;
        activity._displayConfigs = null;
        activity._captureInterval = null;
        activity._captureTargets = null;
        activity._pendingActivityTags = null;

        return activity;
    }

    // ==================== Snapshot 转换 ====================

    /**
     * 将 RecallSnapshot 实体转换为数据库格式
     * @param {RecallSnapshot} snapshot 快照实体
     * @returns {Object} 数据库记录
     */
    static snapshotToDb(snapshot) {
        return {
            snapshotId: snapshot.snapshotId,
            captureId: snapshot.captureId,
            activityId: snapshot.activityId,
            sourceType: snapshot.sourceType,
            sourceId: snapshot.sourceId,
            sourceName: snapshot.sourceName,
            sourceIndex: snapshot.sourceIndex,
            imagePath: snapshot.imagePath,
            thumbnailPath: snapshot.thumbnailPath,
            imageFormat: snapshot.imageFormat,
            imageWidth: snapshot.imageWidth,
            imageHeight: snapshot.imageHeight,
            imageSize: snapshot.imageSize,
            isMarked: snapshot.isMarked ? 1 : 0, // Boolean → 0/1
            isKeyframe: snapshot.isKeyframe ? 1 : 0, // Boolean → 0/1
            dHash: snapshot.dHash,
            hasAnnotation: snapshot.hasAnnotation ? 1 : 0,
            hasExtraction: snapshot.hasExtraction ? 1 : 0,
            extractionStatus: snapshot.extractionStatus,
            metadata: snapshot.metadata,
            createdAt: snapshot.createdAt
        };
    }

    /**
     * 从数据库记录恢复 RecallSnapshot 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallSnapshot} 快照实体
     */
    static snapshotFromDb(raw) {
        return new RecallSnapshot(raw.snapshotId, raw.captureId, raw.activityId, {
            sourceType: raw.sourceType,
            sourceId: raw.sourceId,
            sourceName: raw.sourceName,
            sourceIndex: raw.sourceIndex,
            imagePath: raw.imagePath,
            thumbnailPath: raw.thumbnailPath,
            imageFormat: raw.imageFormat,
            imageWidth: raw.imageWidth,
            imageHeight: raw.imageHeight,
            imageSize: raw.imageSize,
            isMarked: Boolean(raw.isMarked), // 0/1 → Boolean
            isKeyframe: Boolean(raw.isKeyframe), // 0/1 → Boolean
            hasAnnotation: Boolean(raw.hasAnnotation),
            hasExtraction: Boolean(raw.hasExtraction),
            extractionStatus: raw.extractionStatus,
            dHash: raw.dHash,
            metadata: raw.metadata || {},
            createdAt: raw.createdAt // 恢复创建时间
        });
    }

    // ==================== Capture 转换 ====================

    /**
     * 将 RecallCapture 实体转换为数据库格式
     * @param {RecallCapture} capture 捕获实体
     * @returns {Object} 数据库记录
     */
    static captureToDb(capture) {
        return {
            captureId: capture.captureId,
            activityId: capture.activityId,
            captureTime: capture.captureTime,
            captureIndex: capture.captureIndex,
            captureFolderName: capture.captureFolderName,
            triggerType: capture.triggerType,
            eventType: capture.eventType,
            captureStrategy: capture.captureStrategy,
            captureTargets: capture.captureTargets,
            snapshotCount: capture.snapshotCount,
            isMarked: capture.isMarked ? 1 : 0, // Boolean → 0/1
            createdAt: capture.createdAt
        };
    }

    /**
     * 从数据库记录恢复 RecallCapture 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallCapture} 捕获实体
     */
    static captureFromDb(raw) {
        return new RecallCapture(raw.captureId, raw.activityId, raw.captureIndex, {
            captureFolderName: raw.captureFolderName,
            triggerType: raw.triggerType,
            eventType: raw.eventType,
            captureStrategy: raw.captureStrategy,
            captureTargets: raw.captureTargets || [],
            isMarked: Boolean(raw.isMarked) // 0/1 → Boolean
        });
    }

    // ==================== Extraction 转换 ====================

    /**
     * 将 RecallExtraction 实体转换为数据库格式
     * @param {RecallExtraction} extraction 提取实体
     * @returns {Object} 数据库记录
     */
    static extractionToDb(extraction) {
        return {
            extractionId: extraction.extractionId,
            snapshotId: extraction.snapshotId,
            activityId: extraction.activityId,
            contentType: extraction.contentType,
            content: extraction.content,
            confidence: extraction.confidence,
            pageType: extraction.pageType,
            createdAt: extraction.createdAt
        };
    }

    /**
     * 从数据库记录恢复 RecallExtraction 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallExtraction} 提取实体
     */
    static extractionFromDb(raw) {
        return new RecallExtraction(raw.extractionId, raw.snapshotId, raw.activityId, {
            contentType: raw.contentType,
            content: raw.content,
            confidence: raw.confidence,
            pageType: raw.pageType
        });
    }

    // ==================== Tag 转换 ====================

    /**
     * 将 RecallTag 实体转换为数据库格式
     * @param {RecallTag} tag 标签实体
     * @returns {Object} 数据库记录
     */
    static tagToDb(tag) {
        return {
            tagId: tag.tagId,
            tagName: tag.tagName,
            tagColor: tag.tagColor,
            tagIcon: tag.tagIcon,
            usageCount: tag.usageCount,
            isSystem: tag.isSystem ? 1 : 0, // Boolean → 0/1
            createdAt: tag.createdAt,
            updatedAt: tag.updatedAt
        };
    }

    /**
     * 从数据库记录恢复 RecallTag 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallTag} 标签实体
     */
    static tagFromDb(raw) {
        return new RecallTag(raw.tagId, raw.tagName, {
            tagColor: raw.tagColor,
            tagIcon: raw.tagIcon,
            usageCount: raw.usageCount || 0,
            isSystem: Boolean(raw.isSystem), // 0/1 → Boolean
            createdAt: raw.createdAt,
            updatedAt: raw.updatedAt
        });
    }

    // ==================== Tagging 转换 ====================

    /**
     * 将 RecallTagging 实体转换为数据库格式
     * @param {RecallTagging} tagging 标签关联实体
     * @returns {Object} 数据库记录
     */
    static taggingToDb(tagging) {
        return {
            taggingId: tagging.taggingId,
            tagId: tagging.tagId,
            tagName: tagging.tagName,
            entityType: tagging.entityType,
            entityId: tagging.entityId,
            confidence: tagging.confidence,
            source: tagging.source,
            createdAt: tagging.createdAt,
            createdBy: tagging.createdBy
        };
    }

    /**
     * 从数据库记录恢复 RecallTagging 实体
     * @param {Object} raw 数据库原始记录
     * @returns {RecallTagging} 标签关联实体
     */
    static taggingFromDb(raw) {
        return new RecallTagging(raw.taggingId, raw.tagId, raw.tagName, raw.entityType, raw.entityId, {
            confidence: raw.confidence || 1.0,
            source: raw.source || 'manual',
            createdAt: raw.createdAt,
            createdBy: raw.createdBy || 'system'
        });
    }

    // ==================== 私有辅助方法 ====================

    /**
     * 白名单过滤：移除所有 _ 开头的运行时字段
     * @param {Object} obj 要过滤的对象
     * @returns {Object} 过滤后的对象
     * @private
     */
    static _sanitizeForDb(obj) {
        const sanitized = {};
        for (const key in obj) {
            // 跳过 _ 开头的字段（运行时字段）
            if (!key.startsWith('_')) {
                sanitized[key] = obj[key];
            }
        }
        return sanitized;
    }
}
