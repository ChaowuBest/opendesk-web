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

import { BaseApplication } from '../base';
import { BaseTool } from '../../aikernel/tool';
import { FSEntrySchema } from './setting.js';
import { createFileManagerToolset } from './tools.js';
import { Setting } from '../../utils/setting.js';
import open from 'open';
import { z } from 'zod';
import FileManagerWorker from './worker';
import { logger, getDebugMode } from '../../utils/logger.js';
import { ApplicationRegistry } from '../registry.js';
import { FILE_NAVIGATION_SKILL } from './skills.js';
import { Skill } from '../../aikernel/skill.js';
import { t } from '../../../locale/index.js';

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
                return '⚠ ' + t('filemgr.scan.dir.not.configured');
            }
            try {
                setting.getDefaultEmbeddingModelInstance();
            } catch {
                return '⚠ ' + t('filemgr.embedding.model.not.configured');
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
            entries: z.array(FSEntrySchema).describe('文件系统入口').default([])
        });
    }

    async getToolsets() {
        const toolset = createFileManagerToolset();

        try {
            const setting = Setting.getInstance();
            setting.getDefaultEmbeddingModelInstance();

            const searchByNameTool = new BaseTool(
                'searchFileByName',
                '根据文件名语义搜索文件。适用于"找和 auth 相关的文件"等场景。返回按相关度排序的文件列表。',
                z.object({
                    query: z.string().describe('搜索查询'),
                    topK: z.number().optional().describe('返回结果数量上限，默认 20')
                })
            );
            searchByNameTool.setExecutor(async (args) => {
                const result = await this.callWorker('searchFileByName', args.query, args.topK);
                return JSON.stringify(result);
            });
            toolset.addTool(searchByNameTool);

            const searchByContentTool = new BaseTool(
                'searchFileByContent',
                '根据文件内容语义搜索文件。适用于"找讲迁移方案的文档"等场景。返回按相关度排序的文件列表，附带匹配片段。',
                z.object({
                    query: z.string().describe('搜索查询'),
                    topK: z.number().optional().describe('返回结果数量上限，默认 20')
                })
            );
            searchByContentTool.setExecutor(async (args) => {
                const result = await this.callWorker('searchFileByContent', args.query, args.topK);
                return JSON.stringify(result);
            });
            toolset.addTool(searchByContentTool);
        } catch {
            // Embedding model not configured, skip semantic search tools
        }

        return [toolset];
    }

    async getSkills() {
        try {
            Setting.getInstance().getDefaultEmbeddingModelInstance();
        } catch {
            return [];
        }
        return [Skill.parseMd(FILE_NAVIGATION_SKILL)];
    }

    openPath(filePath) {
        open(filePath);
    }

    getCliSlashCommands(tui) {
        function formatStorageBlock(storage) {
            if (!storage) {
                return '存储统计\n  (暂无数据)';
            }
            return `存储统计\n  文件元数据: ${storage.db_size} 条 | 文件名向量: ${storage.vecdb_size} 条 | 内容 chunks: ${storage.chunk_size} 条`;
        }

        function formatFsStatusMessage(data) {
            const lines = [`状态: ${data.status}`, ''];
            const scanners = data.scanners ?? [];

            let embeddingConfigured = true;
            try {
                Setting.getInstance().getDefaultEmbeddingModelInstance();
            } catch {
                embeddingConfigured = false;
            }

            if (scanners.length === 0) {
                lines.push('暂无扫描目录');
                lines.push('运行 /config -> 文件扫描配置 添加目录');
            } else {
                for (const s of scanners) {
                    lines.push(s.root ?? s.entry?.root);

                    if (data.isDeferred) {
                        lines.push('  初始化中...（等待嵌入模型配置）');
                    } else if (!embeddingConfigured && s.lastFullScan === 0) {
                        lines.push('  已暂停（等待嵌入模型配置）');
                    } else if (!embeddingConfigured && s.lastFullScan > 0) {
                        const lastScan = new Date(s.lastFullScan).toLocaleString();
                        lines.push(
                            `  已暂停，上次扫描: ${lastScan} | 文件数: ${s.totalFiles ?? 0} | 失败: ${s.lastFailedCount ?? 0}`
                        );
                    } else if (embeddingConfigured && s.lastFullScan === 0 && s.isRunning) {
                        lines.push('  首次扫描进行中...');
                    } else if (embeddingConfigured && s.lastFullScan === 0) {
                        lines.push('  从未扫描');
                    } else {
                        const lastScan = new Date(s.lastFullScan).toLocaleString();
                        lines.push(
                            `  上次全量扫描: ${lastScan} | 文件数: ${s.totalFiles ?? 0} | 失败: ${s.lastFailedCount ?? 0}`
                        );
                    }
                    lines.push('');
                }
            }

            lines.push('');
            lines.push(...formatStorageBlock(data.storage).split('\n'));

            if (!embeddingConfigured) {
                lines.push('');
                lines.push('⚠️ 当前未配置有效的向量嵌入模型，扫描已暂停。');
                lines.push('请运行 /config -> 默认模型配置 设置”向量嵌入模型”。');
            }

            return lines.join('\n').trimEnd();
        }

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
            lines.push(`  isDeferred: ${data.isDeferred ?? false}`);

            const scanners = data.scanners ?? [];
            const totalFiles = scanners.reduce((sum, s) => sum + (s.totalFiles ?? 0), 0);
            lines.push(`  scanners: ${scanners.length} 个 | 总文件数: ${totalFiles}`);

            const storage = data.storage ?? {};
            lines.push(
                `  storage: db=${storage.db_size ?? 0}, vec=${storage.vecdb_size ?? 0}, chunks=${storage.chunk_size ?? 0}`
            );

            return lines.join('\n');
        }

        return [
            {
                name: 'fs-status',
                description: '查看文件扫描状态（scanner 状态、目录文件数、最近全量扫描时间）',
                execute: async () => {
                    try {
                        const result = await ApplicationRegistry.callWorker('filemgr', 'getStatus');

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

                        if (getDebugMode()) {
                            const setting = Setting.getInstance();
                            const filemgrConfig = setting.getApplicationConfig('filemgr');

                            message += `\n\n${formatFsStatusDebugMessage(filemgrConfig, result)}`;

                            // Recent failures (spec §11.3)
                            for (const s of workerResp.data.scanners ?? []) {
                                const failures = s.recentFailures ?? [];
                                if (failures.length > 0) {
                                    message += `\n\n最近失败文件（${s.root ?? s.entry?.root}）:`;
                                    for (const f of failures) {
                                        message += `\n  ${f.path} - ${f.error}`;
                                    }
                                }
                            }
                        }

                        tui.showTextPage('文件扫描状态', message);
                    } catch (e) {
                        const msg = `fs-status 异常: ${e?.message ?? e}`;
                        logger.error(`[fs-status] ${msg}`);
                        tui.showTextPage('文件扫描状态', msg);
                    }
                }
            }
        ];
    }
}

export { FileMgrApplication };
