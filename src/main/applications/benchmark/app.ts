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
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { BaseApplication, type EventDecl } from '../base.js';
import { t } from './locale/index.js';
import { getLocale } from '../../../locale/index.js';
import { BenchmarkManager } from './manager.js';
import {
    createBenchmarkRegistries,
    customChannelCacheFile,
    OFFICIAL_REGISTRY_DISPLAY_NAME,
    resolveBenchmarkRegistryDisplayName,
    type BaseBenchmarkRegistry
} from './registry/index.js';
import {
    assertChannelNameAvailable,
    assertChannelUrlAvailable,
    fetchChannelCatalog,
    MAX_BENCHMARK_CHANNELS,
    normalizeBenchmarkChannels,
    normalizeChannelName,
    normalizeChannelUrl,
    OFFICIAL_CHANNEL_ID,
    type BenchmarkChannel,
    type BenchmarkChannelView
} from './channels.js';
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

/** 单个测评集渠道的配置形状；系统默认渠道只有 isEnabled 会被采用 */
const BenchmarkChannelSchema = z.object({
    id: z.string().default(''),
    name: z.string().default(''),
    url: z.string().default(''),
    isEnabled: z.boolean().default(true)
});

export const BenchmarkConfigSchema = z.object({
    enabled: z.boolean().default(true).describe('是否启用测评'),
    channels: z.array(BenchmarkChannelSchema).default([]).describe('测评集渠道')
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
            { eventName: 'runsChanged', eventDescription: '测评运行状态发生变化' },
            { eventName: 'registriesChanged', eventDescription: '测评集渠道（registry）发生变化' }
        ];
    }

    override async ensureLoaded(): Promise<void> {
        await this.ensureManager();
    }

    /**
     * 渠道配置变更（新增 / 删除 / 改名 / 启停）后重建 registry 列表，并通知已打开的
     * 测评应用刷新 Tab。
     *
     * 由 Setting.setData 触发（见 commitChannels），所以这里拿到的一定是最新配置。
     */
    onConfigChanged(): void {
        super.onConfigChanged();
        if (this.manager) {
            this.registries = this.createRegistries();
        }
        void this.emitEvent('registriesChanged').catch(() => undefined);
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

    /** 重扫已结束轮次的磁盘占用并写回记录（手动刷新入口），返回写回了几轮 */
    async rescanRunUsage(): Promise<number> {
        return this.requireManager().rescanRunUsage();
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

    // ── 测评集渠道（设置界面 → 渠道设置） ───────────────────────────────────

    /** 全部渠道（含已禁用的），系统默认渠道排第一 */
    async listBenchmarkChannels(): Promise<BenchmarkChannelView[]> {
        return this.resolveChannels().map((channel) => this.toChannelView(channel));
    }

    /**
     * 新增渠道：先校验输入、再联网验证清单确实可解析，最后才落配置。
     *
     * 验证放在主进程（而不是设置界面）里做，是为了保证「配置里存在的渠道一定验证过」，
     * 并且能复用主进程的代理设置。
     *
     * @returns 变更后的完整渠道列表，便于界面就地重绘
     */
    async addBenchmarkChannel(input: { name?: unknown; url?: unknown }): Promise<BenchmarkChannelView[]> {
        const name = normalizeChannelName(input?.name);
        const url = normalizeChannelUrl(input?.url);
        // 联网校验最长要等十几秒（见 CHANNEL_VERIFY_TIMEOUT_MS），期间配置可能已被别的窗口改过。
        // 先校验一次是为了把明显的错误立刻回给用户，校验后再按最新配置校验一遍才落盘。
        this.assertChannelAddable(this.resolveChannels(), name, url);
        await fetchChannelCatalog(url, { fetchImpl: this.platformFetch() });

        const channels = this.resolveChannels();
        this.assertChannelAddable(channels, name, url);
        const next: BenchmarkChannel[] = [...channels, { id: `channel-${randomUUID()}`, name, url, isEnabled: true }];
        this.commitChannels(next);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 编辑渠道：同样先联网验证；系统默认渠道不可编辑 */
    async updateBenchmarkChannel(
        id: string,
        input: { name?: unknown; url?: unknown }
    ): Promise<BenchmarkChannelView[]> {
        const name = normalizeChannelName(input?.name);
        const url = normalizeChannelUrl(input?.url);
        const before = this.resolveChannels();
        this.requireEditableChannel(before, id);
        this.assertChannelFree(before, name, url, id);
        await fetchChannelCatalog(url, { fetchImpl: this.platformFetch() });

        // 同样按最新配置重来一遍：验证期间这条渠道可能已经被删除
        const channels = this.resolveChannels();
        const target = this.requireEditableChannel(channels, id);
        this.assertChannelFree(channels, name, url, id);
        const next = channels.map((channel) => (channel.id === target.id ? { ...channel, name, url } : channel));
        this.commitChannels(next);
        // 地址变了：旧地址的清单缓存不会再被用到，顺手删掉，别在数据目录里越堆越多
        if (url !== target.url) this.dropChannelCache(target);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 删除渠道；系统默认渠道不可删除 */
    async deleteBenchmarkChannel(id: string): Promise<BenchmarkChannelView[]> {
        const channels = this.resolveChannels();
        const target = this.requireEditableChannel(channels, id);
        const next = channels.filter((channel) => channel.id !== target.id);
        this.commitChannels(next);
        this.dropChannelCache(target);
        return next.map((channel) => this.toChannelView(channel));
    }

    /** 启用 / 禁用渠道：系统默认渠道也允许禁用 */
    async setBenchmarkChannelEnabled(id: string, isEnabled: boolean): Promise<void> {
        const channels = this.resolveChannels();
        if (!channels.some((channel) => channel.id === id)) {
            throw new BenchmarkDataError(t('error.channelNotFound'));
        }
        const enabled = isEnabled === true;
        const next = channels.map((channel) => (channel.id === id ? { ...channel, isEnabled: enabled } : channel));
        this.commitChannels(next);
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
                fetchImpl: this.platformFetch()
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

    /** 按当前配置解析出渠道列表（系统默认渠道 + 用户渠道） */
    private resolveChannels(): BenchmarkChannel[] {
        const config = this.getConfig() as { channels?: unknown } | undefined;
        return normalizeBenchmarkChannels(config?.channels);
    }

    /** 系统默认渠道按当前语言取显示名 */
    private officialChannelName(): string {
        return resolveBenchmarkRegistryDisplayName(OFFICIAL_REGISTRY_DISPLAY_NAME, getLocale());
    }

    private toChannelView(channel: BenchmarkChannel): BenchmarkChannelView {
        const isDefault = channel.id === OFFICIAL_CHANNEL_ID;
        return {
            id: channel.id,
            name: isDefault ? this.officialChannelName() : channel.name,
            url: channel.url,
            isEnabled: channel.isEnabled,
            isDefault
        };
    }

    /** 取一个可以改/删的渠道（系统默认渠道只能启停）；不存在或不可改时抛错 */
    private requireEditableChannel(channels: readonly BenchmarkChannel[], id: string): BenchmarkChannel {
        const target = channels.find((channel) => channel.id === id);
        if (!target) {
            throw new BenchmarkDataError(t('error.channelNotFound'));
        }
        if (target.id === OFFICIAL_CHANNEL_ID) {
            throw new BenchmarkDataError(t('error.channelDefaultReadonly'));
        }
        return target;
    }

    /** 名字与地址没有和别的渠道撞车；`exceptId` 是正在编辑的那条，允许保留自身取值 */
    private assertChannelFree(
        channels: readonly BenchmarkChannel[],
        name: string,
        url: string,
        exceptId?: string
    ): void {
        assertChannelNameAvailable(channels, name, this.officialChannelName(), exceptId);
        assertChannelUrlAvailable(channels, url, exceptId);
    }

    /** 新增渠道的写前校验：自定义渠道数量没超限，且名字与地址不与他人冲突 */
    private assertChannelAddable(channels: readonly BenchmarkChannel[], name: string, url: string): void {
        const customCount = channels.filter((channel) => channel.id !== OFFICIAL_CHANNEL_ID).length;
        if (customCount >= MAX_BENCHMARK_CHANNELS) {
            throw new BenchmarkDataError(t('error.channelLimit', { count: MAX_BENCHMARK_CHANNELS }));
        }
        this.assertChannelFree(channels, name, url);
    }

    /** 请求实现：走平台 fetch 以继承代理设置 */
    private platformFetch(): typeof fetch {
        return (input, init) => getPlatform().fetch(toPlatformFetchInput(input), init);
    }

    /**
     * 把渠道列表写回应用配置。
     *
     * 走 Setting.setData（而不是 BaseApplication.setConfig）是必须的：只有 setData 会
     * 比对新旧应用配置并触发 onConfigChanged，registry 列表与界面 Tab 才能立刻跟着变。
     * 深拷贝则是为了避免「改的就是当前配置对象」导致比对失效（同 agentgate 的处理）。
     */
    private commitChannels(channels: BenchmarkChannel[]): void {
        const setting = Setting.getInstance();
        const data = JSON.parse(JSON.stringify(setting.getData())) as {
            applications?: Record<string, unknown>;
        };
        const applications = { ...(data.applications ?? {}) };
        applications[this.bundleName] = {
            ...((applications[this.bundleName] as Record<string, unknown> | undefined) ?? {}),
            channels
        };
        data.applications = applications;
        setting.setData(data);
    }

    private createRegistries(): BaseBenchmarkRegistry[] {
        const config = this.getConfig() as { channels?: unknown } | undefined;
        return createBenchmarkRegistries({
            dataDirectory: this.getDataDirectory(),
            channels: config?.channels,
            fetchImpl: this.platformFetch()
        });
    }

    /** 删掉某个渠道（旧地址）的清单缓存文件；失败只记日志，不影响渠道配置本身 */
    private dropChannelCache(channel: BenchmarkChannel): void {
        if (channel.id === OFFICIAL_CHANNEL_ID) return;
        const cacheFile = customChannelCacheFile(this.getDataDirectory(), channel.id, channel.url);
        try {
            fs.rmSync(cacheFile, { force: true });
        } catch (error) {
            logger.warn(`[benchmark] failed to remove catalog cache ${cacheFile}: ${toErrorMessage(error)}`);
        }
    }

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
                this.registries = this.createRegistries();
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
