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

import { BaseApplication } from "../base";
import { BaseTool } from "../../aikernel/tool";
import { FSEntrySchema } from './setting.js';
import { createFileManagerToolset } from './tools.js';
import { Setting } from '../../utils/setting.js';
import open from 'open';
import { z } from 'zod';
import FileManagerWorker from "./worker";


class FileMgrApplication extends BaseApplication {
    constructor() {
        super('filemgr', '文件');
    }

    static getWorkerClass() {
        return FileManagerWorker;
    }

    static getConfigSchema() {
        return z.object({
            enabled: z.boolean().describe('启用AI文件系统').default(false),
            entries: z.array(FSEntrySchema).describe('文件系统入口').default([]),
        });
    }

    async getToolsets() {
        const toolset = createFileManagerToolset();

        // 仅在配置了嵌入模型时才注册 searchFile 工具
        try {
            const setting = Setting.getInstance();
            const embeddingModel = setting.getModelInstance(setting.data.default_embedding_model);
            if (embeddingModel) {
                const searchFileTool = new BaseTool(
                    'searchFile',
                    '根据给定的查询内容对文件进行模糊搜索',
                    z.object({
                        query: z.string().describe('查询内容'),
                    })
                );
                searchFileTool.setExecutor(async (args) => {
                    const result = await this.callWorker('searchFilesByNameSimilarity', args.query);
                    return JSON.stringify(result);
                });
                toolset.addTool(searchFileTool);
            }
        } catch {
            // 嵌入模型未配置，跳过 searchFile 工具注册
        }

        return [toolset];
    }

    openPath(filePath) {
        open(filePath);
    }
}

export { FileMgrApplication };
