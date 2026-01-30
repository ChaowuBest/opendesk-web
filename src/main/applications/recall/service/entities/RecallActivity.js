/**
 * RecallActivity - 活动实体类
 * 表示一次完整的录制会话，包含持久化字段和运行时字段
 *
 * 持久化字段（20个）：存储到数据库
 * 运行时字段（8个，_前缀）：仅在内存中使用，不持久化
 */
export class RecallActivity {
    /**
     * 创建活动对象
     * @param {string} activityId 活动ID
     * @param {string} activityName 活动名称
     * @param {string} activityPath 活动文件夹路径
     * @param {Object} options 可选配置
     */
    constructor(activityId, activityName, activityPath, options = {}) {
        // ========== 持久化字段（20个）==========

        // 基础信息
        /** @type {string} 活动唯一标识 */
        this.activityId = activityId;
        /** @type {string} 活动名称 */
        this.activityName = activityName;
        /** @type {string} 活动文件夹路径 */
        this.activityPath = activityPath;

        // 时间信息
        /** @type {number} 开始时间戳（毫秒） */
        this.startTime = Date.now();
        /** @type {number|null} 结束时间戳（毫秒） */
        this.endTime = null;
        /** @type {number} 持续时长（毫秒） */
        this.duration = 0;

        // 状态
        /** @type {string} 活动状态: 'recording' | 'stopped' | 'archived' */
        this.status = 'recording';

        // 录制配置
        /** @type {string} 捕获模式: 'screenshot' | 'video' */
        this.captureMode = options.captureMode || 'screenshot';
        /** @type {string} 活动类型: 'normal' */
        this.type = options.type || 'normal';

        // 元数据
        /** @type {string|null} 封面图路径 */
        this.thumbnailPath = null;
        /** @type {Object} 元数据对象（用于非强约束的补充信息，如 PDF 生成的时间戳、错误信息等）
         * - completedAt: PDF生成完成时间
         * - failedAt: PDF生成失败时间
         * - startAt: PDF生成开始时间
         * - error: PDF生成错误信息
         * - processedAt: 处理完成时间
         * - totalSnapshots: 总快照数
         */
        this.metadata = options.metadata || {};

        // PDF 相关（核心状态字段）
        /** @type {string|null} PDF文件路径（相对于活动文件夹） */
        this.pdfPath = options.pdfPath || null;
        /** @type {string|null} PDF生成状态: 'processing' | 'completed' | 'failed' | 'no_keyframes' */
        this.pdfStatus = options.pdfStatus || null;

        // 统计信息
        /** @type {number} 捕获次数 */
        this.captureCount = 0;
        /** @type {number} 快照总数 */
        this.snapshotCount = 0;
        /** @type {number} 关键帧数 */
        this.keyframeCount = 0;
        /** @type {number} 总文件大小（字节） */
        this.totalSize = 0;

        // 时间戳
        /** @type {number} 创建时间 */
        this.createdAt = Date.now();
        /** @type {number} 最后更新时间 */
        this.updatedAt = Date.now();

        // ========== 运行时字段（8个，_前缀，不持久化）==========

        /** @type {NodeJS.Timeout | null} 定时器句柄 */
        this._interval = null;

        /** @type {Buffer[]} 最新缩略图缓存（用于实时预览） */
        this._latestThumbnails = [];

        /** @type {string|null} 运行时捕获策略: 'monitor' | 'window' */
        this._captureStrategy = null;

        /** @type {Array<{displayIndex: number, captureMode: string, targetId: string}>|null} 显示器配置 */
        this._displayConfigs = null;

        /** @type {number|null} 捕获间隔（毫秒） */
        this._captureInterval = null;

        /** @type {Array<{type: string, id: string, name: string, displayIndex: number, enabled: boolean}>|null} 捕获目标列表 */
        this._captureTargets = null;

        /** @type {string[]|null} 待处理的活动标签 */
        this._pendingActivityTags = null;
    }

    /**
     * 更新活动时间戳
     */
    touch() {
        this.updatedAt = Date.now();
    }
}
