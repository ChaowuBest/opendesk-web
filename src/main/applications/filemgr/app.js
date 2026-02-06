import { BaseApplication, BaseGUIConfig } from "../base.js";
import { BaseTool, BaseToolset } from "../../agents/tool";
import { FSEntrySchema } from './setting.js';
import open from 'open';
import { z } from 'zod';
import path from 'path';


class FileMgrApplication extends BaseApplication {
    constructor() {
        super('filemgr', '文件');
    }

    getGUIConfig() {
        return new BaseGUIConfig(
            [path.join(import.meta.dirname, 'renderer', 'entry.js')],
            'filemgr-entry-widget',
            `/applications/filemgr/icon.png`
        );
    }

    static getConfigSchema() {
        return z.object({
            enabled: z.boolean().describe('启用AI文件系统').default(false),
            entries: z.array(FSEntrySchema).describe('文件系统入口').default([]),
        });
    }

    async getToolsets() {
        const toolset = new BaseToolset('filemgr');
        const searchFileTool = new BaseTool(
            'searchFile',
            '根据给定的查询内容对文件进行模糊搜索',
            z.object({
                query: z.string().describe('查询内容'),
            })
        );
        searchFileTool.setExecutor(async (args) => {
            const result = await this.callWorker('searchFilesByNameSimilarity', args.query);
            console.info(result);
            return JSON.stringify(result);
        });
        toolset.addTool(searchFileTool);
        return [toolset];
    }

    openPath(filePath) {
        open(filePath);
    }
}

export { FileMgrApplication };