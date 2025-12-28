const { BaseWorker } = require("../../base");
const { logger } = require('../../../utils/logger');
const { Monitor, Image } = require('node-screenshots');

const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const nedb = require('nedb-promises');


class RecallActivity {
    /**
     * 创建活动对象
     * @param {string} activityId
     * @param {string} activityName
     * @param {string} activityPath
     */
    constructor(activityId, activityName, activityPath) {
        /** @type {string} */
        this.activityId = activityId;
        /** @type {string} */
        this.activityName = activityName;
        /** @type {string} */
        this.activityPath = activityPath;

        /** @type {number} */
        this.activityStartTime = Date.now();
        /** @type {number} */
        this.activityDuration = 0;

        /** @type {NodeJS.Timeout | null} */
        this.activityInterval = null;
        /** @type {number} */
        this.activityIntervalMs = 5000;

        /** @type {Map<number, Buffer>} */
        this.latestThumbnail = new Map();
    }

    toJSON() {
        return {
            activityId: this.activityId,
            activityName: this.activityName,
            activityPath: this.activityPath,
            activityIntervalMs: this.activityIntervalMs,
            activityStartTime: this.activityStartTime,
            activityDuration: this.activityDuration
        };
    }
}


class RecallWorker extends BaseWorker {

    constructor() {
        super();

        /** @type {RecallActivity | null} */
        this.currentActivity = null;
        this.db = new nedb({ filename: path.join(this.appDataDirectory, 'recall.db'), autoload: true });
        this.db.ensureIndex({ fieldName: 'activityId', unique: true });
        this.db.ensureIndex({ fieldName: 'activityStartTime', unique: false });
    }

    async getRecallStatus() {
        if (this.currentActivity === null) {
            return { status: 'idle' };
        } else {
            return { status: 'recording', activity: this.currentActivity.toJSON() };
        }
    }

    /**
     * 获取历史活动
     * @param {number} startTimestamp 开始时间戳
     * @param {number} endTimestamp 结束时间戳
     * @returns {Promise<RecallActivity[]>} 历史活动列表
     */
    async getHistoryActivities(startTimestamp, endTimestamp) {
        logger.info(`getting history activities from ${startTimestamp} to ${endTimestamp}`);
        const activities = await this.db.find({
            activityId: { $ne: null },
            activityStartTime: { $gte: startTimestamp, $lte: endTimestamp }
        }).sort({ activityStartTime: -1 }); // 按开始时间从近到远排序
        return activities;
    }

    async deleteHistoryActivity(activityId) {
        const activity = await this.db.findOne({ activityId: activityId });
        if (!activity) {
            return { success: false, message: 'history activity not found' };
        }
        try {
            await fs.promises.rm(activity.activityPath, { recursive: true });
        } catch (error) {
            logger.warn(`failed to delete history activity ${activityId}: ${error.message}`);
        }
        await this.db.remove({ activityId: activityId });
        logger.info(`history activity ${activityId} deleted`);
        return { success: true };
    }

    async getHistoryActivityById(activityId) {
        const activity = await this.db.findOne({ activityId: activityId });
        if (!activity) {
            return { success: false, message: 'history activity not found' };
        }

        return { success: true, activity: activity };
    }

    async saveActivity(activity) {
        await this.db.update(
            { activityId: activity.activityId },
            { $set: activity.toJSON() },
            { upsert: true }
        );
    }

    /**
     * 开始定时截屏
     * @param {string} activityName 活动名称
     */
    async startRecallCapture(activityName) {
        if (this.currentActivity) {
            logger.warn('recall capture is already running');
            return { success: false, message: 'recall capture is already running' };
        }

        const activityId = crypto.randomUUID();
        const activityPath = path.join(this.appDataDirectory, 'activities', activityId);
        this.currentActivity = new RecallActivity(activityId, activityName, activityPath);
        logger.info(`starting recall capture for activity ${activityName} @ ${activityPath}`);

        // 立即请求截屏一次
        await this.requestScreenshot();

        // 设置定时器
        this.currentActivity.activityInterval = setInterval(async () => {
            try {
                await this.requestScreenshot();
            } catch (error) {
                logger.error(`error in scheduled screenshot: ${error.message}`, error);
            }
        }, this.currentActivity.activityIntervalMs);

        return { success: true, activity: this.currentActivity.toJSON() };
    }

    /**
     * 停止定时截屏
     */
    async stopRecallCapture() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        clearInterval(this.currentActivity.activityInterval);
        logger.info(`stop recall capture for activity: ${this.currentActivity.activityName}`);

        this.currentActivity.activityInterval = null;
        this.currentActivity.activityDuration = Date.now() - this.currentActivity.activityStartTime;
        await this.saveActivity(this.currentActivity);
        logger.info(`recall capture for activity ${this.currentActivity.activityName} saved to database`);

        this.currentActivity = null;
        return { success: true };
    }

    async getLatestThumbnail() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        // Return stored thumbnails in currentActivity as base64 strings in JSON
        // currentActivity.latestThumbnail is a Map of monitorId => Buffer
        const thumbnails = {};
        for (const [monitorId, buffer] of this.currentActivity.latestThumbnail.entries()) {
            thumbnails[monitorId] = `data:image/webp;base64,${buffer.toString('base64')}`;
        }
        return { success: true, thumbnails };
    }

    async requestScreenshot() {
        logger.info('requesting screenshot');

        // 构建文件保存目录
        const saveDir = path.join(this.currentActivity.activityPath, 'screenshots');
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }

        let monitors = Monitor.all();

        for (let monitor of monitors) {
            try {
                let image = await monitor.captureImage();
                let pngImage = await image.toPng();

                const now = new Date();

                const fileName = `screenshot_${now.getTime()}_${monitor.id}.webp`;
                const filePath = path.join(saveDir, fileName);
                const finalBuffer = await sharp(pngImage)
                    .webp({ quality: 70, method: 6 })
                    .toBuffer();
                fs.writeFileSync(filePath, finalBuffer);

                const thumbnailPath = filePath.replace('.webp', '.thumbnail.webp');
                const thumbnailBuffer = await sharp(pngImage)
                    .resize({ width: Math.floor(image.width / 5), height: Math.floor(image.height / 5) })
                    .webp({ quality: 40, method: 6 })
                    .toBuffer();

                fs.writeFileSync(thumbnailPath, thumbnailBuffer);
                this.currentActivity.latestThumbnail.set(monitor.id, thumbnailBuffer);
                logger.info(`recall screenshot saved: ${filePath}`);
            } catch (error) {
                logger.error(`failed to take screenshot for monitor ${monitor.id}: ${error.message}`);
            }
        }

        return { success: true };
    }

    async startService() {

    }

    async stopService() {

    }
}

(new RecallWorker()).initialize();