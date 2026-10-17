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

import fs from 'fs';
import path from 'path';
import { getOpendeskDirectory } from '../utils/setting.js';
import { logger } from '../utils/logger.js';
import type { Usage, UsageFields } from '../aikernel/messages.js';

const USAGE_EVENT_VERSION = 1;
const USAGE_EVENTS_FILE_PREFIX = 'usage-events-';
const USAGE_EVENTS_FILE_SUFFIX = '.jsonl';
const LEGACY_USAGE_EVENTS_FILE = 'usage-events.jsonl';
const DEFAULT_TREND_DAYS = 30;
const DEFAULT_RANK_LIMIT = 10;
const USAGE_EVENTS_RETENTION_DAYS = 30;

export type UsageRequestType = 'completeText' | 'complete' | 'streamComplete';

export interface TokenUsageCounters {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
}

export interface TaskUsageSummary extends TokenUsageCounters {
    request_count: number;
    updated_at?: string;
}

export interface RecordTaskUsageInput {
    taskId: string;
    taskName?: string | null;
    parentId?: string | null;
    taskCreatedAt?: Date | string | null;
    model?: string;
    provider?: string;
    requestType?: UsageRequestType;
    turn?: number;
    usage: Usage | UsageFields;
    timestamp?: Date;
}

export interface UsageTelemetryEvent {
    version: typeof USAGE_EVENT_VERSION;
    id: string;
    timestamp: string;
    task_id: string;
    task_name?: string;
    parent_id?: string | null;
    task_created_at?: string;
    model?: string;
    provider?: string;
    request_type?: UsageRequestType;
    turn?: number;
    usage: TokenUsageCounters;
}

export interface UsagePeriodSummary {
    task_count: number;
    request_count: number;
    /** 输入 tokens 总量（含命中缓存与写入缓存的部分） */
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** 输入 tokens 中命中缓存的部分 */
    cache_read_input_tokens: number;
    /** 输入 tokens 中未命中缓存的部分（含写入缓存的部分） */
    cache_miss_input_tokens: number;
}

export interface UsageDailyTrendPoint {
    day: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** 输入中命中缓存的部分 */
    cache_read_input_tokens: number;
    /** 输入中未命中缓存的部分 */
    cache_miss_input_tokens: number;
}

export interface UsageTaskRankItem {
    task_id: string;
    task_name?: string;
    model?: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** 输入中命中缓存的部分 */
    cache_read_input_tokens: number;
    request_count: number;
    last_used_at: string;
}

export interface UsageModelRankItem {
    model: string;
    provider?: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** 输入中命中缓存的部分 */
    cache_read_input_tokens: number;
    request_count: number;
}

export interface UsageHourlyTrendPoint {
    hour: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    /** 输入中命中缓存的部分 */
    cache_read_input_tokens: number;
    /** 输入中未命中缓存的部分 */
    cache_miss_input_tokens: number;
}

export interface UsageDashboardSummary {
    today: UsagePeriodSummary;
    week: UsagePeriodSummary;
    daily_trend: UsageDailyTrendPoint[];
    hourly_trend: UsageHourlyTrendPoint[];
    month_top_tasks: UsageTaskRankItem[];
    month_top_models: UsageModelRankItem[];
    updated_at?: string;
}

export type RankPeriod = 'today' | 'week' | 'month';

interface SummarizeOptions {
    now?: Date;
    trendDays?: number;
    rankLimit?: number;
    rankPeriod?: RankPeriod;
}

let writeQueue: Promise<void> = Promise.resolve();
let lastCleanupDay: string | null = null;

function emptyCounters(): TokenUsageCounters {
    return {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
    };
}

function emptyPeriodSummary(): UsagePeriodSummary {
    return {
        task_count: 0,
        request_count: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
        cache_read_input_tokens: 0,
        cache_miss_input_tokens: 0
    };
}

function readTokenCount(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return undefined;
    }
    return Math.floor(value);
}

