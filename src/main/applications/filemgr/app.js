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
import { logger, getDebugMode } from '../../utils/logger.js';
import { ApplicationRegistry } from '../registry.js';


class FileMgrApplication extends BaseApplication {
    constructor() {
        super('filemgr', '文件');
    }

    async getTUIStatusBlock() {
        try {
            const setting = Setting.getInstance();
            const filemgrConfig = setting.getData().applications?.filemgr;
            const entries = filemgrConfig?.entries ?? [];
            if (entries.length === 0) {
                return '⚠ 文件扫描目录未配置';
            }
            try {
                setting.getDefaultEmbeddingModelInstance();
            } catch {
                return '⚠ 向量嵌入模型未配置';
            }
            return null;
        } catch {
            return null;
        }
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

    getCliSlashCommands(tui) {
        /**
         * 格式化 storage 统计区块。
         * @param {object} storage - { db_size, vecdb_size, veccache_size }
         * @returns {string}
         */
        function formatStorageBlock(storage) {
            if (!storage) {
                return '存储统计\n  (暂无数据)';
            }
            return `存储统计\n  文件总数: ${storage.db_size} 条 | 向量索引: ${storage.vecdb_size} 条 | 向量缓存: ${storage.veccache_size} 条`;
        }

        /**
         * 格式化 /fs-status 的显示内容。
         * 只展示用户可理解的信息：状态、目录、文件数、上次全量扫描时间。
         * 不展示 storage 原始对象或内部 key。
         * @param {object} data - callWorker getStatus 的第二层 data
         * @returns {string}
         */
        function formatFsStatusMessage(data) {
            const lines = [`状态: ${data.status}`, ''];
            const scanners = data.scanners ?? [];
            if (scanners.length === 0) {
                lines.push('暂无扫描目录');
                lines.push('运行 /config -> 文件扫描配置 添加目录');
            } else {
                for (const s of scanners) {
                    const lastScan = s.lastFullScan
                        ? new Date(s.lastFullScan).toLocaleString()
                        : '从未';
                    lines.push(s.entry.root);
                    lines.push(`  文件数: ${s.totalFiles} | 上次全量扫描: ${lastScan}`);
                    lines.push('');
                }
            }
            lines.push('');
            lines.push(...formatStorageBlock(data.storage).split('\n'));
            return lines.join('\n').trimEnd();
        }

        /**
         * 格式化 /fs-status 在 debug 模式下附加的诊断信息。
         * 这些字段用于排查调用链与扫描器状态，不适合在普通模式下展示给用户。
         * @param {object} filemgrConfig
         * @param {object} result - ApplicationRegistry.callWorker 的原始返回
         * @returns {string}
         */
        function formatFsStatusDebugMessage(filemgrConfig, result) {
            const entries = filemgrConfig?.entries ?? [];
            const lines = ['调试信息', `  配置 entries: ${entries.length} 个`];

            if (result.status !== 'ok') {
                lines.push(`  callWorker: ${result.status}`);
                return lines.join('\n');
            }

            const workerResp = result.data;
            lines.push(`  callWorker: ok`);
            lines.push(`  worker 返回: ${workerResp.status}`);

            if (workerResp.status !== 'ok') {
                return lines.join('\n');
            }

            const data = workerResp.data;
            lines.push(`  scannerStatus: ${data.status}`);

            const scanners = data.scanners ?? [];
            const totalFiles = scanners.reduce((sum, s) => sum + (s.totalFiles ?? 0), 0);
            lines.push(`  scanners: ${scanners.length} 个 | 总文件数: ${totalFiles}`);

            return lines.join('\n');
        }

        return [
            {
                name: 'fs-status',
                description: '查看文件扫描状态（scanner 状态、目录文件数、最近全量扫描时间）',
                execute: async () => {
                    try {
                        const result = await ApplicationRegistry.callWorker('filemgr', 'getStatus');

                        // 这里存在三层状态判断，但职责不同，不能混为一个 status：
                        // 1. result.status：主线程 -> 全局 worker 的 RPC 调用是否成功。
                        // 2. workerResp.status：filemgr worker 方法返回包是否成功。
                        // 3. workerResp.data.status：文件扫描业务状态（idle/running/error），这是用户真正关心的状态。
                        if (result.status !== 'ok') {
                            const msg = `获取状态失败: ${result.message ?? result.status}`;
                            logger.warn(`[fs-status] ${msg}`);
                            tui.showTextPage('文件扫描状态', msg);
                            return;
                        }

                        const workerResp = result.data;
                        if (workerResp.status !== 'ok') {
                            const msg = `worker 返回错误: ${workerResp.message ?? workerResp.status}`;
                            logger.warn(`[fs-status] ${msg}`);
                            tui.showTextPage('文件扫描状态', msg);
                            return;
                        }

                        if (!workerResp.data) {
                            const msg = 'worker 返回数据为空';
                            logger.warn(`[fs-status] ${msg}`);
                            tui.showTextPage('文件扫描状态', msg);
                            return;
                        }

                        let message = formatFsStatusMessage(workerResp.data);
                        const storage = workerResp.data.storage ?? {};
                        const dbSize = storage.db_size ?? 0;
                        const vecSize = storage.vecdb_size ?? 0;
                        if (dbSize > 0 && vecSize === 0) {
                            let embeddingConfigured = true;
                            try {
                                Setting.getInstance().getDefaultEmbeddingModelInstance();
                            } catch {
                                embeddingConfigured = false;
                            }
                            if (!embeddingConfigured) {
                                message += '\n\n⚠️ 检测到未配置有效的向量嵌入模型，文件相似度检索不可用。';
                                message += '\n请运行 /config -> 默认模型配置 设置“向量嵌入模型”。';
                            }
                        }
                        if (getDebugMode()) {
                            const setting = Setting.getInstance();
                            const filemgrConfig = setting.getApplicationConfig('filemgr');

                            logger.info('[fs-status] === FileMgr 调试摘要 ===');
                            logger.info(`[fs-status] entriesCount: ${(filemgrConfig?.entries ?? []).length}`);
                            logger.info(`[fs-status] callWorkerStatus: ${result.status}`);
                            logger.info(`[fs-status] workerStatus: ${workerResp.status}`);
                            logger.info(`[fs-status] scannerStatus: ${workerResp.data.status}`);
                            logger.info(`[fs-status] scannersCount: ${(workerResp.data.scanners ?? []).length}`);
                            logger.info(`[fs-status] storageStats: db=${dbSize}, vecdb=${vecSize}, cache=${storage.veccache_size ?? 0}`);
                            logger.info('[fs-status] =======================');

                            message += `\n\n${formatFsStatusDebugMessage(filemgrConfig, result)}`;
                        }

                        tui.showTextPage('文件扫描状态', message);
                    } catch (e) {
                        const msg = `fs-status 异常: ${e?.message ?? e}`;
                        logger.error(`[fs-status] ${msg}`);
                        tui.showTextPage('文件扫描状态', msg);
                    }
                },
            },
        ];
    }
}

export { FileMgrApplication };
