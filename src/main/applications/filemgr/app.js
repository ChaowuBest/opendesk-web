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

function formatStorageStatusBlock(storage) {
    if (!storage) return '存储统计\n  (暂无数据)';
    const isFull = storage.mode === 'full';
    const modeLabel = isFull ? '完整' : '基础（向量搜索不可用）';
    const lines = [`索引模式: ${modeLabel}`];

    if (isFull) {
        lines.push(
            `向量嵌入: ${storage.embedded_count ?? 0} / ${storage.total_files ?? 0} 已完成（${storage.pending_count ?? 0} 待处理）`
        );
    } else if ((storage.embedded_count ?? 0) > 0) {
        lines.push(`已嵌入文件: ${storage.embedded_count} 条（嵌入暂停）`);
    }

    if (storage.last_embedding_task_at) {
        lines.push(`最近嵌入任务: ${new Date(storage.last_embedding_task_at).toLocaleString()}`);
    }

    const chunkPart = isFull ? `内容分片 ${storage.chunk_size ?? 0} 条` : '内容分片 未加载（基础模式）';
    lines.push(`存储占用: 元数据 ${storage.db_size ?? 0} 条 | ${chunkPart}`);
    return lines.join('\n');
}

const REBUILD_EVENT_TTL_MS = 24 * 60 * 60 * 1000;

function getVisibleRebuildEvent(data) {
    const event = data?.last_rebuild_event;
    if (!event?.ts) return null;
    return Date.now() - event.ts <= REBUILD_EVENT_TTL_MS ? event : null;
}

function reasonLabel(reason) {
    const map = {
        base_init_failed: '存储初始化失败',
        manual_reset: '手动重置',
        open_full_failed: '索引文件损坏',
        embedding_config_changed: '嵌入配置变更'
    };
    return map[reason] ?? reason;
}

class FileMgrApplication extends BaseApplication {
    constructor() {
        super('filemgr', '文件');
    }

