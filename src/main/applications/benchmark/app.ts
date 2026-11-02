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
import { getLocale } from '../../../locale/index.js';
import { BenchmarkManager } from './manager.js';
import {
    createBenchmarkRegistries,
    resolveBenchmarkRegistryDisplayName,
    type BaseBenchmarkRegistry
} from './registry/index.js';
import {
    BenchmarkDataError,
    type BenchmarkSummary,
    type InstalledBenchmarkSummary,
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

/** 平台 fetch 只接受字符串/URL，把 Request 对象也归一化掉，免得被当成 "[object Request]" */
function toPlatformFetchInput(input: RequestInfo | URL): string | URL {
    if (typeof input === 'string' || input instanceof URL) return input;
    return input.url;
}

export class BenchmarkApplication extends BaseApplication {
    private manager: BenchmarkManager | null = null;
    private managerInit: Promise<void> | null = null;
    /** 当前生效的 registry 列表，每个 registry 在界面上占一个 Tab */
    private registries: BaseBenchmarkRegistry[] = [];

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
        this.registries = [];
    }

    // ── 供渲染层调用（callMainWorld） ───────────────────────────────────────

    async listDatasets(): Promise<InstalledBenchmarkSummary[]> {
        return this.requireManager().listDatasets();
    }

    async importDataset(archivePath: string): Promise<InstalledBenchmarkSummary> {
        if (!archivePath || typeof archivePath !== 'string') {
            throw new BenchmarkDataError(t('error.operationFailed'));
        }
        return this.requireManager().importDataset(archivePath);
    }

    async deleteDataset(datasetId: string): Promise<void> {
        this.requireManager().deleteDataset(datasetId);
    }

    /** 当前启用哪些测评集 registry（每个 registry 在界面上占一个 Tab） */
    async listBenchmarkRegistries(): Promise<{ name: string; displayName: string }[]> {
        await this.ensureManager();
        const locale = getLocale();
        return this.registries.map((registry) => ({
            name: registry.name,
            displayName: resolveBenchmarkRegistryDisplayName(registry.displayName, locale)
        }));
    }

    /** 某个 registry 收录了多少个测评集 */
    async getBenchmarkCount(registryName: string): Promise<number> {
        await this.ensureManager();
        return this.requireRegistry(registryName).getBenchmarkCount();
    }

    /**
     * 某个 registry 的可下载清单（清单有 5 分钟缓存，`forceRefresh` 强制重新拉取）。
     */
    async listCatalogDatasets(registryName: string, forceRefresh?: boolean): Promise<BenchmarkSummary[]> {
        await this.ensureManager();
        const registry = this.requireRegistry(registryName);
        if (forceRefresh === true) registry.invalidate?.();
        return registry.getCatalog();
    }

    /** 当前所有下载任务的状态（渲染层据此画进度条） */
    async listDownloads(): Promise<DownloadState[]> {
        return this.requireManager().listDownloads();
    }

    /**
     * 下载某个 registry 清单里的某个测评集。
     *
     * 下载在后台进行：进度通过 downloadsChanged 事件推动，完成后用通知中心告知用户，
     * 所以这里拿到任务已启动就返回，不阻塞渲染层。
     */
    async downloadDataset(registryName: string, catalogId: string): Promise<void> {
        await this.ensureManager();
        const registry = this.requireRegistry(registryName);
        const id = typeof catalogId === 'string' ? catalogId : '';
        const entry = (await registry.getCatalog()).find((item) => item.id === id);
        if (!entry) {
            throw new BenchmarkDataError(t('error.catalogNotFound'));
        }
        const manager = this.requireManager();
        const notifications = NotificationManager.getInstance();
        void manager
            .downloadDataset(entry, {
                registryName: registry.name,
                fetchImpl: (input, init) => getPlatform().fetch(toPlatformFetchInput(input), init)
            })
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

    private requireRegistry(registryName: string): BaseBenchmarkRegistry {
        const name = typeof registryName === 'string' ? registryName.trim() : '';
        const registry = this.registries.find((item) => item.name === name);
        if (!registry) {
            throw new BenchmarkDataError(t('error.registryUnknown', { name: name || '' }));
        }
        return registry;
    }

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
                // 清单请求走平台 fetch，以继承代理配置（本地调试仍可由环境变量指向本地文件）
                this.registries = createBenchmarkRegistries({
                    dataDirectory: this.getDataDirectory(),
                    fetchImpl: (input, init) => getPlatform().fetch(toPlatformFetchInput(input), init)
                });
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
