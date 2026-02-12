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
 * RecallExtraction - 提取内容实体类
 * 表示从快照中提取的内容（OCR、LLM分析、URL等）
 * 简化设计：只保留核心字段
 */
export class RecallExtraction {
    /**
     * 创建提取内容对象
     * @param {string} extractionId 提取ID
     * @param {string} snapshotId 关联的快照ID
     * @param {string} activityId 所属活动ID
     * @param {Object} options 配置
     */
    constructor(extractionId, snapshotId, activityId, options = {}) {
        /** @type {string} 提取唯一标识 */
        this.extractionId = extractionId;

        /** @type {string} 关联的快照ID */
        this.snapshotId = snapshotId;

        /** @type {string} 所属活动ID */
        this.activityId = activityId;

        /** @type {string} 内容类型: 'ocr' | 'llm'  */
        this.contentType = options.contentType || 'ocr';

        /** @type {string} 提取的内容文本 */
        this.content = options.content || '';

        /** @type {number} 置信度（0-100） */
        this.confidence = options.confidence || 0;

        /** @type {string} 页面类型: 'title' | 'content' | 'summary' */
        this.pageType = options.pageType || 'content';

        /** @type {number} 创建时间 */
        this.createdAt = Date.now();
    }
}