    async getTUIStatusBlock() {
        try {
            const setting = Setting.getInstance();
            const entries = setting.getData().applications?.filemgr?.entries ?? [];

            if (entries.length === 0) {
                return '⚠ ' + t('filemgr.scan.dir.not.configured');
            }

            const result = await this.callWorker('getFileSystemStatus');
            if (!result?.data) return null;
            const data = result.data;

            const visibleRebuildEvent = getVisibleRebuildEvent(data);

            if (data.readonly && data.isDeferred && data.deferredReason === 'missing_base_index') {
                return '⚠ 查询模式：暂无可查询索引，请在主窗口完成扫描后重新打开';
            } else if (data.readonly && data.isDeferred) {
                return '⚠ 查询模式：索引暂不可用，请关闭其他窗口后重试';
            } else if (data.readonly && data.storage?.mode === 'base-only') {
                return '⚠ 查询模式：基础索引可用，语义搜索不可用；重新打开后可感知更新';
            } else if (data.readonly) {
                return '⚠ 查询模式：使用已有索引，本窗口不扫描不更新';
            } else if (data.probe_permanent_error) {
                return `⚠ 向量嵌入不可用：${data.probe_permanent_error.message}`;
            } else if (Object.keys(data.unavailable_roots ?? {}).length > 0) {
                const roots = Object.keys(data.unavailable_roots);
                return `⚠ 以下扫描路径暂时不可访问，索引已保留：${roots.join(', ')}`;
            } else if (data.storage?.mode === 'base-only') {
                try {
                    setting.getDefaultEmbeddingModelInstance();
                    return '⚠ 向量嵌入暂时不可用，将在下次扫描时自动重试';
                } catch {
                    return '⚠ ' + t('filemgr.embedding.model.not.configured');
                }
            } else if (visibleRebuildEvent?.status === 'failed') {
                return `⚠ 最近索引重建失败：${reasonLabel(visibleRebuildEvent.reason)}，请查看日志`;
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

        // Decision #18: register semantic tools regardless of embedding config.
        // Worker layer returns code:'EMBED_UNAVAILABLE' when unavailable.
        const searchByNameTool = new BaseTool(
            'searchFileByName',
            '根据文件名语义搜索文件。适用于"找和 auth 相关的文件"等场景。返回按相关度排序的文件列表。嵌入模型不可用时返回 EMBED_UNAVAILABLE，请改用 grepFiles / searchFileByKeyword。',
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
            '根据文件内容语义搜索文件。嵌入模型不可用时返回 EMBED_UNAVAILABLE，请改用 grepFiles / searchFileByKeyword。',
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

        return [toolset];
    }

    async getSkills() {
        return [Skill.parseMd(FILE_NAVIGATION_SKILL)];
    }

    openPath(filePath) {
        open(filePath);
    }

    getCliSlashCommands(tui) {
        function formatFsStatusMessage(data) {
            const statusMap = {
                running: '正常',
                paused: '暂停',
                readonly: '查询模式',
                idle: '未初始化',
                error: '错误'
            };
            const lines = [`状态: ${statusMap[data.status] ?? data.status}`, ''];
            const scanners = data.scanners ?? [];

            if (data.readonly && data.isDeferred && data.deferredReason === 'missing_base_index') {
                lines.push('暂无可查询索引');
                lines.push('  当前窗口未持有扫描锁，不会创建索引。');
                lines.push('  请等待主窗口完成首次文件扫描后，重新打开此窗口。');
            } else if (data.readonly && data.isDeferred) {
                lines.push('查询模式：索引暂不可用');
                lines.push('  当前窗口未持有扫描锁，不会创建或修复索引。');
                lines.push('  请关闭其他窗口后重试，或查看日志。');
            } else if (data.readonly) {
                const modeText = data.storage?.mode === 'base-only' ? '基础索引可用，语义搜索不可用' : '完整索引可用';
                lines.push(`查询模式：${modeText}`);
                lines.push('  当前窗口未持有扫描锁，不扫描不更新。');
                lines.push('  文件扫描和索引更新由主窗口负责。');
            } else if (scanners.length === 0) {
                lines.push('暂无扫描目录');
                lines.push('运行 /config -> 文件扫描配置 添加目录');
            } else {
                for (const s of scanners) {
                    lines.push(s.root ?? s.entry?.root);

                    const unavailable = (data.unavailable_roots ?? {})[s.root ?? s.entry?.root];
                    if (unavailable) {
                        lines.push(
                            `  ⚠ 暂时不可访问，索引已保留（上次 ${unavailable.last_count?.toLocaleString() ?? 0} 个文件）`
                        );
                    } else if (data.isDeferred) {
                        lines.push('  初始化中...');
                    } else if (s.lastFullScan === 0 && s.isRunning) {
                        lines.push('  首次扫描进行中...');
                    } else if (s.lastFullScan === 0) {
                        lines.push('  从未扫描');
                    } else {
                        const lastScan = new Date(s.lastFullScan).toLocaleString();
                        lines.push(`  上次全量扫描: ${lastScan} | 文件数: ${s.totalFiles ?? 0}`);
                    }
                    lines.push('');
                }
            }

            lines.push('');
            lines.push(...formatStorageStatusBlock(data.storage).split('\n'));

            const visibleRebuildEvent = getVisibleRebuildEvent(data);
            if (visibleRebuildEvent) {
                const evtType = visibleRebuildEvent.type === 'full' ? '文件索引' : '向量索引';
                const evtReason = reasonLabel(visibleRebuildEvent.reason);
                const evtStatus = visibleRebuildEvent.status === 'completed' ? '已完成' : '失败';
                const ago = Math.round((Date.now() - visibleRebuildEvent.ts) / 60000);
                let summary = `最近索引重建: ${evtType}（${evtReason}）${evtStatus}，${ago} 分钟前`;
                if (visibleRebuildEvent.status === 'failed' && visibleRebuildEvent.message) {
                    summary += `：${visibleRebuildEvent.message}`;
                }
                lines.push(summary);
            }

            lines.push('');

            if (data.readonly && data.isDeferred && data.deferredReason === 'missing_base_index') {
                lines.push('⚠️ 查询模式：暂无可查询索引。请等待主窗口完成首次扫描后重新打开此窗口。');
            } else if (data.readonly && data.isDeferred) {
                lines.push('⚠️ 查询模式：索引暂不可用，请关闭其他窗口后重试或查看日志。');
            } else if (data.readonly && data.storage?.mode === 'base-only') {
                lines.push('⚠️ 查询模式：基础索引可用，语义搜索不可用。如主窗口已完成向量索引，请重新打开此窗口。');
            } else if (data.readonly) {
                lines.push('⚠️ 查询模式：使用启动时打开的完整索引；文件扫描和索引更新由主窗口负责。');
            } else if (data.probe_permanent_error) {
                lines.push(`⚠️ 向量嵌入不可用：${data.probe_permanent_error.message}`);
            } else if (Object.keys(data.unavailable_roots ?? {}).length > 0) {
                lines.push('⚠️ 部分扫描路径暂时不可访问，索引已保留。');
            } else if (data.storage?.mode === 'base-only') {
                try {
                    Setting.getInstance().getDefaultEmbeddingModelInstance();
                    lines.push('⚠️ 向量嵌入暂时不可用，将在下次扫描时自动重试。');
                } catch {
                    lines.push('⚠️ 向量嵌入不可用：未配置嵌入模型。运行 /config 配置。');
                }
            } else if (visibleRebuildEvent?.status === 'failed') {
                lines.push(`⚠️ 最近索引重建失败：${reasonLabel(visibleRebuildEvent.reason)}。请查看日志。`);
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

export { FileMgrApplication, formatStorageStatusBlock };
