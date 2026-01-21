import { BaseWorker } from "../../base.js";
import { logger } from '../../../utils/logger.js';
import { Monitor, Window } from 'node-screenshots';

import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import nedb from 'nedb-promises';


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
        /** @type {string} */
        this.selectedWindowId = 'all';

        /** @type {Buffer[]} */
        this.latestThumbnails = []
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

    constructor(appDataDirectory) {
        super('recall', appDataDirectory);

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

    async getWindowList() {
        let windows = Window.all();
        let result = []
        for (const window of windows) {
            if (window.width < 200 || window.height < 200) {
                continue;
            }
            result.push({
                windowId: window.id,
                windowTitle: window.title
            })
        }
        return result;
    }


    async changeSelectedWindow(selectedWindowId) {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }
        this.currentActivity.selectedWindowId = selectedWindowId;
        return { success: true };
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

    async getLatestThumbnails() {
        if (!this.currentActivity) {
            return { success: false, message: 'recall capture is not running' };
        }

        return {
            success: true,
            thumbnails: this.currentActivity.latestThumbnails.map(buffer => `data:image/webp;base64,${buffer.toString('base64')}`)
        };
    }

    async requestScreenshot() {
        logger.info('requesting screenshot');

        // 构建文件保存目录
        const saveDir = path.join(this.currentActivity.activityPath, 'screenshots');
        if (!fs.existsSync(saveDir)) {
            fs.mkdirSync(saveDir, { recursive: true });
        }

        let sources = [];
        if (this.currentActivity.selectedWindowId === 'all') {
            sources = Monitor.all();
        } else {
            let window = Window.all().find(window => window.id.toString() === this.currentActivity.selectedWindowId);
            if (!window) {
                logger.warn(`window ${this.currentActivity.selectedWindowId} not found, using all monitors instead`);
                sources = Monitor.all();
                this.currentActivity.selectedWindowId = 'all';
            }
            sources = [window];
        }

        let latestThumbnails = [];
        for (let [index, source] of sources.entries()) {
            try {
                let image = await source.captureImage();
                let pngImage = await image.toPng();

                const now = new Date();

                const fileName = `screenshot_${now.getTime()}_${index}.webp`;
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

                latestThumbnails.push(finalBuffer);
                logger.info(`recall screenshot saved: ${filePath}`);
            } catch (error) {
                logger.error(`failed to take screenshot for source ${index}: ${error.message}`);
            }
        }

        this.currentActivity.latestThumbnails = latestThumbnails;
        return { success: true };
    }

}

export default RecallWorker;