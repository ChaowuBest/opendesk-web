import { BaseApplication, BaseGUIConfig } from "../base.js";
import { BaseTool, BaseToolset } from "../../agents/tool.js";
import { FSEntrySchema } from './setting.js';
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

    getConfigSchema() {
        return z.object({
            enabled: z.boolean().describe('启用AI文件系统').default(false),
            entries: z.array(FSEntrySchema).describe('文件系统入口').default([]),
        });
    }

    getToolsets() {
        const toolset = new BaseToolset('filemgr');
        const searchFileTool = new BaseTool(
            'searchFile',
            '根据给定的检索字符串搜索相关文件，搜索结果会同时包含关键字匹配以及语义模糊搜索的内容',
            z.object({
                query: z.string().describe('检索字符串'),
            })
        );
        searchFileTool.setExecutor(async (args) => {
            const result = await Promise.all([
                // FSService.searchFilesByKeyword(args.query),
                // FSService.searchFilesByNameSimilarity(args.query)
            ]);
            console.info(result);
            return JSON.stringify(result);
        });
        toolset.addTool(searchFileTool);
        return [toolset];
    }
}

export { FileMgrApplication };