export function normalizeUsageCounters(
    rawUsage: Usage | UsageFields | undefined | null
): TokenUsageCounters | undefined {
    if (!rawUsage || typeof rawUsage !== 'object') {
        return undefined;
    }

    const candidate = rawUsage as UsageFields;
    const inputTokens = readTokenCount(candidate.input_tokens) ?? readTokenCount(candidate.prompt_tokens) ?? 0;
    const outputTokens = readTokenCount(candidate.output_tokens) ?? readTokenCount(candidate.completion_tokens) ?? 0;
    const promptTokens = readTokenCount(candidate.prompt_tokens) ?? inputTokens;
    const completionTokens = readTokenCount(candidate.completion_tokens) ?? outputTokens;
    const totalTokens = readTokenCount(candidate.total_tokens) ?? inputTokens + outputTokens;
    const cacheCreationInputTokens = readTokenCount(candidate.cache_creation_input_tokens) ?? 0;
    const cacheReadInputTokens = readTokenCount(candidate.cache_read_input_tokens) ?? 0;

    if (
        promptTokens === 0 &&
        completionTokens === 0 &&
        totalTokens === 0 &&
        inputTokens === 0 &&
        outputTokens === 0 &&
        cacheCreationInputTokens === 0 &&
        cacheReadInputTokens === 0
    ) {
        return undefined;
    }

    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: totalTokens,
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_creation_input_tokens: cacheCreationInputTokens,
        cache_read_input_tokens: cacheReadInputTokens
    };
}

export function addUsageCounters(left: TokenUsageCounters, right: TokenUsageCounters): TokenUsageCounters {
    return {
        prompt_tokens: left.prompt_tokens + right.prompt_tokens,
        completion_tokens: left.completion_tokens + right.completion_tokens,
        total_tokens: left.total_tokens + right.total_tokens,
        input_tokens: left.input_tokens + right.input_tokens,
        output_tokens: left.output_tokens + right.output_tokens,
        cache_creation_input_tokens: left.cache_creation_input_tokens + right.cache_creation_input_tokens,
        cache_read_input_tokens: left.cache_read_input_tokens + right.cache_read_input_tokens
    };
}

export function addUsageToTaskSummary(
    summary: TaskUsageSummary | undefined,
    usage: Usage | UsageFields,
    updatedAt: Date = new Date()
): TaskUsageSummary | undefined {
    const counters = normalizeUsageCounters(usage);
    if (!counters) {
        return summary;
    }

    const base: TaskUsageSummary = summary
        ? { ...summary }
        : {
              ...emptyCounters(),
              request_count: 0
          };
    const total = addUsageCounters(base, counters);
    return {
        ...total,
        request_count: base.request_count + 1,
        updated_at: updatedAt.toISOString()
    };
}

export function normalizeTaskUsageSummary(rawSummary: unknown): TaskUsageSummary | undefined {
    if (!rawSummary || typeof rawSummary !== 'object') {
        return undefined;
    }

    const counters = normalizeUsageCounters(rawSummary as UsageFields);
    if (!counters) {
        return undefined;
    }
    const candidate = rawSummary as Record<string, unknown>;
    const requestCount = readTokenCount(candidate.request_count) ?? 0;
    return {
        ...counters,
        request_count: requestCount,
        updated_at: typeof candidate.updated_at === 'string' ? candidate.updated_at : undefined
    };
}

export function getUsageTelemetryDirectory(): string {
    return path.join(getOpendeskDirectory(), 'telemetry');
}

function getUsageEventsPathForDate(date: Date): string {
    return path.join(
        getUsageTelemetryDirectory(),
        `${USAGE_EVENTS_FILE_PREFIX}${formatLocalDay(date)}${USAGE_EVENTS_FILE_SUFFIX}`
    );
}

function getLegacyUsageEventsPath(): string {
    return path.join(getUsageTelemetryDirectory(), LEGACY_USAGE_EVENTS_FILE);
}

function ensureUsageTelemetryDirectory(): void {
    fs.mkdirSync(getUsageTelemetryDirectory(), { recursive: true });
}

