import { BaseService } from "../../base.js";
import path from 'path';
import { Window } from 'node-screenshots';
import { shell } from 'electron';

const __dirname = import.meta.dirname;


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
        return await this.sendMessage('stopRecallCapture');
    }

    static async getWindowList() {
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

    static async changeSelectedWindow(selectedWindowId) {
        return await this.sendMessage('changeSelectedWindow', selectedWindowId);
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

    static async getLatestThumbnails() {
        return await this.sendMessage('getLatestThumbnails', {});
    }

}

export { RecallService };