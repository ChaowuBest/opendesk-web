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

import { BaseWorker } from '../../base';
import { logger } from '../../../utils/logger.js';
import { Monitor, Window } from 'node-screenshots';
import { SnapshotProcessor } from './snapshot/snapshotProcessor.js';
import { ImageAnalyzeManager } from './snapshot/imageAnalyzeManager.js';
import { parentPort } from 'worker_threads';
import { RecallVectorStorage } from './persistence/RecallVectorStorage.js';

import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import crypto from 'crypto';

// 导入实体类和持久化层
import {
    RecallActivity,
    RecallCapture,
    RecallSnapshot,
    RecallExtraction,
    RecallTag,
    RecallTagging
} from './entities/index.js';
import { RecallRepository, RecallMapper } from './persistence/index.js';

/**
 * 生成人类可读的时间戳文件夹名
 * @param {number} captureIndex 捕获索引
 * @returns {string} 格式如 20260119_143052_001
 */
function generateCaptureFolderName(captureIndex) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hour = String(now.getHours()).padStart(2, '0');
    const minute = String(now.getMinutes()).padStart(2, '0');
    const second = String(now.getSeconds()).padStart(2, '0');
    const index = String(captureIndex).padStart(3, '0');

    return `${year}${month}${day}_${hour}${minute}${second}_${index}`;
}

// 实体类已移至 entities/ 目录

class RecallWorker extends BaseWorker {
    constructor(bundleName, appDataDirectory) {
        super(bundleName, appDataDirectory);

        /** @type {RecallActivity | null} */
        this.currentActivity = null;

        // 快照处理器 - 延迟初始化
        this.snapshotProcessor = null;

        // 初始化 RecallRepository（持久化层）
        this.repository = new RecallRepository(this.appDataDirectory);
        // 向量存储（使用单例）
        this.vectorStorage = new RecallVectorStorage(this.appDataDirectory);

        // 录制会话状态：上一帧快照信息（用于连续帧判重）
        /** @type {{ hash: string, imagePath: string, timestamp: number } | null} */
        this.lastSnapshot = null;
    }

    /**
     * 获取或创建快照处理器实例（延迟初始化）
     */
    _getSnapshotProcessor() {
        if (!this.snapshotProcessor) {
            this.snapshotProcessor = new SnapshotProcessor(this.repository, this.vectorStorage);
        }
        return this.snapshotProcessor;
    }

    async getRecallStatus() {
        // 这是一个高频调用的方法（entry.js每2秒调用一次），必须快速返回
        if (this.currentActivity === null) {
            const status = {
                status: 'idle'
            };
            return status;
        } else {
            const activityData = RecallMapper.activityToDb(this.currentActivity);

            return {
                status: 'recording',
                activity: activityData
            };
        }
    }

    /**
     * 获取历史活动：活动回顾和实时录制界面都需要
     * @param {number} startTimestamp 开始时间戳
     * @param {number} endTimestamp 结束时间戳
     * @returns {Promise<RecallActivity[]>} 历史活动列表
     */
    async getHistoryActivities(startTimestamp, endTimestamp) {
        // 使用 Repository 查询
        const activities = await this.repository.findActivitiesByTimeRange(startTimestamp, endTimestamp);

        // Convert cover.webp files to Base64 data URLs
        const activitiesWithCovers = activities.map((activity) => {
            // 转换为数据库格式（前端需要的格式）
            const activityData = RecallMapper.activityToDb(activity);

            if (activity.thumbnailPath) {
                const coverPath = path.join(activity.activityPath, 'cover.webp');

                try {
                    if (fs.existsSync(coverPath)) {
                        const coverBuffer = fs.readFileSync(coverPath);
                        activityData.coverDataURL = `data:image/webp;base64,${coverBuffer.toString('base64')}`;
                    } else {
                        activityData.coverDataURL = null;
                    }
                } catch (error) {
                    logger.error(`Failed to read cover for ${activity.activityId}: ${error.message}`);
                    activityData.coverDataURL = null;
                }
            } else {
                activityData.coverDataURL = null;
            }

            return activityData;
        });

        // 批量获取所有活动的标签
        const activityIds = activities.map((a) => a.activityId);
        const tagsResult = await this.getActivitiesAggregatedTags(activityIds);

        if (tagsResult.success && tagsResult.tagsMap) {
            activitiesWithCovers.forEach((activity) => {
                const tags = tagsResult.tagsMap[activity.activityId] || [];
                const tagObjects = tagsResult.tagObjectsMap[activity.activityId] || [];
                activity.tags = tags;
                activity.tagObjects = tagObjects;
            });
        }

        return activitiesWithCovers;
    }

