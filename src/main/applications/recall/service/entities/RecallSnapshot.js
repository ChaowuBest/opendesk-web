/**
 * RecallSnapshot - 快照实体类
 * 表示单个显示器或窗口的截图
 */
export class RecallSnapshot {
    /**
     * 创建快照对象
     * @param {string} snapshotId 快照ID
     * @param {string} captureId 所属捕获ID
     * @param {string} activityId 所属活动ID
     * @param {Object} options 配置
     */
    constructor(snapshotId, captureId, activityId, options = {}) {
        /** @type {string} 快照唯一标识 */
        this.snapshotId = snapshotId;

        /** @type {string} 所属捕获ID */
        this.captureId = captureId;

        /** @type {string} 所属活动ID */
        this.activityId = activityId;

        /** @type {string} 来源类型: 'monitor' | 'window' */
        this.sourceType = options.sourceType;

        /** @type {string} 来源ID（显示器ID或窗口ID） */
        this.sourceId = options.sourceId;

        /** @type {string} 来源名称 */
        this.sourceName = options.sourceName;

        /** @type {number} 来源索引 */
        this.sourceIndex = options.sourceIndex;

        /** @type {string} 图片文件路径 */
        this.imagePath = options.imagePath;

        /** @type {string} 缩略图路径 */
        this.thumbnailPath = options.thumbnailPath;

        /** @type {string} 图片格式: 'webp' | 'png' | 'jpg' */
        this.imageFormat = options.imageFormat || 'webp';

        /** @type {number} 图片宽度（像素） */
        this.imageWidth = options.imageWidth;

        /** @type {number} 图片高度（像素） */
        this.imageHeight = options.imageHeight;

        /** @type {number} 图片文件大小（字节） */
        this.imageSize = options.imageSize;

        /** @type {boolean} 是否被标记 */
        this.isMarked = options.isMarked || false;

        /** @type {boolean} 是否有注释 */
        this.hasAnnotation = false;

        /** @type {boolean} 是否已提取内容 */
        this.hasExtraction = false;

        /** @type {string|null} 提取状态: 'pending' | 'processing' | 'completed' | 'failed' */
        this.extractionStatus = null;

        /** @type {boolean} 是否为关键帧 */
        this.isKeyframe = options.isKeyframe || false;

        /** @type {string|null} 图像差分哈希值（用于判重） */
        this.dHash = options.dHash || null;

        /** @type {Object} 元数据（用于其他扩展信息） */
        this.metadata = options.metadata || {};

        /** @type {number} 创建时间 */
        this.createdAt = options.createdAt || Date.now();
    }
}
