/**
 * RecallTagging - 标签关联实体类
 * 表示标签与实体（Activity、Capture、Snapshot）的关联关系
 */
export class RecallTagging {
    /**
     * 创建标签关联对象
     * @param {string} taggingId 关联ID
     * @param {string} tagId 标签ID
     * @param {string} tagName 标签名称（冗余字段，便于查询）
     * @param {string} entityType 实体类型: 'activity' | 'capture' | 'snapshot'
     * @param {string} entityId 实体ID
     * @param {Object} options 可选配置
     */
    constructor(taggingId, tagId, tagName, entityType, entityId, options = {}) {
        /** @type {string} 关联唯一标识 */
        this.taggingId = taggingId;

        /** @type {string} 标签ID */
        this.tagId = tagId;

        /** @type {string} 标签名称（冗余字段，便于查询） */
        this.tagName = tagName;

        /** @type {string} 实体类型: 'activity' | 'capture' | 'snapshot' */
        this.entityType = entityType;

        /** @type {string} 实体ID */
        this.entityId = entityId;

        /** @type {number} 置信度（0.0-1.0，用于自动标注） */
        this.confidence = options.confidence || 1.0;

        /** @type {string} 来源: 'manual' | 'auto' */
        this.source = options.source || 'manual';

        /** @type {number} 创建时间 */
        this.createdAt = options.createdAt || Date.now();

        /** @type {string} 创建者（用户ID或 'system'） */
        this.createdBy = options.createdBy || 'system';
    }
}
