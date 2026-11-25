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
import { t as appT } from './locale/index.js';
import { FSEntrySchema } from './setting.js';
import { SemanticSearchTool, createFileManagerToolset } from './tools.js';
import { Setting } from '../../utils/setting.js';
import { electron } from '../../../utils/electron.js';
import { z } from 'zod';
import FileManagerWorker from './worker';
import { extractText as extractFileTextDirect } from './parser/extract.js';
import { logger, getDebugMode } from '../../utils/logger.js';
import { ApplicationRegistry } from '../registry.js';
import { t } from '../../../locale/index.js';
import { getFeatureManager } from '../../../common/features/manager.js';
import './harness/index.js';

function probeErrorMessage(code) {
    return code === 'dim_unsupported' ? t('filemgr.alert.dim_unsupported') : t('filemgr.alert.embedding_unavailable');
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
        super('filemgr');
    }

    getName() {
        return appT('app.name');
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

            if (data.readonly) {
                return null;
            } else if (data.probe_error) {
                return '⚠ ' + probeErrorMessage(data.probe_error.code);
            } else if (Object.keys(data.unavailable_roots ?? {}).length > 0) {
                const roots = Object.keys(data.unavailable_roots);
                return `⚠ 以下扫描路径暂时不可访问，索引已保留：${roots.join(', ')}`;
            } else if (data.storage?.mode === 'base-only') {
                const embModel = setting.getDefaultEmbeddingModelInstance();
                if (!embModel) {
                    return '⚠ ' + t('filemgr.embedding.model.not.configured');
                } else {
                    return '⚠ ' + t('filemgr.embedding.temporarily_unavailable');
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

    async searchIndexedFiles(query, options = {}) {
        const resp = await this.callWorker('searchIndexedFiles', query, options);
        if (resp?.status === 'error') {
            throw new Error(resp.message ?? t('filemgr.search.failed'));
        }
        return resp?.data;
    }

    static getConfigSchema() {
        return z.object({
            enabled: z.boolean().describe('启用AI文件系统').default(false),
            entries: z.array(FSEntrySchema).describe('文件系统入口').default([])
        });
    }

    async getSupportedEvents() {
        return [
            {
                eventName: 'onStatusChanged',
                eventDescription: '文件系统状态快照发生变化'
            }
        ];
    }

    publishStatusChanged(payload) {
        this.sendEventToSubscribers('onStatusChanged', payload);
        this.noticeTUIStatusUpdate();
    }

    async getToolsets() {
        const toolset = createFileManagerToolset({
            extractDelegate: async (filePath) => {
                try {
                    const resp = await this.callWorker('extractFileText', filePath);
                    if (resp?.status === 'error') {
                        throw new Error(resp.message ?? '提取失败');
                    }
                    return resp?.data ?? null;
                } catch (err) {
                    // Worker 不可用时回退到主线程直接提取，避免功能完全不可用
                    return await extractFileTextDirect(filePath);
                }
            }
        });

        // ctx.features.disableFeature('filesystem') 只关闭 AI 索引相关能力（语义搜索），
        // 纯文件读写/grep 等工具不受影响；isAvailable 里的门控是任务构建期的第二道防线
        if (!getFeatureManager().isFeatureDisabled('filesystem')) {
            toolset.addTool(
                new SemanticSearchTool((query, maxResults, scope) =>
                    this.searchIndexedFiles(query, {
                        topK: maxResults,
                        scope,
                        routes: ['keyword', 'name_semantic', 'content_semantic']
                    })
                )
            );
        }

        return [toolset];
    }

    openPath(filePath) {
        electron().shell.openPath(filePath);
    }

    getCliSlashCommands(tui) {
        function modeLabel(mode) {
            return (
                {
                    full: '完整索引',
                    'base-only': '基础索引'
                }[mode] ?? mode
            );
        }

        function statusLabel(status) {
            const key =
                {
                    idle: 'renderer.filemgr.status.idle',
                    initializing: 'renderer.filemgr.status.initializing',
                    running: 'renderer.filemgr.status.running',
                    readonly: 'renderer.filemgr.status.readonly',
                    disabled: 'renderer.filemgr.status.disabled',
                    error: 'renderer.filemgr.status.error'
                }[status] ?? null;
            return key ? '● ' + t(key) : status;
        }

        function alertMessage(alert) {
            if (!alert) return null;
            switch (alert.code) {
                case 'no_roots':
                    return t('filemgr.alert.no_roots');
                case 'embed_model_missing':
                    return t('filemgr.embedding.model.not.configured');
                case 'embedding_pending':
                    return t('filemgr.embedding.pending');
                case 'dim_unsupported':
                    return t('filemgr.alert.dim_unsupported');
                case 'embedding_unavailable':
                    return t('filemgr.alert.embedding_unavailable');
                case 'semantic_capacity_limited':
                    return t('filemgr.alert.semantic_capacity_limited');
                case 'worker_init_failed':
                    return t('filemgr.alert.worker_init_failed', {
                        reason: alert.data?.reason ?? 'unknown error'
                    });
                default:
                    return alert.code;
            }
        }

        function timeTag(ts) {
            if (ts === null || ts === undefined) return '等待首次扫描';
            const diff = Math.max(0, Date.now() - ts);
            if (diff < 60_000) return '刚刚扫描';
            if (diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} 分钟前`;
            if (diff < 24 * 60 * 60_000) return `${Math.floor(diff / (60 * 60_000))} 小时前`;
            return `${Math.floor(diff / (24 * 60 * 60_000))} 天前`;
        }

        function sourceStateLine(source, mode, fullTextVisible) {
            const total = (source.total_files ?? 0).toLocaleString();
            const embedded = (source.embedded_count ?? 0).toLocaleString();
            const pending = (source.pending_count ?? 0).toLocaleString();
            if (source.paused === true) {
                return t('renderer.filemgr.source.pausedWithCount', { count: total });
            }
            if (source.state === 'unavailable') return `路径不可访问 · 上次 ${total} 文件`;
            if (source.metadata_write_pending === true) return t('renderer.filemgr.source.metadataWritePending');
            if (fullTextVisible && source.full_text?.pending > 0)
                return t('renderer.filemgr.source.fullText.withCounts', {
                    done: (source.full_text.done + source.full_text.excluded).toLocaleString(),
                    total
                });
            if (source.state === 'pending') return '等待扫描';
            if (source.state === 'scanning') return `扫描中 · ${embedded} / ${total} 文件（待处理 ${pending}）`;
            if (source.state === 'completed' && mode === 'base-only') return `基础索引 · ${total} 文件`;
            if (source.state === 'completed') return `已完成 · ${total} 文件`;
            return source.state;
        }

        function formatFsStatusMessage(data) {
            const mode = data.mode ?? data.storage?.mode ?? null;
            const fullTextVisible = Boolean(
                data.full_text &&
                !['unsupported', 'open_failed', 'tokenizer_unavailable'].includes(data.full_text.reason)
            );
            const lines = [`状态: ${statusLabel(data.status)}${mode ? ` · ${modeLabel(mode)}` : ''}`, ''];
            const alert = data.alerts?.[0];
            const alertText = alertMessage(alert);
            if (alertText) {
                lines.push(`告警: ${alertText}`, '');
            }

            const sources = data.sources ?? [];
            if (data.readonly && data.isDeferred && data.deferredReason === 'missing_base_index') {
                lines.push('暂无可查询索引');
                lines.push('  当前窗口只用于查询，不会创建索引。');
                lines.push('  请等待主窗口完成首次文件扫描后，重新打开此窗口。');
            } else if (sources.length === 0) {
                lines.push('暂无扫描目录');
                if (data.status === 'idle') lines.push('运行 /config -> 文件扫描配置 添加目录');
            } else {
                lines.push('数据源:');
                for (const source of sources) {
                    const tags = source.is_workspace ? ' [工作空间]' : '';
                    lines.push(`  ${source.root}${tags}`);
                    lines.push(
                        `    ${sourceStateLine(source, mode, fullTextVisible)} · ${timeTag(source.last_scan_at)}`
                    );
                }
            }

            if (data.totals) {
                lines.push(
                    '',
                    `总计: ${(data.totals.total_files ?? 0).toLocaleString()} 文件 | ` +
                        `已嵌入 ${(data.totals.embedded_count ?? 0).toLocaleString()} | ` +
                        `待处理 ${(data.totals.pending_count ?? 0).toLocaleString()}`
                );
                if (fullTextVisible) {
                    lines.push(
                        t(
                            data.full_text.reason === 'resetting'
                                ? 'filemgr.status.fullText.resetting'
                                : 'filemgr.status.fullText.summary',
                            {
                                done: (
                                    (data.full_text.done ?? 0) +
                                    sources.reduce((sum, source) => sum + (source.full_text?.excluded ?? 0), 0)
                                ).toLocaleString(),
                                total: sources
                                    .reduce((sum, source) => sum + (source.full_text?.total ?? 0), 0)
                                    .toLocaleString(),
                                pending: (data.full_text.pending ?? 0).toLocaleString(),
                                failed: (data.full_text.failed ?? 0).toLocaleString()
                            }
                        )
                    );
                }
                if (data.totals.last_embedding_task_at) {
                    lines.push(`最近嵌入任务: ${timeTag(data.totals.last_embedding_task_at)}`);
                }
            }

            const storageStats = data.storage_stats;
            if (storageStats) {
                lines.push(
                    `存储: 元数据 ${(storageStats.db_size ?? 0).toLocaleString()} | ` +
                        `向量 ${(storageStats.vecdb_size ?? 0).toLocaleString()} | ` +
                        `分片 ${(storageStats.chunk_size ?? 0).toLocaleString()}`
                );
            }

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

            if (alertText) {
                lines.push(`⚠️ ${alertText}`);
            } else if (data.readonly && data.isDeferred && data.deferredReason === 'missing_base_index') {
                lines.push('⚠️ 查询模式：暂无可查询索引。请等待主窗口完成首次扫描后重新打开此窗口。');
            } else if (data.readonly && data.isDeferred) {
                lines.push('⚠️ 查询模式：索引暂不可用，请关闭其他窗口后重试或查看日志。');
            } else if (data.readonly && mode === 'base-only') {
                lines.push('⚠️ 查询模式：基础索引可用，语义搜索不可用。如主窗口已完成向量索引，请重新打开此窗口。');
            } else if (data.readonly) {
                lines.push('⚠️ 查询模式：正在使用已有完整索引；本窗口不会扫描或更新文件。');
            } else if (data.probe_error) {
                lines.push(`⚠️ ${probeErrorMessage(data.probe_error.code)}`);
            } else if (Object.keys(data.unavailable_roots ?? {}).length > 0) {
                lines.push('⚠️ 部分扫描路径暂时不可访问，索引已保留。');
            } else if (mode === 'base-only') {
                try {
                    Setting.getInstance().getDefaultEmbeddingModelInstance();
                    lines.push(`⚠️ ${t('filemgr.embedding.temporarily_unavailable')}`);
                } catch {
                    lines.push(`⚠️ ${t('filemgr.embedding.missing_config_hint')}`);
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
            lines.push(`  mode: ${data.mode ?? data.storage?.mode ?? 'null'}`);
            lines.push(`  isDeferred: ${data.isDeferred ?? false}`);

            const sources = data.sources ?? [];
            const totalFiles = data.totals?.total_files ?? sources.reduce((sum, s) => sum + (s.total_files ?? 0), 0);
            lines.push(`  sources: ${sources.length} 个 | 总文件数: ${totalFiles}`);

            const storage = data.storage_stats ?? data.storage ?? {};
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
