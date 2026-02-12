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

/**
 * 文件系统服务
 * 负责处理文件和文件夹的系统级操作
 */

import { getPlatform } from '../../../../platforms/base';
import fs from 'fs';

class FileSystemService {
    /**
     * 打开活动文件夹
     * @param {string} dirPath 活动文件夹路径
     */
    async openActivityFolder(dirPath) {
        await getPlatform().openPath(dirPath);
        return { success: true, message: 'activity folder opened' };
    }

    /**
     * 预览活动PDF
     * @param {string} activityId 活动ID
     */
    async previewActivityPDF(pdfPath) {
        try {
            await getPlatform().openPath(pdfPath);
            return { success: true, message: 'PDF opened for preview' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }

    /**
     * 在文件管理器中显示文件
     * @param {string} filePath 文件路径
     */
    async showFileInFolder(filePath) {
        try {
            if (!fs.existsSync(filePath)) {
                return { success: false, message: 'File does not exist' };
            }

            await getPlatform().showItemInFolder(filePath);
            return { success: true, message: 'File shown in folder' };
        } catch (error) {
            return { success: false, message: error.message };
        }
    }
}

// 导出单例
export const fileSystemService = new FileSystemService();
