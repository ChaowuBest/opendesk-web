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
 * RecallCapture - 捕获实体类
 * 表示一次截图操作，可能包含多个快照（多显示器场景）
 */
export class RecallCapture {
    /**
     * 创建捕获对象
     * @param {string} captureId 捕获ID
     * @param {string} activityId 所属活动ID
     * @param {number} captureIndex 捕获序号
     * @param {Object} options 可选配置
     */
    constructor(captureId, activityId, captureIndex, options = {}) {
        /** @type {string} 捕获唯一标识 */
        this.captureId = captureId;

        /** @type {string} 所属活动ID */
        this.activityId = activityId;

        /** @type {number} 捕获时间戳（毫秒） */
        this.captureTime = Date.now();

        /** @type {number} 捕获序号（从1开始） */
        this.captureIndex = captureIndex;

        /** @type {string|null} 人类可读的文件夹名（如 20260119_143052_001） */
        this.captureFolderName = options.captureFolderName || null;

        /** @type {string} 触发类型: 'scheduled' | 'manual' | 'event' */
        this.triggerType = options.triggerType || 'scheduled';

        /** @type {string|null} 事件类型（当 triggerType 为 'event' 时） */
        this.eventType = options.eventType || null;

        /** @type {string} 捕获策略: 'monitor' | 'window' */
        this.captureStrategy = options.captureStrategy || 'monitor';

        /** @type {Array} 捕获目标列表 */
        this.captureTargets = options.captureTargets || [];

        /** @type {number} 该捕获包含的快照数量 */
        this.snapshotCount = 0;

        /** @type {boolean} 是否被标记 */
        this.isMarked = options.isMarked || false;

        /** @type {number} 创建时间 */
        this.createdAt = Date.now();
    }
}
