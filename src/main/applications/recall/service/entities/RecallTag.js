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
 * RecallTag - 标签定义实体类
 * 表示一个标签的定义，包含标签的基本信息和使用统计
 */
export class RecallTag {
    /**
     * 创建标签定义对象
     * @param {string} tagId 标签ID
     * @param {string} tagName 标签名称
     * @param {Object} options 可选配置
     */
    constructor(tagId, tagName, options = {}) {
        /** @type {string} 标签唯一标识 */
        this.tagId = tagId;

        /** @type {string} 标签名称（唯一） */
        this.tagName = tagName;

        /** @type {string|null} 标签颜色（十六进制，如 '#FF5733'） */
        this.tagColor = options.tagColor || null;

        /** @type {string|null} 标签图标（如 'star', 'important'） */
        this.tagIcon = options.tagIcon || null;

        /** @type {number} 使用次数统计 */
        this.usageCount = options.usageCount || 0;

        /** @type {boolean} 是否为系统预定义标签 */
        this.isSystem = options.isSystem || false;

        /** @type {number} 创建时间 */
        this.createdAt = options.createdAt || Date.now();

        /** @type {number} 最后更新时间 */
        this.updatedAt = options.updatedAt || Date.now();
    }

    /**
     * 增加使用计数
     */
    incrementUsage() {
        this.usageCount++;
        this.updatedAt = Date.now();
    }

    /**
     * 减少使用计数
     */
    decrementUsage() {
        if (this.usageCount > 0) {
            this.usageCount--;
            this.updatedAt = Date.now();
        }
    }
}
