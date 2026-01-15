import { BaseApplication, BaseGUIConfig } from "../base.js";
import { RecallService } from "./service/service.js";
import { z } from 'zod';
import path from 'path';

const __dirname = import.meta.dirname;


class RecallApplication extends BaseApplication {
    constructor() {
        super('recall', '快速记录');
    }

    getServices() {
        return [RecallService];
    }

    getConfigSchema() {
        return z.object({

        });
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'widgets', 'entry.js')],
            'recall-entry-widget',
            path.join(import.meta.dirname, 'icon.png')
        );
    }

    async handleMessage(message, ...args) {
        switch (message) {
            case 'getRecallStatus':
                return await RecallService.getRecallStatus();
            case 'startRecallCapture':
                const recallActivityName = args[0];
                if (!recallActivityName) {
                    throw new Error('cannot start recall without activity name');
                }
                return await RecallService.startRecallCapture(args[0]);
            case 'stopRecallCapture':
                return await RecallService.stopRecallCapture();
            case 'getWindowList':
                return await RecallService.getWindowList();
            case 'changeSelectedWindow':
                return await RecallService.changeSelectedWindow(args[0]);
            case 'getLatestThumbnails':
                return await RecallService.getLatestThumbnails();
            case 'getHistoryActivities':
                return await RecallService.getHistoryActivities(args[0], args[1]);
            case 'deleteHistoryActivity':
                return await RecallService.deleteHistoryActivity(args[0]);
            case 'openHistoryActivity':
                return await RecallService.openHistoryActivity(args[0]);
            default:
                throw new Error(`unknown message: ${message}`);
        }
    }

    /**
     * 用户请求开始录制活动
     */
    async requestCaptureActivity() {
        const activityName = await dialog.showInputDialog({
            type: 'input',
            title: '录制活动',
            message: '请输入活动名称',
            default: '活动名称'
        });
        if (!activityName) {
            return;
        }
    }
}

export { RecallApplication };