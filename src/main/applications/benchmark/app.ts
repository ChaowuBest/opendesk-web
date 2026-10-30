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

import { z } from 'zod';
import { BaseApplication, type EventDecl } from '../base.js';
import { t } from './locale/index.js';
import { BenchmarkManager } from './manager.js';
import { findCatalogDataset, listCatalogDatasets } from './catalog.js';
import {
    BenchmarkDataError,
    type CatalogDatasetEntry,
    type DatasetSummary,
    type DownloadState,
    type ModelOption,
    type RunListItem,
    type RunRecord
} from './common.js';
import { Setting } from '../../utils/setting.js';
import { resolveModelReasoningEfforts, resolveModelVisionSupport } from '../../utils/model-context.js';
import { REASONING_EFFORT_STORAGE_VALUES } from '../../../common/reasoning-effort.js';
import { getPlatform } from '../../../platforms/base.js';
import { logger } from '../../utils/logger.js';
import { NotificationManager } from '../../utils/notificationmgr.js';
import { toErrorMessage } from '../../../common/utils/error.js';
import { openTaskInMainWindow } from '../../utils/system-notification.js';

const BenchmarkConfigSchema = z.object({
    enabled: z.boolean().default(true).describe('是否启用测评')
});

export class BenchmarkApplication extends BaseApplication {
    private manager: BenchmarkManager | null = null;
    private managerInit: Promise<void> | null = null;

    constructor() {
        super('benchmark');
    }

    getName(): string {
        return t('app.name');
    }

