import { BaseApplication, BaseGUIConfig } from "../base.js";
import { z } from 'zod';
import path from 'path';

const __dirname = import.meta.dirname;


class RecallApplication extends BaseApplication {
    constructor() {
        super('recall', '快速记录');
    }

    getConfigSchema() {
        return z.object({

        });
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(__dirname, 'widgets', 'entry.js')],
            'recall-entry-widget',
            `/applications/recall/icon.png`
        );
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