    async deleteHistoryActivity(activityId) {
        // 使用 Repository 查询活动
        const activity = await this.repository.findActivityById(activityId);
        if (!activity) {
            return { success: false, message: 'history activity not found' };
        }

        try {
            // 删除文件夹
            await fs.promises.rm(activity.activityPath, { recursive: true });

            // 级联删除数据库记录（包含所有 Captures、Snapshots、Annotations、Extractions、Taggings）
            await this.repository.deleteActivityCascade(activityId);

            return { success: true };
        } catch (error) {
            logger.error(`failed to delete history activity ${activityId}: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async getHistoryActivityById(activityId) {
        // 使用 Repository 查询
        const activity = await this.repository.findActivityById(activityId);

        if (!activity) {
            return { success: false, message: 'history activity not found' };
        }

        // 转换为数据库格式返回
        return { success: true, activity: RecallMapper.activityToDb(activity) };
    }

    async saveActivity(activity) {
        activity.touch();
        // 使用 Repository 保存
        await this.repository.saveActivity(activity);
    }

    /**
     * 获取系统所有窗口列表
     * @returns {Promise<Array>} 窗口列表
     */
    async getWindowList() {
        const windows = Window.all();
        const monitors = Monitor.all();
        const result = [];

        for (const window of windows) {
            if (window.width < 200 || window.height < 200) {
                continue;
            }

            // 尝试确定窗口所在的显示器
            let displayIndex = 0; // 默认显示器0

            // 通过窗口位置判断所在显示器
            for (let i = 0; i < monitors.length; i++) {
                const monitor = monitors[i];
                // 检查窗口中心点是否在该显示器范围内
                const windowCenterX = window.x + window.width / 2;
                const windowCenterY = window.y + window.height / 2;

                if (
                    windowCenterX >= monitor.x &&
                    windowCenterX < monitor.x + monitor.width &&
                    windowCenterY >= monitor.y &&
                    windowCenterY < monitor.y + monitor.height
                ) {
                    displayIndex = i;
                    break;
                }
            }

            result.push({
                windowId: window.id,
                windowTitle: window.title,
                displayIndex: displayIndex // 添加显示器索引
            });
        }
        return result;
    }

    /**
     * 获取显示器数量
     * @returns {Promise<number>} 显示器数量
     */
    async getDisplayCount() {
        const monitors = Monitor.all();
        return monitors.length;
    }

    /**
     * 修改单个显示器的捕获配置
     * @param {number} displayIndex 显示器索引
     * @param {Object} config 配置 { captureMode: 'monitor'|'window', targetId: string|null }
     */

    async changeDisplayConfig(displayIndex, config) {
        const activity = this.currentActivity;
        if (!activity) return { success: false, message: 'recall capture is not running' };

        const monitors = Monitor.all();
        if (displayIndex < 0 || displayIndex >= monitors.length) {
            return { success: false, message: 'invalid display index' };
        }

        // 1. 确保 _displayConfigs 存在 (初始化逻辑)
        if (!activity._displayConfigs) {
            activity._displayConfigs = monitors.map((_, idx) => ({
                displayIndex: idx,
                captureMode: 'monitor',
                targetId: null
            }));
        }

        // 2. 更新特定显示器的基础配置
        Object.assign(activity._displayConfigs[displayIndex], {
            captureMode: config.captureMode,
            targetId: config.targetId
        });

        // 3. 核心：重新映射 captureTargets
        const allWindows = Window.all();
        activity._captureTargets = activity._displayConfigs.map((cfg, i) => {
            const isWindowMode = cfg.captureMode === 'window' && cfg.targetId;
            const targetWindow = isWindowMode ? allWindows.find((w) => w.id.toString() === cfg.targetId) : null;

            // 逻辑批判：如果指定了窗口但找不到，必须有 fallback
            if (isWindowMode && !targetWindow) {
                logger.warn(`window ${cfg.targetId} not found for display ${i}, falling back to monitor`);
            }

            // 统一返回对象结构，消除冗余的 push 语句
            return isWindowMode && targetWindow
                ? {
                      type: 'window',
                      id: cfg.targetId,
                      name: targetWindow.title,
                      displayIndex: i,
                      enabled: true
                  }
                : {
                      type: 'monitor',
                      id: `monitor-${i}`,
                      name: `Display ${i + 1}`,
                      displayIndex: i,
                      enabled: true
                  };
        });
        return { success: true, displayConfigs: activity._displayConfigs };
    }

    /**
     * 获取当前显示器配置
     */
    async getDisplayConfigs() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        const monitors = Monitor.all();

        // 如果没有配置，初始化为默认值（所有显示器捕获自身）
        if (!this.currentActivity._displayConfigs) {
            this.currentActivity._displayConfigs = monitors.map((m, idx) => ({
                displayIndex: idx,
                captureMode: 'monitor',
                targetId: null
            }));
        }

        return {
            success: true,
            displayConfigs: this.currentActivity._displayConfigs,
            totalDisplays: monitors.length
        };
    }

    /**
     * 开始定时截屏
     * @param {string} activityName 活动名称
     * @param {Object} options 可选配置
     */
    async startRecallCapture(activityName, options = {}) {
        if (this.currentActivity) {
            logger.warn('recall capture is already running');
            return { success: false, message: 'recall capture is already running' };
        }

        const activityId = crypto.randomUUID();
        const activityPath = path.join(this.appDataDirectory, 'activities', activityId);

        // 初始化捕获目标和显示器配置
        const monitors = Monitor.all();
        let captureTargets = [];
        let displayConfigs = [];

        // 优先使用 displayConfigs（多显示器配置）
        if (options.displayConfigs && Array.isArray(options.displayConfigs)) {
            // 使用前端传递的详细配置
            displayConfigs = options.displayConfigs;

            captureTargets = options.displayConfigs.map((config) => {
                if (config.captureMode === 'monitor') {
                    return {
                        type: 'monitor',
                        id: `monitor-${config.displayIndex}`,
                        name: `Display ${config.displayIndex + 1}`,
                        displayIndex: config.displayIndex,
                        enabled: true
                    };
                } else {
                    // captureMode === 'window'
                    const window = Window.all().find((w) => w.id.toString() === config.targetId);
                    return {
                        type: 'window',
                        id: config.targetId,
                        name: window ? window.title : `Window ${config.targetId}`,
                        displayIndex: config.displayIndex,
                        enabled: true
                    };
                }
            });
        } else {
            // 兼容旧的 selectedWindowId 模式
            const selectedWindowId = options.selectedWindowId || 'all';

            if (selectedWindowId === 'all') {
                // 录制所有显示器
                captureTargets = monitors.map((monitor, index) => ({
                    type: 'monitor',
                    id: `monitor-${index}`,
                    name: `Display ${index + 1}`,
                    displayIndex: index,
                    enabled: true
                }));
                displayConfigs = monitors.map((m, idx) => ({
                    displayIndex: idx,
                    captureMode: 'monitor',
                    targetId: null
                }));
            } else {
                // 录制特定窗口
                const window = Window.all().find((w) => w.id.toString() === selectedWindowId);
                if (window) {
                    // 普通模式：应用到所有显示器
                    captureTargets = monitors.map((monitor, index) => ({
                        type: 'window',
                        id: selectedWindowId,
                        name: window.title,
                        displayIndex: index,
                        enabled: true
                    }));
                    displayConfigs = monitors.map((m, idx) => ({
                        displayIndex: idx,
                        captureMode: 'window',
                        targetId: selectedWindowId
                    }));
                } else {
                    logger.warn(`window ${selectedWindowId} not found, using all monitors instead`);
                    captureTargets = monitors.map((monitor, index) => ({
                        type: 'monitor',
                        id: `monitor-${index}`,
                        name: `Display ${index + 1}`,
                        displayIndex: index,
                        enabled: true
                    }));
                    displayConfigs = monitors.map((m, idx) => ({
                        displayIndex: idx,
                        captureMode: 'monitor',
                        targetId: null
                    }));
                }
            }
        }

        const tags = options.tags || [];

        // 创建当前活动
        this.currentActivity = new RecallActivity(activityId, activityName, activityPath, {
            captureMode: options.captureMode || 'screenshot',
            type: options.type || 'normal',
            metadata: options.metadata || {}
        });

        // 保存 Activity 标签到 Tagging 表（异步）
        if (tags.length > 0) {
            this._pendingActivityTags = tags;
        }

        // 保存运行时配置（不持久化到 Activity 表）
        this.currentActivity._captureStrategy = options.captureStrategy || 'monitor';
        this.currentActivity._displayConfigs = displayConfigs;
        this.currentActivity._captureInterval = options.captureInterval || 2000;
        this.currentActivity._captureTargets = captureTargets;

        // 重置录制会话状态
        this.lastSnapshot = null;

        // 立即进行首次截图
        try {
            await this.requestScreenshot();
        } catch (error) {
            logger.error(`error in initial screenshot: ${error.message}`, error);
        }

        // 设置定时器处理后续截图
        this.currentActivity._interval = setInterval(async () => {
            try {
                await this.requestScreenshot();
            } catch (error) {
                logger.error(`error in scheduled screenshot: ${error.message}`, error);
            }
        }, this.currentActivity._captureInterval);

        // 保存活动信息到数据库
        await this.saveActivity(this.currentActivity);

        // 保存 Activity 标签到 Tagging 表
        if (this._pendingActivityTags && this._pendingActivityTags.length > 0) {
            for (const tagName of this._pendingActivityTags) {
                await this.addTagToEntity('activity', activityId, tagName, { source: 'manual' });
            }
            this._pendingActivityTags = null;
        }

        return { success: true, activity: RecallMapper.activityToDb(this.currentActivity) };
    }

    /**
     * 停止定时截屏
     */
    async stopRecallCapture() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        clearInterval(this.currentActivity._interval);

        this.currentActivity._interval = null;
        this.currentActivity.endTime = Date.now();
        this.currentActivity.duration = this.currentActivity.endTime - this.currentActivity.startTime;
        this.currentActivity.status = 'stopped';
        await this.saveActivity(this.currentActivity);

        const activityId = this.currentActivity.activityId;
        this._triggerMemoryGeneration(activityId).catch((error) => {
            logger.error(`[RecallWorker] Failed to trigger memory generation: ${error.message}`);
        });

        this.currentActivity = null;
        return { success: true };
    }

    /**
     * 异步触发记忆提取
     * @param {*} activityId
     * @returns
     */
    async _triggerMemoryGeneration(activityId) {
        try {
            logger.info(`[RecallWorker] Triggering memory generation for activity ${activityId}`);

            // 获取活动信息（用于构造完整路径）
            const activity = await this.repository.findActivityById(activityId);
            if (!activity) {
                logger.error(`[RecallWorker] Activity ${activityId} not found`);
                return;
            }

            // 直接查询未提取的快照（使用 hasExtraction 字段过滤）
            const pendingSnapshots = await this.repository.findSnapshotsByQuery(
                {
                    activityId,
                    hasExtraction: { $ne: 1 } // 未提取或提取失败的快照
                },
                { sort: { createdAt: 1 } }
            );

            if (pendingSnapshots.length === 0) {
                logger.info('[RecallWorker] No pending snapshots for memory generation');
                return;
            }

            logger.info(`[RecallWorker] Found ${pendingSnapshots.length} snapshots to process`);

            // 准备处理数据
            const snapshotsToProcess = pendingSnapshots.map((snapshot) => ({
                snapshotId: snapshot.snapshotId,
                imagePath: path.join(activity.activityPath, snapshot.imagePath),
                activityId: snapshot.activityId
            }));

            // 创建处理器实例
            const processor = this._getSnapshotProcessor();

            // 开始批量处理
            await processor.processSnapshotsMemory(snapshotsToProcess, 5);
        } catch (error) {
            logger.error(`[RecallWorker] Memory generation failed: ${error.message}`, error);
        }
    }

    /**
     * 查询单个快照的 extraction
     * @param {string} snapshotId
     */
    async getSnapshotExtractions(snapshotId) {
        try {
            const extractions = await this.repository.findExtractionsBySnapshot(snapshotId);
            return {
                success: true,
                extractions: extractions.map((e) => RecallMapper.extractionToDb(e))
            };
        } catch (error) {
            logger.error(`Failed to get snapshot extractions: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 查询活动的所有 extraction（可选，用于批量查询场景）
     */
    async getActivityExtractions(activityId) {
        try {
            const snapshots = await this.repository.findSnapshotsByActivity(activityId);
            const allExtractions = [];

            for (const snapshot of snapshots) {
                const extractions = await this.repository.findExtractionsBySnapshot(snapshot.snapshotId);
                allExtractions.push(...extractions);
            }

            return {
                success: true,
                extractions: allExtractions.map((e) => RecallMapper.extractionToDb(e))
            };
        } catch (error) {
            logger.error(`Failed to get activity extractions: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 在后台处理快照并生成PDF
     * 包括完整判重、标记关键帧和PDF生成
     */
    async _processSnapshotsAndGeneratePDF(activityId) {
        try {
            // 获取所有snapshots
            const snapshots = await this.repository.findSnapshotsByActivity(activityId);
            snapshots.sort((a, b) => a.createdAt - b.createdAt);

            // 获取活动信息
            const activityEntity = await this.repository.findActivityById(activityId);
            const activityPath = activityEntity.activityPath;

            // 完整判重，标记关键帧
            const processor = this._getSnapshotProcessor();
            const keyframesList = []; // 收集关键帧快照对象（用于比较）

            const keyframeSnapshots = []; // 直接收集关键帧对象
            for (let i = 0; i < snapshots.length; i++) {
                const snapshot = snapshots[i];
                const imagePath = path.join(activityPath, snapshot.imagePath);

                if (!fs.existsSync(imagePath)) continue;

                const imageBuffer = fs.readFileSync(imagePath);
                const dHash = await ImageAnalyzeManager.calculateImageHash(imageBuffer);

                // 使用 SnapshotProcessor 的业务方法判定关键帧
                const isKeyframe = await processor.isKeyframe({ hash: dHash, imagePath }, keyframesList);

                if (isKeyframe) {
                    keyframesList.push({ hash: dHash, imagePath });
                }

                // 更新snapshot的isKeyframe和dHash字段
                await this.repository.snapshotDb.update(
                    { snapshotId: snapshot.snapshotId },
                    { $set: { isKeyframe: isKeyframe ? 1 : 0, dHash: dHash } }
                );

                // 更新内存中的snapshot对象
                snapshot.isKeyframe = isKeyframe;
                snapshot.dHash = dHash;

                if (isKeyframe) {
                    keyframeSnapshots.push(snapshot);
                }
            }

            logger.info(`[Worker] Marked ${keyframeSnapshots.length} keyframes out of ${snapshots.length} snapshots`);

            if (keyframeSnapshots.length === 0) {
                throw new Error('No keyframes detected after processing all snapshots');
            }

            // 直接使用内存中的关键帧对象，转换为数据库格式
            const keyframes = keyframeSnapshots.map((s) => {
                const mapped = RecallMapper.snapshotToDb(s);
                logger.debug(
                    `[Worker] Keyframe snapshot: ${s.snapshotId}, isKeyframe: ${s.isKeyframe}, mapped.isKeyframe: ${mapped.isKeyframe}`
                );
                return mapped;
            });

            // 直接调用PDF生成方法（不通过processActivityResults）
            const activity = RecallMapper.activityToDb(activityEntity);
            const pdfPath = await this._getSnapshotProcessor()._generateActivityPDF(activityId, activity, keyframes);

            if (pdfPath) {
                await this.repository.updateActivityFields(activityId, {
                    pdfPath: path.relative(activityPath, pdfPath),
                    pdfStatus: 'completed',
                    keyframeCount: keyframeSnapshots.length,
                    'metadata.pdf.completedAt': Date.now()
                });
                logger.info(
                    `[Worker] PDF generation completed successfully: ${pdfPath}, keyframes: ${keyframeSnapshots.length}`
                );
            } else {
                throw new Error('PDF generation returned null path');
            }
        } catch (error) {
            logger.error(`[Worker] Background PDF generation failed:`, error);

            // 更新活动状态为失败
            try {
                await this.repository.updateActivityFields(activityId, {
                    pdfStatus: 'failed',
                    'metadata.pdf.error': error.message,
                    'metadata.pdf.failedAt': Date.now()
                });
            } catch (updateError) {
                logger.error(`[Worker] Failed to update activity status:`, updateError);
            }
        } finally {
            // 处理完成后无需重置（ImageAnalyzeManager 已无状态）
            logger.debug('[Worker] Background PDF generation completed');
        }
    }

    async getLatestThumbnails() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        return {
            success: true,
            thumbnails: this.currentActivity._latestThumbnails.map(
                (buffer) => `data:image/webp;base64,${buffer.toString('base64')}`
            )
        };
    }

    /**
     * 获取指定活动的所有截图快照
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} { success: boolean, snapshots: Array }
     */
    async getActivitySnapshots(activityId) {
        try {
            // 使用 Repository 查询快照
            const snapshotEntities = await this.repository.findSnapshotsByActivity(activityId);

            // 获取活动信息以构建完整路径
            const activityEntity = await this.repository.findActivityById(activityId);
            if (!activityEntity) {
                return { success: false, message: 'activity not found' };
            }

            // 转换为数据库格式（前端需要的格式）
            const snapshots = snapshotEntities.map((s) => RecallMapper.snapshotToDb(s));
            const activity = RecallMapper.activityToDb(activityEntity);

            // 转换为前端可用的格式,并将缩略图转换为 Base64
            const snapshotsWithPaths = snapshots.map((snapshot) => {
                const fullImagePath = path.join(activity.activityPath, snapshot.imagePath);
                const fullThumbnailPath = path.join(activity.activityPath, snapshot.thumbnailPath);

                // 读取缩略图并转换为 Base64 data URL
                let thumbnailDataURL = null;
                let imageDataURL = null;

                try {
                    if (fs.existsSync(fullThumbnailPath)) {
                        const thumbnailBuffer = fs.readFileSync(fullThumbnailPath);
                        thumbnailDataURL = `data:image/webp;base64,${thumbnailBuffer.toString('base64')}`;
                    }
                } catch (error) {
                    logger.error(`Failed to read thumbnail for snapshot ${snapshot.snapshotId}: ${error.message}`);
                }

                try {
                    if (fs.existsSync(fullImagePath)) {
                        const imageBuffer = fs.readFileSync(fullImagePath);
                        imageDataURL = `data:image/webp;base64,${imageBuffer.toString('base64')}`;
                    }
                } catch (error) {
                    logger.error(`Failed to read image for snapshot ${snapshot.snapshotId}: ${error.message}`);
                }

                return {
                    id: snapshot.snapshotId,
                    captureId: snapshot.captureId,
                    activityId: snapshot.activityId,
                    timestamp: snapshot.createdAt,
                    imagePath: fullImagePath,
                    thumbnailPath: fullThumbnailPath,
                    thumbnailDataURL: thumbnailDataURL,
                    imageDataURL: imageDataURL,
                    sourceType: snapshot.sourceType,
                    sourceName: snapshot.sourceName,
                    sourceId: snapshot.sourceId,
                    sourceIndex: snapshot.sourceIndex,
                    width: snapshot.imageWidth,
                    height: snapshot.imageHeight,
                    size: snapshot.imageSize,
                    isMarked: snapshot.isMarked
                };
            });

            return { success: true, snapshots: snapshotsWithPaths };
        } catch (error) {
            logger.error(`failed to get activity snapshots: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取所有截图快照（用于时间轴视图）
     * @param {number} startTime 开始时间戳
     * @param {number} endTime 结束时间戳
     * @param {number} limit 限制数量
     * @returns {Promise<Object>} { success: boolean, snapshots: Array }
     */
    async getAllSnapshots(startTime = 0, endTime = Date.now(), limit = 500) {
        try {
            // 使用 Repository 查询快照
            const snapshotEntities = await this.repository.findSnapshotsByQuery(
                { createdAt: { $gte: startTime, $lte: endTime } },
                { sort: { createdAt: -1 }, limit }
            );

            // 转换为数据库格式
            const snapshots = snapshotEntities.map((s) => RecallMapper.snapshotToDb(s));

            // 获取所有相关活动信息
            const activityIds = [...new Set(snapshots.map((s) => s.activityId))];
            const activityEntities = await this.repository.findActivitiesByIds(activityIds);
            const activities = activityEntities.map((a) => RecallMapper.activityToDb(a));
            const activityMap = new Map(activities.map((a) => [a.activityId, a]));

            // 转换为前端可用的格式,并将缩略图转换为 Base64
            const snapshotsWithPaths = snapshots.map((snapshot) => {
                const activity = activityMap.get(snapshot.activityId);
                if (!activity) return null;

                const fullImagePath = path.join(activity.activityPath, snapshot.imagePath);
                const fullThumbnailPath = path.join(activity.activityPath, snapshot.thumbnailPath);

                // 读取缩略图并转换为 Base64 data URL
                let thumbnailDataURL = null;
                let imageDataURL = null;

                try {
                    if (fs.existsSync(fullThumbnailPath)) {
                        const thumbnailBuffer = fs.readFileSync(fullThumbnailPath);
                        thumbnailDataURL = `data:image/webp;base64,${thumbnailBuffer.toString('base64')}`;
                    }
                } catch (error) {
                    logger.error(`Failed to read thumbnail for snapshot ${snapshot.snapshotId}: ${error.message}`);
                }

                try {
                    if (fs.existsSync(fullImagePath)) {
                        const imageBuffer = fs.readFileSync(fullImagePath);
                        imageDataURL = `data:image/webp;base64,${imageBuffer.toString('base64')}`;
                    }
                } catch (error) {
                    logger.error(`Failed to read image for snapshot ${snapshot.snapshotId}: ${error.message}`);
                }

                return {
                    id: snapshot.snapshotId,
                    captureId: snapshot.captureId,
                    activityId: snapshot.activityId,
                    activityName: activity.activityName,
                    timestamp: snapshot.createdAt,
                    imagePath: fullImagePath,
                    thumbnailPath: fullThumbnailPath,
                    thumbnailDataURL: thumbnailDataURL,
                    imageDataURL: imageDataURL,
                    sourceType: snapshot.sourceType,
                    sourceName: snapshot.sourceName,
                    sourceId: snapshot.sourceId,
                    sourceIndex: snapshot.sourceIndex,
                    width: snapshot.imageWidth,
                    height: snapshot.imageHeight,
                    size: snapshot.imageSize,
                    isMarked: snapshot.isMarked
                };
            });
            const filteredSnapshots = snapshotsWithPaths.filter((s) => s !== null);

            return { success: true, snapshots: filteredSnapshots };
        } catch (error) {
            logger.error(`failed to get all snapshots: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async searchSnapshots(query) {
        const vecResults = await this.vectorStorage.searchMemories(query);
        let snapshots = await this.repository.findSnapshotsByIds(vecResults.map((r) => r.snapshotId));
        snapshots = snapshots.map((s) => RecallMapper.snapshotToDb(s));

        // 获取所有相关活动信息
        const activityIds = [...new Set(snapshots.map((s) => s.activityId))];
        const activityEntities = await this.repository.findActivitiesByIds(activityIds);
        const activities = activityEntities.map((a) => RecallMapper.activityToDb(a));
        const activityMap = new Map(activities.map((a) => [a.activityId, a]));

        // 转换为前端可用的格式,并将缩略图转换为 Base64
        const snapshotsWithPaths = snapshots.map((snapshot) => {
            const activity = activityMap.get(snapshot.activityId);
            if (!activity) return null;

            const fullImagePath = path.join(activity.activityPath, snapshot.imagePath);
            const fullThumbnailPath = path.join(activity.activityPath, snapshot.thumbnailPath);

            // 读取缩略图并转换为 Base64 data URL
            let thumbnailDataURL = null;
            let imageDataURL = null;

            try {
                if (fs.existsSync(fullThumbnailPath)) {
                    const thumbnailBuffer = fs.readFileSync(fullThumbnailPath);
                    thumbnailDataURL = `data:image/webp;base64,${thumbnailBuffer.toString('base64')}`;
                }
            } catch (error) {
                logger.error(`Failed to read thumbnail for snapshot ${snapshot.snapshotId}: ${error.message}`);
            }

            try {
                if (fs.existsSync(fullImagePath)) {
                    const imageBuffer = fs.readFileSync(fullImagePath);
                    imageDataURL = `data:image/webp;base64,${imageBuffer.toString('base64')}`;
                }
            } catch (error) {
                logger.error(`Failed to read image for snapshot ${snapshot.snapshotId}: ${error.message}`);
            }

            return {
                id: snapshot.snapshotId,
                captureId: snapshot.captureId,
                activityId: snapshot.activityId,
                activityName: activity.activityName,
                timestamp: snapshot.createdAt,
                imagePath: fullImagePath,
                thumbnailPath: fullThumbnailPath,
                thumbnailDataURL: thumbnailDataURL,
                imageDataURL: imageDataURL,
                sourceType: snapshot.sourceType,
                sourceName: snapshot.sourceName,
                sourceId: snapshot.sourceId,
                sourceIndex: snapshot.sourceIndex,
                width: snapshot.imageWidth,
                height: snapshot.imageHeight,
                size: snapshot.imageSize,
                isMarked: snapshot.isMarked
            };
        });
        const filteredSnapshots = snapshotsWithPaths.filter((s) => s !== null);

        return { success: true, snapshots: filteredSnapshots };
    }

    /**
     * 更新截图的标记状态
     * @param {string} snapshotId 截图ID
     * @param {boolean} isMarked 是否标记
     * @returns {Promise<Object>} { success: boolean }
     */
    async updateSnapshotMark(snapshotId, isMarked) {
        try {
            // 使用 Repository 更新
            await this.repository.updateSnapshotMark(snapshotId, isMarked);
            return { success: true };
        } catch (error) {
            logger.error(`failed to update snapshot mark: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    async requestScreenshot() {
        // 检查活动是否仍在进行中（避免停止后的竞态条件）
        if (!this.currentActivity) {
            logger.warn('[requestScreenshot] Activity已停止，跳过本次截图');
            return { success: false, message: 'Activity stopped' };
        }

        // 创建本次捕获记录
        const captureId = crypto.randomUUID();
        const captureIndex = this.currentActivity.captureCount;

        // 生成人类可读的文件夹名
        const captureFolderName = generateCaptureFolderName(captureIndex);

        const capture = new RecallCapture(captureId, this.currentActivity.activityId, captureIndex, {
            captureFolderName: captureFolderName,
            triggerType: 'scheduled',
            captureStrategy: this.currentActivity._captureStrategy,
            captureTargets: this.currentActivity._captureTargets
        });

        // 构建文件保存目录（使用时间戳格式）
        const captureDir = path.join(this.currentActivity.activityPath, 'captures', captureFolderName);
        if (!fs.existsSync(captureDir)) {
            fs.mkdirSync(captureDir, { recursive: true });
        }

        // 根据 captureTargets 获取要截图的源
        let sources = [];
        for (const target of this.currentActivity._captureTargets) {
            if (!target.enabled) continue;

            if (target.type === 'monitor') {
                const monitors = Monitor.all();
                const monitorIndex = parseInt(target.id.split('-')[1]);
                if (monitors[monitorIndex]) {
                    sources.push({
                        source: monitors[monitorIndex],
                        target: target,
                        index: sources.length
                    });
                }
            } else if (target.type === 'window') {
                const window = Window.all().find((w) => w.id.toString() === target.id);
                if (window) {
                    sources.push({
                        source: window,
                        target: target,
                        index: sources.length
                    });
                } else {
                    logger.warn(`window ${target.id} not found, skipping`);
                }
            }
        }

        // 如果没有有效的源，使用所有显示器作为备选
        if (sources.length === 0) {
            logger.warn('no valid capture sources, falling back to all monitors');
            const monitors = Monitor.all();
            sources = monitors.map((monitor, index) => ({
                source: monitor,
                target: {
                    type: 'monitor',
                    id: `monitor-${index}`,
                    name: `Display ${index + 1}`,
                    enabled: true
                },
                index: index
            }));
        }

        const latestThumbnails = [];
        let snapshotCount = 0;
        let totalSize = 0;

        // 对每个源进行截图
        for (const { source, target, index } of sources) {
            try {
                const image = await source.captureImage();
                const pngImage = await image.toPng();

                // 生成文件名
                const fileName = `snapshot-${index}.webp`;
                const thumbnailFileName = `snapshot-${index}.thumbnail.webp`;
                const filePath = path.join(captureDir, fileName);
                const thumbnailPath = path.join(captureDir, thumbnailFileName);

                // 保存原图
                const finalBuffer = await sharp(pngImage).webp({ quality: 70, method: 6 }).toBuffer();
                fs.writeFileSync(filePath, finalBuffer);

                // 保存缩略图
                const thumbnailBuffer = await sharp(pngImage)
                    .resize({
                        width: Math.floor(image.width / 5),
                        height: Math.floor(image.height / 5)
                    })
                    .webp({ quality: 40, method: 6 })
                    .toBuffer();
                fs.writeFileSync(thumbnailPath, thumbnailBuffer);

                latestThumbnails.push(thumbnailBuffer);

                // 统一判重逻辑：只与上一帧比较
                let shouldSave = true;
                let currentHash = null;

                // 计算当前图像的dHash
                currentHash = await ImageAnalyzeManager.calculateImageHash(finalBuffer);

                // 只与上一帧比较（如果存在上一帧）
                if (this.lastSnapshot) {
                    // 使用 SnapshotProcessor 的业务方法判断是否与上一帧重复
                    const isDuplicate = await this._getSnapshotProcessor().isDuplicateOfPrevious(
                        { hash: currentHash, imagePath: filePath },
                        this.lastSnapshot
                    );
                    shouldSave = !isDuplicate; // 不重复才保存
                }

                if (!shouldSave) {
                    // 重复帧，删除文件并跳过
                    fs.unlinkSync(filePath);
                    fs.unlinkSync(thumbnailPath);
                    continue;
                }

                // 更新上一帧引用（录制会话状态）
                this.lastSnapshot = {
                    hash: currentHash,
                    imagePath: filePath,
                    timestamp: Date.now()
                };

                // 创建快照记录
                const snapshotId = crypto.randomUUID();

                // 根据 target 类型设置 sourceName
                let sourceName = target.name;

                // 如果是窗口模式，使用窗口标题作为 sourceName
                if (target.type === 'window') {
                    const window = Window.all().find((w) => w.id.toString() === target.id);
                    if (window && window.title) {
                        sourceName = window.title;
                    }
                }

                const snapshot = new RecallSnapshot(snapshotId, captureId, this.currentActivity.activityId, {
                    sourceType: target.type,
                    sourceId: target.id,
                    sourceName: sourceName,
                    sourceIndex: index,
                    imagePath: path.relative(this.currentActivity.activityPath, filePath),
                    thumbnailPath: path.relative(this.currentActivity.activityPath, thumbnailPath),
                    imageFormat: 'webp',
                    imageWidth: image.width,
                    imageHeight: image.height,
                    imageSize: finalBuffer.length,
                    isKeyframe: false, // 录制时不标记为关键帧
                    dHash: currentHash, // 保存hash值
                    metadata: {}
                });

                // 保存所有snapshot
                await this.repository.saveSnapshot(snapshot);
                snapshotCount++;
                totalSize += finalBuffer.length;
            } catch (error) {
                logger.error(
                    `failed to take screenshot for source ${index} (${target.type}: ${target.name}): ${error.message}`
                );
            }
        }

        // 更新捕获记录
        capture.snapshotCount = snapshotCount;
        await this.repository.saveCapture(capture);

        // 更新活动统计信息
        this.currentActivity.captureCount++;
        this.currentActivity.snapshotCount += snapshotCount;
        this.currentActivity.totalSize += totalSize;
        this.currentActivity._latestThumbnails = latestThumbnails;

        // 如果本次capture没有有效帧，则删除capture目录
        if (fs.readdirSync(captureDir).length === 0) {
            fs.rmdirSync(captureDir);
        }

        // 更新活动的第一张截图作为封面
        if (!this.currentActivity.thumbnailPath && latestThumbnails.length > 0) {
            const coverPath = path.join(this.currentActivity.activityPath, 'cover.webp');
            fs.writeFileSync(coverPath, latestThumbnails[0]);
            this.currentActivity.thumbnailPath = path.relative(this.appDataDirectory, coverPath);
        }

        await this.saveActivity(this.currentActivity);

        return { success: true, captureId: captureId, snapshotCount: snapshotCount };
    }

    // ==================== 标签管理 API ====================

    /**
     * 创建或获取标签（业务逻辑：查找现有标签或创建新标签）
     * @param {string} tagName 标签名称
     * @param {Object} options 标签配置
     * @returns {Promise<Object>}
     */
    async createOrGetTag(tagName, options = {}) {
        try {
            // 1. 先尝试查找现有标签
            const tag = await this.repository.findTagByName(tagName);

            if (tag) {
                // 标签已存在，直接返回
                return { success: true, tag: RecallMapper.tagToDb(tag) };
            }

            // 2. 标签不存在，创建新标签
            // 如果没有指定颜色，使用哈希算法生成一致的颜色
            let tagColor = options.tagColor;
            if (!tagColor) {
                const colorPalette = [
                    '#3B82F6', // blue
                    '#8B5CF6', // purple
                    '#10B981', // green
                    '#F59E0B', // amber
                    '#EC4899', // pink
                    '#6366F1', // indigo
                    '#EF4444', // red
                    '#14B8A6', // teal
                    '#F97316', // orange
                    '#06B6D4' // cyan
                ];

                let hash = 0;
                for (let i = 0; i < tagName.length; i++) {
                    hash = (hash << 5) - hash + tagName.charCodeAt(i);
                    hash = hash & hash;
                }
                const colorIndex = Math.abs(hash) % colorPalette.length;
                tagColor = colorPalette[colorIndex];
            }

            // 创建标签实体
            const tagId = `tag_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const newTag = new RecallTag(tagId, tagName, {
                ...options,
                tagColor
            });

            // 3. 保存到数据库
            await this.repository.insertTag(newTag);

            // 转换为数据库格式并包装返回值
            return { success: true, tag: RecallMapper.tagToDb(newTag) };
        } catch (error) {
            logger.error(`failed to create or get tag: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取所有标签
     * @returns {Promise<Object>}
     */
    async getAllTags() {
        try {
            // 使用 Repository 查询所有标签
            const tagEntities = await this.repository.findAllTags({
                sort: { usageCount: -1 }
            });

            // 转换为数据库格式
            const tags = tagEntities.map((t) => RecallMapper.tagToDb(t));
            return { success: true, tags };
        } catch (error) {
            logger.error(`failed to get all tags: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 为实体添加标签（业务逻辑：创建/获取Tag → 检查关联 → 创建Tagging → 更新计数）
     * @param {string} entityType 实体类型 (activity | capture | snapshot)
     * @param {string} entityId 实体ID
     * @param {string} tagName 标签名称
     * @param {Object} options 额外配置
     * @returns {Promise<Object>}
     */
    async addTagToEntity(entityType, entityId, tagName, options = {}) {
        try {
            // 1. 创建或获取标签（复用业务方法）
            const tagResult = await this.createOrGetTag(tagName, options);
            if (!tagResult.success) {
                return tagResult;
            }
            const tagData = tagResult.tag;

            // 2. 检查是否已存在关联
            const existingTagging = await this.repository.findTagging(entityType, entityId, tagName);

            if (existingTagging) {
                logger.debug(`Tagging already exists: ${tagName} → ${entityType}:${entityId}`);
                return {
                    success: true,
                    tagging: RecallMapper.taggingToDb(existingTagging),
                    alreadyExists: true
                };
            }

            // 3. 创建新关联
            const taggingId = `tagging_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            const tagging = new RecallTagging(taggingId, tagData.tagId, tagData.tagName, entityType, entityId, options);

            // 4. 保存关联
            await this.repository.insertTagging(tagging);

            // 5. 更新标签使用计数
            await this.repository.incrementTagUsageCount(tagData.tagId, 1);

            // 转换为数据库格式并包装返回值
            return { success: true, tagging: RecallMapper.taggingToDb(tagging) };
        } catch (error) {
            logger.error(`failed to add tag: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 从实体移除标签（业务逻辑：删除Tagging → 更新Tag使用计数）
     * @param {string} entityType 实体类型
     * @param {string} entityId 实体ID
     * @param {string} tagName 标签名称
     * @returns {Promise<Object>}
     */
    async removeTagFromEntity(entityType, entityId, tagName) {
        try {
            // 1. 删除标签关联
            const removed = await this.repository.removeTaggings({
                entityType,
                entityId,
                tagName
            });

            if (removed === 0) {
                return { success: false, message: 'tag not found' };
            }

            // 2. 更新标签使用次数
            const tag = await this.repository.findTagByName(tagName);
            if (tag && tag.usageCount > 0) {
                await this.repository.incrementTagUsageCount(tag.tagId, -1);
            }

            return { success: true, removed };
        } catch (error) {
            logger.error(`failed to remove tag: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取实体的所有标签
     * @param {string} entityType 实体类型
     * @param {string} entityId 实体ID
     * @returns {Promise<Object>}
     */
    async getEntityTags(entityType, entityId) {
        try {
            // 使用 Repository 查询
            const taggingEntities = await this.repository.findTaggings(
                { entityType, entityId },
                { sort: { createdAt: 1 } }
            );

            // 转换为数据库格式
            const taggings = taggingEntities.map((t) => RecallMapper.taggingToDb(t));
            return { success: true, tags: taggings };
        } catch (error) {
            logger.error(`failed to get entity tags: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取带有特定标签的所有实体
     * @param {string} tagName 标签名称
     * @param {string} entityType 实体类型（可选）
     * @returns {Promise<Object>}
     */
    async getEntitiesByTag(tagName, entityType = null) {
        try {
            const query = { tagName };
            if (entityType) {
                query.entityType = entityType;
            }

            // 使用 Repository 查询
            const taggingEntities = await this.repository.findTaggings(query, {
                sort: { createdAt: -1 }
            });

            // 转换为数据库格式
            const taggings = taggingEntities.map((t) => RecallMapper.taggingToDb(t));
            return { success: true, entities: taggings };
        } catch (error) {
            logger.error(`failed to get entities by tag: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 批量为实体添加标签
     * @param {string} entityType 实体类型
     * @param {string} entityId 实体ID
     * @param {string[]} tagNames 标签名称数组
     * @param {Object} options 额外配置
     * @returns {Promise<Object>}
     */
    async addTagsToEntity(entityType, entityId, tagNames, options = {}) {
        try {
            const results = [];
            for (const tagName of tagNames) {
                const result = await this.addTagToEntity(entityType, entityId, tagName, options);
                results.push(result);
            }

            const successCount = results.filter((r) => r.success).length;
            return {
                success: true,
                added: successCount,
                total: tagNames.length,
                results: results
            };
        } catch (error) {
            logger.error(`failed to add tags: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 清除实体的所有标签（业务逻辑：查询Tagging → 删除 → 更新Tag使用计数）
     * @param {string} entityType 实体类型
     * @param {string} entityId 实体ID
     * @returns {Promise<Object>}
     */
    async clearEntityTags(entityType, entityId) {
        try {
            // 1. 查询所有标签关联（需要获取 tagId 来更新计数）
            const taggings = await this.repository.findTaggings({
                entityType,
                entityId
            });

            if (taggings.length === 0) {
                return { success: true, removed: 0 };
            }

            // 2. 删除所有关联
            const removed = await this.repository.removeTaggings({
                entityType,
                entityId
            });

            // 3. 更新所有相关标签的使用次数
            for (const tagging of taggings) {
                await this.repository.incrementTagUsageCount(tagging.tagId, -1);
            }

            return { success: true, removed };
        } catch (error) {
            logger.error(`failed to clear entity tags: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 获取 Activity 的聚合标签
     * 包含：Activity 自身的标签 + 其下所有 Capture 和 Snapshot 的标签
     * @param {string} activityId Activity ID
     * @returns {Promise<Object>}
     */
    async getActivityAggregatedTags(activityId) {
        try {
            // 查询所有与该 Activity 相关的标签
            // 包括：entityType='activity' 且 entityId=activityId 的记录
            // 以及：任何 entityType='capture' 或 'snapshot' 且其 activityId 匹配的记录

            // 1. 直接获取 Activity 级别的标签
            const activityTaggingEntities = await this.repository.findTaggings({
                entityType: 'activity',
                entityId: activityId
            });

            // 2. 获取该 Activity 下所有 Capture 的 ID
            const captureEntities = await this.repository.findCapturesByActivity(activityId);
            const captureIds = captureEntities.map((c) => c.captureId);

            // 3. 获取该 Activity 下所有 Snapshot 的 ID
            const snapshotEntities = await this.repository.findSnapshotsByActivity(activityId);
            const snapshotIds = snapshotEntities.map((s) => s.snapshotId);

            // 4. 查询所有相关的 Capture 和 Snapshot 标签
            const captureSnapshotTaggingEntities = await this.repository.findTaggingsByEntityQueries([
                ...captureIds.map((id) => ({ entityType: 'capture', entityId: id })),
                ...snapshotIds.map((id) => ({ entityType: 'snapshot', entityId: id }))
            ]);

            // 合并所有标签，去重
            const allTaggingEntities = [...activityTaggingEntities, ...captureSnapshotTaggingEntities];
            const allTaggings = allTaggingEntities.map((t) => RecallMapper.taggingToDb(t));
            const uniqueTagIds = [...new Set(allTaggingEntities.map((t) => t.tagId))];

            // 5. 从 Tag 表获取完整的标签定义（包括颜色、图标等）
            const tagEntities = await this.repository.findTagsByIds(uniqueTagIds);
            const tags = tagEntities.map((t) => RecallMapper.tagToDb(t));

            // 创建标签名称数组（向后兼容）
            const tagNames = tags.map((t) => t.tagName);

            return {
                success: true,
                tags: tagNames, // 标签名称数组（向后兼容）
                tagObjects: tags, // 完整的标签对象（包含颜色、图标等）
                taggings: allTaggings // 关联记录
            };
        } catch (error) {
            logger.error(`failed to get activity aggregated tags: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 批量获取多个 Activity 的聚合标签
     * @param {string[]} activityIds Activity ID 数组
     * @returns {Promise<Object>}
     */
    async getActivitiesAggregatedTags(activityIds) {
        const startTime = Date.now();

        try {
            if (!activityIds || activityIds.length === 0) {
                return { success: true, tagsMap: {}, tagObjectsMap: {} };
            }

            // 限制批量查询的大小，避免阻塞worker
            if (activityIds.length > 100) {
                logger.warn(`[Worker] ⚠️ Large batch tag query: ${activityIds.length} activities, this may be slow`);
            }

            const tagsMap = {};
            const tagObjectsMap = {};

            // 1. 获取所有 Activity 级别的标签（一次查询）
            const t1 = Date.now();
            const activityTaggingEntities = await this.repository.findTaggingsByActivityIds(activityIds);
            const activityTaggings = activityTaggingEntities.map((t) => RecallMapper.taggingToDb(t));

            // 2. 获取所有相关的 Capture
            const t2 = Date.now();
            const captureEntities = await this.repository.findCapturesByActivityIds(activityIds);
            const captures = captureEntities.map((c) => RecallMapper.captureToDb(c));
            const captureIds = captures.map((c) => c.captureId);
            const captureToActivity = new Map(captures.map((c) => [c.captureId, c.activityId]));

            // 3. 获取所有相关的 Snapshot
            const t3 = Date.now();
            const snapshotEntities = await this.repository.findSnapshotsByQuery({
                activityId: { $in: activityIds }
            });
            const snapshots = snapshotEntities.map((s) => RecallMapper.snapshotToDb(s));
            const snapshotIds = snapshots.map((s) => s.snapshotId);
            const snapshotToActivity = new Map(snapshots.map((s) => [s.snapshotId, s.activityId]));

            // 4. 获取所有 Capture 和 Snapshot 的标签（一次查询）
            const t4 = Date.now();
            let captureSnapshotTaggings = [];
            if (captureIds.length > 0 || snapshotIds.length > 0) {
                const captureSnapshotTaggingEntities = await this.repository.findTaggingsByEntityQueries([
                    ...captureIds.map((id) => ({ entityType: 'capture', entityId: id })),
                    ...snapshotIds.map((id) => ({ entityType: 'snapshot', entityId: id }))
                ]);
                captureSnapshotTaggings = captureSnapshotTaggingEntities.map((t) => RecallMapper.taggingToDb(t));
            }

            // 5. 收集所有唯一的 tagId
            const t5 = Date.now();
            const allTaggings = [...activityTaggings, ...captureSnapshotTaggings];
            const uniqueTagIds = [...new Set(allTaggings.map((t) => t.tagId))];

            // 6. 从 Tag 表获取完整的标签定义（一次查询）
            const t6 = Date.now();
            let tagObjects = [];
            if (uniqueTagIds.length > 0) {
                const tagEntities = await this.repository.findTagsByIds(uniqueTagIds);
                tagObjects = tagEntities.map((t) => RecallMapper.tagToDb(t));
            }
            const tagIdToObject = new Map(tagObjects.map((t) => [t.tagId, t]));

            // 7. 按 activityId 分组标签
            activityIds.forEach((activityId) => {
                tagsMap[activityId] = new Set();
                tagObjectsMap[activityId] = [];
            });

            // 添加 Activity 级别的标签
            activityTaggings.forEach((tagging) => {
                if (tagsMap[tagging.entityId]) {
                    tagsMap[tagging.entityId].add(tagging.tagName);
                    const tagObj = tagIdToObject.get(tagging.tagId);
                    if (tagObj && !tagObjectsMap[tagging.entityId].some((t) => t.tagId === tagObj.tagId)) {
                        tagObjectsMap[tagging.entityId].push(tagObj);
                    }
                }
            });

            // 添加 Capture 和 Snapshot 的标签
            captureSnapshotTaggings.forEach((tagging) => {
                let activityId;
                if (tagging.entityType === 'capture') {
                    activityId = captureToActivity.get(tagging.entityId);
                } else if (tagging.entityType === 'snapshot') {
                    activityId = snapshotToActivity.get(tagging.entityId);
                }

                if (activityId && tagsMap[activityId]) {
                    tagsMap[activityId].add(tagging.tagName);
                    const tagObj = tagIdToObject.get(tagging.tagId);
                    if (tagObj && !tagObjectsMap[activityId].some((t) => t.tagId === tagObj.tagId)) {
                        tagObjectsMap[activityId].push(tagObj);
                    }
                }
            });

            // 转换 Set 为数组
            const resultTagsMap = {};
            const resultTagObjectsMap = {};
            Object.keys(tagsMap).forEach((activityId) => {
                resultTagsMap[activityId] = Array.from(tagsMap[activityId]);
                resultTagObjectsMap[activityId] = tagObjectsMap[activityId];
            });

            const totalTime = Date.now() - startTime;
            if (totalTime > 1000) {
                logger.warn(
                    `[Worker] ⚠️ Slow getActivitiesAggregatedTags: ${totalTime}ms for ${activityIds.length} activities`
                );
            }

            return {
                success: true,
                tagsMap: resultTagsMap, // { activityId: [tagName, ...] }
                tagObjectsMap: resultTagObjectsMap // { activityId: [tagObject, ...] }
            };
        } catch (error) {
            const totalTime = Date.now() - startTime;
            logger.error(`[Worker] ❌ getActivitiesAggregatedTags failed after ${totalTime}ms: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    // ====================PDF API处理方法 ====================

    /**
     * 获取活动PDF文件路径
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 包含PDF路径的结果对象
     */
    async getActivityPDFPath(activityId) {
        try {
            const activityEntity = await this.repository.findActivityById(activityId);
            if (!activityEntity) {
                return { success: false, message: 'Activity not found' };
            }

            // 检查PDF处理状态
            if (!activityEntity.pdfStatus || activityEntity.pdfStatus !== 'completed') {
                return { success: false, message: 'PDF not yet generated' };
            }

            const pdfPath = activityEntity.pdfPath;
            if (!pdfPath) {
                return { success: false, message: 'PDF path not found' };
            }

            // pdfPath 是相对于 activityPath 的路径
            const fullPdfPath = path.join(activityEntity.activityPath, pdfPath);
            if (!fs.existsSync(fullPdfPath)) {
                return { success: false, message: 'PDF file does not exist' };
            }

            return { success: true, pdfPath: fullPdfPath };
        } catch (error) {
            logger.error(`Failed to get activity PDF path: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 打开活动PDF文件
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 操作结果
     */
    async openActivityPDF(activityId) {
        try {
            const result = await this.getActivityPDFPath(activityId);
            if (!result.success) {
                return result;
            }

            const { shell } = require('electron');
            await shell.openPath(result.pdfPath);

            return { success: true };
        } catch (error) {
            logger.error(`Failed to open activity PDF: ${error.message}`);
            return { success: false, message: error.message };
        }
    }

    /**
     * 重新生成活动PDF
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 操作结果
     */
    async regenerateActivityPDF(activityId) {
        return await this._getSnapshotProcessor().regenerateActivityPDF(activityId);
    }

    /**
     * 获取活动的关键帧
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 包含关键帧的结果对象
     */
    async getActivityKeyframes(activityId) {
        return await this._getSnapshotProcessor().getActivityKeyframes(activityId);
    }

    /**
     * 获取活动的OCR提取内容（OCR功能已禁用）
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 包含提取内容的结果对象
     */
    async getActivityExtractions(activityId) {
        // OCR功能已禁用，返回空数组
        return { success: true, extractions: [] };
    }

    /**
     * 生成活动PDF
     * @param {string} activityId 活动ID
     * @returns {Promise<Object>} 包含PDF路径的结果对象
     */
    async generateActivityPDF(activityId) {
        // 检查PDF生成状态
        const activityEntity = await this.repository.findActivityById(activityId);
        const currentStatus = activityEntity?.pdfStatus;

        if (currentStatus === 'processing') {
            return {
                success: false,
                message: 'PDF generation already in progress'
            };
        }

        // 如果已经完成，不允许重复生成
        if (currentStatus === 'completed') {
            return {
                success: false,
                message: 'PDF already generated'
            };
        }

        // 允许的状态：null（新录制）、failed（失败重试）、no_keyframes（重试）

        // 更新状态为processing
        await this.repository.updateActivityFields(activityId, {
            pdfStatus: 'processing',
            'metadata.pdf.startedAt': Date.now()
        });

        // 发送状态更新事件
        if (parentPort) {
            parentPort.postMessage({
                type: 'pdfStatusUpdate',
                payload: {
                    activityId: activityId,
                    status: 'processing',
                    timestamp: Date.now()
                }
            });
        }

        // 异步执行完整判重+PDF生成
        this._processSnapshotsAndGeneratePDF(activityId).catch((error) => {
            logger.error(`Failed to generate PDF: ${error.message}`);
        });

        return { success: true, message: 'PDF generation started' };
    }

    // 注意：previewActivityPDF, showFileInFolder 已移至 service.js
    // 这些方法需要使用 electron 的 shell API，必须在主进程中执行，不能在 worker 线程中执行

    // ==================== 服务生命周期 ====================

    async startService() {}

    async stopService() {}
}

export default RecallWorker;
