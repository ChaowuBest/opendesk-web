const { BaseService } = require("../../base");
const path = require('path');
const { desktopCapturer } = require('electron');
const { logger } = require('../../../utils/logger');
const { getAppDirectory } = require('../../../utils/setting');
const { shell } = require('electron');
const fs = require('fs');


class RecallService extends BaseService {

    constructor() {
        super();
    }

    static getWorkerPath() {
        return path.join(__dirname, 'worker.js');
    }

    static async getRecallStatus() {
        return await this.sendMessage('getRecallStatus', {});
    }

    static async startRecallCapture(recallActivityName) {
        return await this.sendMessage('startRecallCapture', recallActivityName);
    }

    static async stopRecallCapture() {
        return await this.sendMessage('stopRecallCapture', {});
    }

    static async getHistoryActivities(startTimestamp, endTimestamp) {
        return await this.sendMessage('getHistoryActivities', startTimestamp, endTimestamp);
    }

    static async getHistoryActivityById(activityId) {
        return await this.sendMessage('getHistoryActivityById', activityId);
    }

    static async deleteHistoryActivity(activityId) {
        return await this.sendMessage('deleteHistoryActivity', activityId);
    }

    static async openHistoryActivity(activityId) {
        const activity = await this.getHistoryActivityById(activityId);
        if (!activity.success) {
            return { success: false, message: activity.message };
        }
        shell.openPath(activity.activity.activityPath);
        return { success: true, message: 'history activity opened' };
    }

    static async getLatestThumbnail() {
        return await this.sendMessage('getLatestThumbnail', {});
    }

}

module.exports = { RecallService };