/** 删除超过保留天数的按天遥测文件，以及过期的旧版单文件 */
export function cleanupOldUsageEvents(
    retentionDays: number = USAGE_EVENTS_RETENTION_DAYS,
    now: Date = new Date()
): void {
    const dir = getUsageTelemetryDirectory();
    let files: string[];
    try {
        files = fs.readdirSync(dir);
    } catch {
        return;
    }
    const cutoff = addDays(startOfLocalDay(now), -retentionDays);
    for (const file of files) {
        const match = file.match(/^usage-events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
        if (match) {
            const fileDate = new Date(match[1] + 'T00:00:00');
            if (!Number.isNaN(fileDate.getTime()) && fileDate < cutoff) {
                try {
                    fs.unlinkSync(path.join(dir, file));
                } catch (error) {
                    logger.warn(`failed to delete old telemetry file ${file}: ${error}`);
                }
            }
            continue;
        }
        if (file === LEGACY_USAGE_EVENTS_FILE) {
            try {
                const stat = fs.statSync(path.join(dir, file));
                if (stat.mtime < cutoff) {
                    fs.unlinkSync(path.join(dir, file));
                }
            } catch {
                // ignore
            }
        }
    }
}

function formatLocalDay(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function formatLocalMonth(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

function startOfLocalDay(date: Date): Date {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date: Date, days: number): Date {
    const result = new Date(date.getTime());
    result.setDate(result.getDate() + days);
    return result;
}

function startOfWeek(date: Date): Date {
    const result = startOfLocalDay(date);
    const day = result.getDay();
    const daysSinceMonday = (day + 6) % 7;
    result.setDate(result.getDate() - daysSinceMonday);
    return result;
}

function normalizeDateString(value: Date | string | undefined | null): string | undefined {
    if (!value) {
        return undefined;
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
        return undefined;
    }
    return date.toISOString();
}

function parseEvent(raw: unknown): UsageTelemetryEvent | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const candidate = raw as Partial<UsageTelemetryEvent> & Record<string, unknown>;
    if (candidate.version !== USAGE_EVENT_VERSION || typeof candidate.task_id !== 'string') {
        return undefined;
    }
    if (typeof candidate.timestamp !== 'string' || Number.isNaN(new Date(candidate.timestamp).getTime())) {
        return undefined;
    }

    const usage = normalizeUsageCounters(candidate.usage as UsageFields);
    if (!usage) {
        return undefined;
    }

    return {
        version: USAGE_EVENT_VERSION,
        id: typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : crypto.randomUUID(),
        timestamp: candidate.timestamp,
        task_id: candidate.task_id,
        task_name: typeof candidate.task_name === 'string' ? candidate.task_name : undefined,
        parent_id:
            typeof candidate.parent_id === 'string' || candidate.parent_id === null ? candidate.parent_id : undefined,
        task_created_at: normalizeDateString(
            typeof candidate.task_created_at === 'string'
                ? candidate.task_created_at
                : typeof candidate.task_started_at === 'string'
                  ? candidate.task_started_at
                  : undefined
        ),
        model: typeof candidate.model === 'string' ? candidate.model : undefined,
        provider: typeof candidate.provider === 'string' ? candidate.provider : undefined,
        request_type:
            candidate.request_type === 'completeText' ||
            candidate.request_type === 'complete' ||
            candidate.request_type === 'streamComplete'
                ? candidate.request_type
                : undefined,
        turn:
            typeof candidate.turn === 'number' && Number.isFinite(candidate.turn)
                ? Math.floor(candidate.turn)
                : undefined,
        usage
    };
}

export async function recordTaskUsage(input: RecordTaskUsageInput): Promise<UsageTelemetryEvent | undefined> {
    const usage = normalizeUsageCounters(input.usage);
    if (!usage) {
        return undefined;
    }

    const timestamp = input.timestamp ?? new Date();
    const event: UsageTelemetryEvent = {
        version: USAGE_EVENT_VERSION,
        id: crypto.randomUUID(),
        timestamp: timestamp.toISOString(),
        task_id: input.taskId,
        task_name: input.taskName ?? undefined,
        parent_id: input.parentId ?? undefined,
        task_created_at: normalizeDateString(input.taskCreatedAt),
        model: input.model,
        provider: input.provider,
        request_type: input.requestType,
        turn: input.turn,
        usage
    };

    const todayKey = formatLocalDay(timestamp);
    writeQueue = writeQueue
        .catch(() => {
            // Keep the queue usable after a previous telemetry write failure.
        })
        .then(async () => {
            ensureUsageTelemetryDirectory();
            await fs.promises.appendFile(getUsageEventsPathForDate(timestamp), `${JSON.stringify(event)}\n`, 'utf8');
        });

    await writeQueue;

    // 每天最多触发一次清理
    if (lastCleanupDay !== todayKey) {
        lastCleanupDay = todayKey;
        try {
            cleanupOldUsageEvents();
        } catch (error) {
            logger.warn(`usage telemetry cleanup failed: ${error}`);
        }
    }

    return event;
}

async function readEventsFromFile(filePath: string): Promise<UsageTelemetryEvent[]> {
    let content: string;
    try {
        content = await fs.promises.readFile(filePath, 'utf8');
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }
    const events: UsageTelemetryEvent[] = [];
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }
        try {
            const event = parseEvent(JSON.parse(trimmed));
            if (event) {
                events.push(event);
            }
        } catch (error) {
            logger.warn(`skipping malformed usage telemetry event: ${error}`);
        }
    }
    return events;
}

