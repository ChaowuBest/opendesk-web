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

import { BaseApplication } from "../base.js";
import { z } from 'zod';
import { fileSystemService } from './service/fileSystemService.js';
import RecallWorker from "./service/worker";


class RecallApplication extends BaseApplication {
    constructor() {
        super('recall', 'Recall');
    }

    static getWorkerClass() {
        return RecallWorker;
    }

    static getConfigSchema() {
        return z.object({

        });
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

    // ==================== 文件系统操作（委托给 service 层）====================
    /**
     * 打开活动文件夹
     * @param {string} dirPath 活动文件夹路径
     */
    async openActivityFolder(dirPath) {
        return await fileSystemService.openActivityFolder(dirPath);
    }

    /**
     * 预览活动PDF
     * @param {string} pdfPath PDF文件路径
     */
    async previewActivityPDF(pdfPath) {
        return await fileSystemService.previewActivityPDF(pdfPath);
    }

    /**
     * 在文件管理器中显示文件
     * @param {string} filePath 文件路径
     */
    async showFileInFolder(filePath) {
        return await fileSystemService.showFileInFolder(filePath);
    }

}

export { RecallApplication };