    static getConfigSchema(): z.ZodObject<any> {
        return BenchmarkConfigSchema;
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            { eventName: 'datasetsChanged', eventDescription: '测评集列表发生变化' },
            { eventName: 'downloadsChanged', eventDescription: '测评集下载进度发生变化' },
            { eventName: 'runsChanged', eventDescription: '测评运行状态发生变化' }
        ];
    }

    override async ensureLoaded(): Promise<void> {
        await this.ensureManager();
    }

    async beforeExit(): Promise<void> {
        this.manager = null;
        this.managerInit = null;
    }

    // ── 供渲染层调用（callMainWorld） ───────────────────────────────────────

    async listDatasets(): Promise<DatasetSummary[]> {
        return this.requireManager().listDatasets();
    }

    async importDataset(archivePath: string): Promise<DatasetSummary> {
        if (!archivePath || typeof archivePath !== 'string') {
            throw new BenchmarkDataError(t('error.operationFailed'));
        }
        return this.requireManager().importDataset(archivePath);
    }

    async deleteDataset(datasetId: string): Promise<void> {
        this.requireManager().deleteDataset(datasetId);
    }

    /** 测评集下载中心的可下载清单 */
    async listCatalogDatasets(): Promise<CatalogDatasetEntry[]> {
        return listCatalogDatasets();
    }

    /** 当前所有下载任务的状态（渲染层据此画进度条） */
    async listDownloads(): Promise<DownloadState[]> {
        return this.requireManager().listDownloads();
    }

    /**
     * 下载清单里的某个测评集。
     *
     * 下载在后台进行：进度通过 downloadsChanged 事件推动，完成后用通知中心告知用户，
     * 所以这里拿到任务已启动就返回，不阻塞渲染层。
     */
    async downloadDataset(catalogId: string): Promise<void> {
        const entry = findCatalogDataset(typeof catalogId === 'string' ? catalogId : '');
        if (!entry) {
            throw new BenchmarkDataError(t('error.catalogNotFound'));
        }
        const manager = this.requireManager();
        const notifications = NotificationManager.getInstance();
        void manager
            .downloadDataset(entry, { fetchImpl: (input, init) => getPlatform().fetch(input as string | URL, init) })
            .then((dataset) => {
                notifications.info(
                    this.getName(),
                    t('benchmark.download.notifyTitle'),
                    t('benchmark.download.notifySuccess', { name: dataset.name, version: dataset.version })
                );
            })
            .catch((error) => {
                notifications.error(
                    this.getName(),
                    t('benchmark.download.notifyTitle'),
                    t('benchmark.download.notifyFailed', { name: entry.name, message: toErrorMessage(error) })
                );
            });
    }

    async listRuns(): Promise<RunListItem[]> {
        return this.requireManager().listRuns();
    }

    async getRunDetail(runId: string): Promise<RunRecord | null> {
        return this.requireManager().getRun(runId);
    }

    async startRun(options: {
        datasetId: string;
        concurrency: number;
        runModel: string;
        verifyModel: string;
        runModelEffort?: string;
        verifyModelEffort?: string;
        runTimeoutSec?: number | null;
        verifyTimeoutSec?: number | null;
        tracks?: string[];
    }): Promise<string> {
        const concurrency = Number(options?.concurrency);
        if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 20) {
            throw new BenchmarkDataError(t('error.concurrencyInvalid'));
        }
        for (const alias of [options.runModel, options.verifyModel]) {
            if (!alias || !Setting.getInstance().getModelInstance(alias, 'chat')) {
                throw new BenchmarkDataError(t('error.modelNotFound', { model: alias || '' }));
            }
        }
        const tracks = Array.isArray(options.tracks)
            ? options.tracks.filter((item): item is string => typeof item === 'string')
            : undefined;
        const readEffort = (value: unknown): string => {
            const effort = typeof value === 'string' ? value : '';
            if (!REASONING_EFFORT_STORAGE_VALUES.includes(effort as never)) {
                throw new BenchmarkDataError(t('error.effortInvalid'));
            }
            return effort;
        };
        const readTimeout = (value: unknown): number | null => {
            if (value === null || value === undefined || value === '') return null;
            const timeout = Number(value);
            if (!Number.isFinite(timeout) || timeout < 30 || timeout > 86400) {
                throw new BenchmarkDataError(t('error.timeoutInvalid'));
            }
            return Math.round(timeout);
        };
        return this.requireManager().startRun({
            datasetId: options.datasetId,
            concurrency,
            runModel: options.runModel,
            verifyModel: options.verifyModel,
            runModelEffort: readEffort(options.runModelEffort),
            verifyModelEffort: readEffort(options.verifyModelEffort),
            runTimeoutSec: readTimeout(options.runTimeoutSec),
            verifyTimeoutSec: readTimeout(options.verifyTimeoutSec),
            tracks
        });
    }

    async stopRun(runId: string): Promise<void> {
        this.requireManager().stopRun(runId);
    }

    async deleteRun(runId: string): Promise<void> {
        this.requireManager().deleteRun(runId);
    }

    async listModels(): Promise<ModelOption[]> {
        const data = Setting.getInstance().getData();
        const models = data.models ?? [];
        return models
            .filter((model) => model.model_type === 'chat')
            .map((model) => ({
                alias: model.alias,
                model_name: model.model_name,
                provider_name: model.provider_name,
                isDefault: model.alias === data.default_model,
                vision: resolveModelVisionSupport(model) === true,
                defaultEffort: model.reasoning_effort ?? '',
                efforts: resolveModelReasoningEfforts(model) as string[]
            }));
    }

    /** 在 OpenDesk 主窗口打开某个任务（测评用例的执行/验证任务） */
    async openTask(taskId: string): Promise<void> {
        if (!taskId || typeof taskId !== 'string') return;
        openTaskInMainWindow(taskId);
    }

    /** 在原测评历史记录内原地重跑单个用例（其余用例结果保留），返回原运行 id */
    async rerunCase(runId: string, caseKey: string): Promise<string> {
        const manager = this.requireManager();
        const run = manager.getRun(runId);
        if (!run) {
            throw new BenchmarkDataError(t('error.runNotFound'));
        }
        if (!caseKey) {
            throw new BenchmarkDataError(t('error.operationFailed'));
        }
        const caseExists = run.cases.some((item) => item.key === caseKey);
        if (!caseExists) {
            throw new BenchmarkDataError(t('error.runNotFound'));
        }
        return manager.startRun({
            datasetId: run.datasetId,
            concurrency: 1,
            runModel: run.runModel,
            verifyModel: run.verifyModel,
            runModelEffort: run.runModelEffort ?? '',
            verifyModelEffort: run.verifyModelEffort ?? '',
            runTimeoutSec: run.runTimeoutSec ?? null,
            verifyTimeoutSec: run.verifyTimeoutSec ?? null,
            tracks: run.tracks,
            caseKeys: [caseKey],
            appendToRunId: runId
        });
    }

    async openUrl(url: string): Promise<void> {
        if (!url || typeof url !== 'string') return;
        // homepage 来自导入的测评集（不可信内容），只放行 http/https/mailto，
        // 不能把任意协议交给操作系统去处理
        let protocol: string;
        try {
            protocol = new URL(url.trim()).protocol;
        } catch {
            return;
        }
        if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'mailto:') return;
        await getPlatform().openExternal(url.trim());
    }

    async openRunDirectory(runId: string): Promise<void> {
        await getPlatform().openPath(this.requireManager().getRunDirectory(runId));
    }

    // ── 内部 ──────────────────────────────────────────────────────────────

    private requireManager(): BenchmarkManager {
        if (!this.manager) {
            throw new BenchmarkDataError(t('error.operationFailed'));
        }
        return this.manager;
    }

    private async ensureManager(): Promise<void> {
        if (this.manager) return;
        if (!this.managerInit) {
            this.managerInit = (async () => {
                const manager = new BenchmarkManager(this.getDataDirectory());
                manager.init();
                manager.onChange(() => {
                    void this.emitEvent('datasetsChanged').catch(() => undefined);
                    void this.emitEvent('runsChanged').catch(() => undefined);
                });
                // 下载进度单独一路：只让渲染层刷进度条，别触发整页重建
                manager.onDownloadChange(() => {
                    void this.emitEvent('downloadsChanged').catch(() => undefined);
                });
                this.manager = manager;
                logger.info(`[benchmark] data directory: ${this.getDataDirectory()}`);
            })().catch((error) => {
                this.managerInit = null;
                logger.error(`[benchmark] failed to initialize manager: ${toErrorMessage(error)}`);
                throw error;
            });
        }
        await this.managerInit;
    }
}