export async function readUsageEvents(): Promise<UsageTelemetryEvent[]> {
    const dir = getUsageTelemetryDirectory();
    let files: string[];
    try {
        files = await fs.promises.readdir(dir);
    } catch (error: any) {
        if (error?.code === 'ENOENT') {
            return [];
        }
        throw error;
    }

    const dailyFiles = files.filter((f) => /^usage-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    const hasLegacy = files.includes(LEGACY_USAGE_EVENTS_FILE);

    const filePaths = [...dailyFiles.map((f) => path.join(dir, f)), ...(hasLegacy ? [getLegacyUsageEventsPath()] : [])];

    const results = await Promise.all(filePaths.map((fp) => readEventsFromFile(fp)));
    return results.flat();
}

function addToPeriod(period: UsagePeriodSummary, counters: TokenUsageCounters): void {
    period.request_count += 1;
    period.input_tokens += totalInputTokens(counters);
    period.output_tokens += counters.output_tokens;
    period.total_tokens += counters.total_tokens;
    period.cache_read_input_tokens += counters.cache_read_input_tokens;
    period.cache_miss_input_tokens += missInputTokens(counters);
}

/**
 * 汇总输入 tokens：usage.input_tokens 只统计未命中缓存的输入，命中与写入缓存需另行叠加。
 */
function totalInputTokens(counters: TokenUsageCounters): number {
    return counters.input_tokens + counters.cache_read_input_tokens + counters.cache_creation_input_tokens;
}

/**
 * 未命中缓存的输入 tokens：未命中输入与缓存写入共同构成输入中未被缓存命中的部分。
 */
function missInputTokens(counters: TokenUsageCounters): number {
    return counters.input_tokens + counters.cache_creation_input_tokens;
}

function updateTaskFirstSeen(
    taskFirstSeen: Map<string, { firstSeen: Date; taskName?: string }>,
    event: UsageTelemetryEvent,
    taskCreatedDate: Date
): void {
    const existing = taskFirstSeen.get(event.task_id);
    if (!existing || taskCreatedDate.getTime() < existing.firstSeen.getTime()) {
        taskFirstSeen.set(event.task_id, {
            firstSeen: taskCreatedDate,
            taskName: event.task_name || existing?.taskName
        });
        return;
    }
    if (event.task_name && !existing.taskName) {
        existing.taskName = event.task_name;
    }
}

export function summarizeUsageEvents(
    events: readonly UsageTelemetryEvent[],
    options: SummarizeOptions = {}
): UsageDashboardSummary {
    const now = options.now ?? new Date();
    const todayStart = startOfLocalDay(now);
    const tomorrowStart = addDays(todayStart, 1);
    const weekStart = startOfWeek(now);
    const currentMonth = formatLocalMonth(now);
    const trendDays = Math.max(1, Math.floor(options.trendDays ?? DEFAULT_TREND_DAYS));
    const rankLimit = Math.max(1, Math.floor(options.rankLimit ?? DEFAULT_RANK_LIMIT));
    const rankPeriod = options.rankPeriod ?? 'month';

    function isInRankPeriod(eventDate: Date): boolean {
        switch (rankPeriod) {
            case 'today':
                return eventDate >= todayStart && eventDate < tomorrowStart;
            case 'week':
                return eventDate >= weekStart && eventDate < tomorrowStart;
            case 'month':
            default:
                return formatLocalMonth(eventDate) === currentMonth;
        }
    }
    const today = emptyPeriodSummary();
    const week = emptyPeriodSummary();
    const dayTotals = new Map<string, TokenUsageCounters>();
    const taskFirstSeen = new Map<string, { firstSeen: Date; taskName?: string }>();
    const monthTasks = new Map<string, UsageTaskRankItem>();
    const monthModels = new Map<string, UsageModelRankItem>();
    const taskModelCounts = new Map<string, Map<string, number>>();
    const taskProviderCounts = new Map<string, Map<string, number>>();
    const modelProviderCounts = new Map<string, Map<string, number>>();
    const hourTotals: TokenUsageCounters[] = Array.from({ length: 24 }, () => emptyCounters());
    let updatedAt: string | undefined;

    for (const event of events) {
        const eventDate = new Date(event.timestamp);
        if (Number.isNaN(eventDate.getTime())) {
            continue;
        }

        const taskCreatedDate = event.task_created_at ? new Date(event.task_created_at) : eventDate;
        updateTaskFirstSeen(
            taskFirstSeen,
            event,
            Number.isNaN(taskCreatedDate.getTime()) ? eventDate : taskCreatedDate
        );
        if (!updatedAt || eventDate.getTime() > new Date(updatedAt).getTime()) {
            updatedAt = event.timestamp;
        }

        const dayKey = formatLocalDay(eventDate);
        dayTotals.set(dayKey, addUsageCounters(dayTotals.get(dayKey) ?? emptyCounters(), event.usage));

        if (eventDate >= todayStart && eventDate < tomorrowStart) {
            addToPeriod(today, event.usage);
            const hour = eventDate.getHours();
            hourTotals[hour] = addUsageCounters(hourTotals[hour], event.usage);
        }
        if (eventDate >= weekStart && eventDate < tomorrowStart) {
            addToPeriod(week, event.usage);
        }

        if (isInRankPeriod(eventDate)) {
            const existingTask =
                monthTasks.get(event.task_id) ??
                ({
                    task_id: event.task_id,
                    task_name: event.task_name,
                    input_tokens: 0,
                    output_tokens: 0,
                    total_tokens: 0,
                    cache_read_input_tokens: 0,
                    request_count: 0,
                    last_used_at: event.timestamp
                } satisfies UsageTaskRankItem);
            existingTask.task_name = event.task_name || existingTask.task_name;
            existingTask.input_tokens += totalInputTokens(event.usage);
            existingTask.output_tokens += event.usage.output_tokens;
            existingTask.total_tokens += event.usage.total_tokens;
            existingTask.cache_read_input_tokens += event.usage.cache_read_input_tokens;
            existingTask.request_count += 1;
            if (eventDate.getTime() > new Date(existingTask.last_used_at).getTime()) {
                existingTask.last_used_at = event.timestamp;
            }
            monthTasks.set(event.task_id, existingTask);

            if (event.model) {
                const tmc = taskModelCounts.get(event.task_id) ?? new Map();
                tmc.set(event.model, (tmc.get(event.model) ?? 0) + 1);
                taskModelCounts.set(event.task_id, tmc);
            }
            if (event.provider) {
                const tpc = taskProviderCounts.get(event.task_id) ?? new Map();
                tpc.set(event.provider, (tpc.get(event.provider) ?? 0) + 1);
                taskProviderCounts.set(event.task_id, tpc);
            }

            const modelKey = event.model || 'unknown';
            const existingModel = monthModels.get(modelKey);
            if (existingModel) {
                existingModel.input_tokens += totalInputTokens(event.usage);
                existingModel.output_tokens += event.usage.output_tokens;
                existingModel.total_tokens += event.usage.total_tokens;
                existingModel.cache_read_input_tokens += event.usage.cache_read_input_tokens;
                existingModel.request_count += 1;
            } else {
                monthModels.set(modelKey, {
                    model: modelKey,
                    input_tokens: totalInputTokens(event.usage),
                    output_tokens: event.usage.output_tokens,
                    total_tokens: event.usage.total_tokens,
                    cache_read_input_tokens: event.usage.cache_read_input_tokens,
                    request_count: 1
                });
            }
            if (event.provider) {
                const mpc = modelProviderCounts.get(modelKey) ?? new Map();
                mpc.set(event.provider, (mpc.get(event.provider) ?? 0) + 1);
                modelProviderCounts.set(modelKey, mpc);
            }
        }
    }

    // Assign most-used model/provider to task rank items
    for (const [taskId, task] of monthTasks) {
        const modelCounts = taskModelCounts.get(taskId);
        if (modelCounts && modelCounts.size > 0) {
            task.model = [...modelCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
        const providerCounts = taskProviderCounts.get(taskId);
        if (providerCounts && providerCounts.size > 0) {
            task.provider = [...providerCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
    }

    // Assign most-used provider to model rank items
    for (const [modelKey, modelItem] of monthModels) {
        const providerCounts = modelProviderCounts.get(modelKey);
        if (providerCounts && providerCounts.size > 0) {
            modelItem.provider = [...providerCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
        }
    }

    for (const [taskId, taskInfo] of taskFirstSeen) {
        const firstSeen = taskInfo.firstSeen;
        if (firstSeen >= todayStart && firstSeen < tomorrowStart) {
            today.task_count += 1;
        }
        if (firstSeen >= weekStart && firstSeen < tomorrowStart) {
            week.task_count += 1;
        }
        const monthTask = monthTasks.get(taskId);
        if (monthTask && taskInfo.taskName && !monthTask.task_name) {
            monthTask.task_name = taskInfo.taskName;
        }
    }

    const firstTrendDay = addDays(todayStart, -(trendDays - 1));
    const dailyTrend: UsageDailyTrendPoint[] = [];
    for (let i = 0; i < trendDays; i++) {
        const day = addDays(firstTrendDay, i);
        const dayKey = formatLocalDay(day);
        const counters = dayTotals.get(dayKey) ?? emptyCounters();
        dailyTrend.push({
            day: dayKey,
            input_tokens: totalInputTokens(counters),
            output_tokens: counters.output_tokens,
            total_tokens: counters.total_tokens,
            cache_read_input_tokens: counters.cache_read_input_tokens,
            cache_miss_input_tokens: missInputTokens(counters)
        });
    }

    const hourlyTrend: UsageHourlyTrendPoint[] = hourTotals.map((counters, hour) => ({
        hour: `${String(hour).padStart(2, '0')}:00`,
        input_tokens: totalInputTokens(counters),
        output_tokens: counters.output_tokens,
        total_tokens: counters.total_tokens,
        cache_read_input_tokens: counters.cache_read_input_tokens,
        cache_miss_input_tokens: missInputTokens(counters)
    }));

    return {
        today,
        week,
        daily_trend: dailyTrend,
        hourly_trend: hourlyTrend,
        month_top_tasks: [...monthTasks.values()]
            .sort((left, right) => right.total_tokens - left.total_tokens || right.request_count - left.request_count)
            .slice(0, rankLimit),
        month_top_models: [...monthModels.values()]
            .sort((left, right) => right.total_tokens - left.total_tokens || right.request_count - left.request_count)
            .slice(0, rankLimit),
        updated_at: updatedAt
    };
}

export interface UsageRankings {
    tasks: UsageTaskRankItem[];
    models: UsageModelRankItem[];
}

export async function getUsageRankings(rankPeriod: RankPeriod = 'month', rankLimit = 10): Promise<UsageRankings> {
    const events = await readUsageEvents();
    const summary = summarizeUsageEvents(events, { rankPeriod, rankLimit });
    return {
        tasks: summary.month_top_tasks,
        models: summary.month_top_models
    };
}

export async function getUsageDashboardSummary(options: SummarizeOptions = {}): Promise<UsageDashboardSummary> {
    const events = await readUsageEvents();
    return summarizeUsageEvents(events, options);
}
