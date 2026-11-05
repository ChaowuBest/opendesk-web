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

import { BaseWorker } from '../base';
import { logger } from '../../utils/logger';
import { Cron } from 'croner';
import path from 'path';
import fs from 'fs';
import type { GlobalTodo, GlobalTodoStorage, TodoTrigger, TodoWorkspaceConfig } from './common';
import type { ReasoningEffort } from '../../aikernel/types/reasoning.js';
import type { Participant } from '../../aikernel/types/index.js';
import type { Cron as CronerJob } from 'croner';
import { getSystemTimezone, isValidTimezone } from './timezone.js';
import { getNextTodoRecurrenceRuns, getTodoRecurrenceError, matchesTodoRecurrence } from './todo-recurrence.js';
import { t } from './locale/index.js';
import { getRecurrenceValidationMessage } from './recurrence-validation.js';

function validateTriggerTimezone(trigger?: TodoTrigger): void {
    if (
        (trigger?.type === 'cron' || trigger?.type === 'scheduled') &&
        trigger.timezone !== undefined &&
        !isValidTimezone(trigger.timezone)
    ) {
        throw new Error(t('error.timezoneInvalid', { timezone: String(trigger.timezone) }));
    }
}

function validateTriggerRecurrence(trigger?: TodoTrigger): void {
    if (trigger?.type !== 'cron' || trigger.recurrence === undefined) return;
    const message = getRecurrenceValidationMessage(trigger.recurrence, t);
    if (message) throw new Error(message);
    if (getNextTodoRecurrenceRuns(trigger.recurrence, trigger.timezone ?? 'UTC', 1).length === 0)
        throw new Error(t('error.recurrenceNoNext'));
}

/**
 * Return a deterministic representation of a trigger's scheduling fields.
 * Recurrence selections are sets, so their order (or duplicate values) does not
 * change the schedule. Other object keys are sorted recursively to avoid
 * resetting a running job when an equivalent object was serialized differently.
 */
function stableScheduleString(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => stableScheduleString(item)).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, entry]) => entry !== undefined)
            .sort(([left], [right]) => left.localeCompare(right));
        return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableScheduleString(entry)}`).join(',')}}`;
    }
    return JSON.stringify(value);
}

function normalizeRecurrenceForComparison(recurrence: unknown): unknown {
    if (!recurrence || typeof recurrence !== 'object' || Array.isArray(recurrence)) return recurrence;
    const normalized = { ...(recurrence as Record<string, unknown>) };
    for (const key of ['weekdays', 'days', 'months']) {
        const values = normalized[key];
        if (Array.isArray(values))
            normalized[key] = [...new Set(values)].sort((left, right) => Number(left) - Number(right));
    }
    return normalized;
}

function getTriggerScheduleConfig(trigger?: TodoTrigger): string {
    if (!trigger) return '';
    switch (trigger.type) {
        case 'scheduled':
            // `timezone` is display-only for one-shot UTC timestamps.
            return stableScheduleString({ triggerAt: trigger.triggerAt || '' });
        case 'cron':
            return stableScheduleString(
                trigger.recurrence !== undefined
                    ? {
                          timezone: trigger.timezone ?? 'UTC',
                          recurrence: normalizeRecurrenceForComparison(trigger.recurrence)
                      }
                    : {
                          cronExpression: (trigger.cronExpression || '').trim().replace(/\s+/g, ' '),
                          timezone: trigger.timezone ?? 'UTC'
                      }
            );
        case 'event':
            return stableScheduleString({ bundleName: trigger.bundleName || '', eventName: trigger.eventName || '' });
        default:
            return '';
    }
}

export default class TodoMgrWorker extends BaseWorker {
    private globalTodosPath!: string;
    private globalTodos: GlobalTodo[] = [];

    // Croner 任务实例映射 (todoId -> CronerJob)
    private cronJobs: Map<string, CronerJob> = new Map();

    // scheduled 任务的定时检查器
    private scheduledCheckInterval?: ReturnType<typeof setInterval>;

    async initialize(): Promise<void> {
        logger.info('[todomgr] TodoMgrWorker 正在初始化...');
        const dataDir = this.appDataDirectory;

        // 全局待办存储路径
        this.globalTodosPath = path.join(dataDir, 'global_todos.json');

        // 加载数据
        await this.loadGlobalTodos();

        // 启动所有触发器
        this.startAllTriggers();

        logger.info('[todomgr] TodoMgrWorker 初始化完成');
    }

    async finalize(): Promise<void> {
        // 停止所有 cron 任务
        for (const [todoId, job] of this.cronJobs) {
            job.stop();
            logger.info(`[todomgr] 已停止 cron 任务: ${todoId}`);
        }
        this.cronJobs.clear();

        // 停止 scheduled 检查定时器
        if (this.scheduledCheckInterval) {
            clearInterval(this.scheduledCheckInterval);
            this.scheduledCheckInterval = undefined;
        }
    }

    // ========== 持久化 ==========

    private async loadGlobalTodos(): Promise<void> {
        if (fs.existsSync(this.globalTodosPath)) {
            try {
                const raw = fs.readFileSync(this.globalTodosPath, 'utf-8');
                const storage: GlobalTodoStorage = JSON.parse(raw);
                this.globalTodos = storage.todos;
                // 数据迁移：旧数据使用 status 字段，映射为 enabled
                for (const todo of this.globalTodos) {
                    if ((todo as any).status !== undefined && todo.enabled === undefined) {
                        todo.enabled = (todo as any).status !== 'completed';
                        delete (todo as any).status;
                    }
                }
                logger.info(`已加载 ${this.globalTodos.length} 个全局待办`);
            } catch (e) {
                logger.error('加载全局待办失败:', e);
                this.globalTodos = [];
            }
        } else {
            this.globalTodos = [];
        }
    }

    private async saveGlobalTodos(): Promise<void> {
        const storage: GlobalTodoStorage = {
            version: '1.1',
            todos: this.globalTodos,
            last_updated: new Date().toISOString()
        };

        const dir = path.dirname(this.globalTodosPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(this.globalTodosPath, JSON.stringify(storage, null, 2));

        // 通知界面刷新
        await this.emitEvent('globalTodosUpdated', this.globalTodos);
    }

    // ========== 全局待办操作 ==========

    async addGlobalTodo(
        title: string,
        content: string,
        priority: 'low' | 'medium' | 'high' = 'medium',
        category?: string,
        trigger?: TodoTrigger,
        deliver?: Participant,
        workspace?: TodoWorkspaceConfig | null,
        model?: string,
        reasoningEffort?: ReasoningEffort
    ): Promise<GlobalTodo> {
        validateTriggerTimezone(trigger);
        const normalizedTrigger =
            (trigger?.type === 'cron' || trigger?.type === 'scheduled') && trigger.timezone === undefined
                ? { ...trigger, timezone: getSystemTimezone() }
                : trigger;
        validateTriggerRecurrence(normalizedTrigger);
        const todo: GlobalTodo = {
            id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            title,
            content,
            priority,
            category,
            trigger: normalizedTrigger,
            deliver,
            // GlobalTodo.workspace 为可选字段；入参允许显式 null（表示"未设置"），此处归一成 undefined
            workspace: workspace ?? undefined,
            ...(model ? { model } : {}),
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            enabled: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        if (workspace) {
            todo.workspace = workspace;
        }
        this.globalTodos.unshift(todo);
        await this.saveGlobalTodos();

        // 如果有 cron 触发器，启动它
        if (todo.trigger?.type === 'cron') {
            this.startCronJob(todo);
        }

        return todo;
    }

    async updateGlobalTodo(
        id: string,
        updates: Partial<GlobalTodo> & {
            removeTrigger?: boolean;
            removeDeliver?: boolean;
            removeWorkspace?: boolean;
            removeModel?: boolean;
        }
    ): Promise<GlobalTodo> {
        const idx = this.globalTodos.findIndex((t) => t.id === id);
        if (idx === -1) throw new Error(`GlobalTodo not found: ${id}`);

        const { removeTrigger, removeDeliver, removeWorkspace, removeModel, ...rawUpdates } = updates;
        const clearWorkspace = rawUpdates.workspace === null;
        // 忽略 undefined 字段，避免 partial update 意外覆盖已有 trigger/deliver 等属性
        const todoUpdates: Partial<GlobalTodo> = {};
        for (const [key, value] of Object.entries(rawUpdates)) {
            if (key === 'workspace' && value === null) continue;
            if (value !== undefined) {
                (todoUpdates as Record<string, unknown>)[key] = value;
            }
        }

        const oldTrigger = this.globalTodos[idx].trigger;
        const oldEnabled = this.globalTodos[idx].enabled;
        if (!removeTrigger) {
            const trigger = todoUpdates.trigger;
            if ((trigger?.type === 'cron' || trigger?.type === 'scheduled') && trigger.timezone === undefined) {
                const timezone =
                    oldTrigger?.type === 'cron' || oldTrigger?.type === 'scheduled'
                        ? oldTrigger.timezone
                        : getSystemTimezone();
                if (timezone !== undefined) todoUpdates.trigger = { ...trigger, timezone };
            }
            validateTriggerTimezone(todoUpdates.trigger);
            validateTriggerRecurrence(todoUpdates.trigger);
        }

        logger.info(
            `[todomgr] updateGlobalTodo [${id}]: keys=${Object.keys(todoUpdates).join(',')}, hasTrigger=${'trigger' in todoUpdates}, removeTrigger=${removeTrigger}`
        );

        this.globalTodos[idx] = {
            ...this.globalTodos[idx],
            ...todoUpdates,
            id,
            updated_at: new Date().toISOString()
        };

        if (removeTrigger) {
            delete this.globalTodos[idx].trigger;
            delete this.globalTodos[idx].last_triggered_at;
        }
        if (removeDeliver || this.globalTodos[idx].deliver === null) {
            delete this.globalTodos[idx].deliver;
        }
        if (removeWorkspace || clearWorkspace) {
            delete this.globalTodos[idx].workspace;
        }
        if (removeModel) {
            delete this.globalTodos[idx].model;
        }

        // 检测触发器是否发生了变更。等价的 recurrence 选择（例如数组重排）不应
        // 清除执行标记，也不应重启 Croner 作业。
        const triggerUpdated = 'trigger' in todoUpdates && !removeTrigger;
        const oldType = oldTrigger?.type;
        const newTrigger = this.globalTodos[idx].trigger;
        const newType = newTrigger?.type;
        const oldScheduleConfig = getTriggerScheduleConfig(oldTrigger);
        const newScheduleConfig = getTriggerScheduleConfig(newTrigger);
        const triggerScheduleChanged = oldType !== newType || oldScheduleConfig !== newScheduleConfig;
        // enabled 恒为 boolean，`(x !== false)` 即 `x`，等价于新旧值不相等。
        const enabledChanged = 'enabled' in todoUpdates && oldEnabled !== this.globalTodos[idx].enabled;
        if (triggerUpdated) {
            if (triggerScheduleChanged) {
                logger.info(
                    `[todomgr] 触发器已变更 [${id}]: ${oldType}(${oldScheduleConfig}) -> ${newType}(${newScheduleConfig}), 重置触发状态`
                );
                delete this.globalTodos[idx].last_triggered_at;
                delete this.globalTodos[idx].completed_at;
                // 一次性触发器(scheduled/event)变更后始终重置为启用，确保能再次触发
                if (newType === 'scheduled' || newType === 'event') {
                    this.globalTodos[idx].enabled = true;
                }
            } else {
                logger.info(`[todomgr] 触发器配置未变 [${id}]: ${newType}(${newScheduleConfig})`);
            }
        }

        await this.saveGlobalTodos();

        // 处理触发器变更
        // 如果移除了触发器或触发器类型改变，停止旧的 cron 任务
        if (oldTrigger?.type === 'cron' && oldTrigger.type !== newTrigger?.type) {
            this.stopCronJob(id);
        }

        // 如果有 cron 触发器且已启用，重新启动；如果禁用，停止
        if (newTrigger?.type === 'cron') {
            if (this.globalTodos[idx].enabled === false) {
                this.stopCronJob(id);
            } else if (triggerScheduleChanged || enabledChanged) {
                this.startCronJob(this.globalTodos[idx]);
            }
        }

        // 触发器变更后，如果是 scheduled 类型，立即检查一次以确保新的时间生效
        if (triggerUpdated && triggerScheduleChanged && newTrigger?.type === 'scheduled') {
            const todo = this.globalTodos[idx];
            logger.info(
                `[todomgr] scheduled 触发器变更后立即检查 [${id}]: status=${todo.completed_at ? 'completed' : 'pending'}, last_triggered=${todo.last_triggered_at}, triggerAt=${(todo.trigger as any)?.triggerAt}`
            );
            setTimeout(() => {
                this.checkScheduledTriggers().catch((err) => {
                    logger.error('触发器变更后 scheduled 检查失败:', err);
                });
            }, 500);
        }

        return this.globalTodos[idx];
    }

    async listGlobalTodos(
        enabled?: 'enabled' | 'disabled' | 'all',
        category?: string,
        priority?: 'low' | 'medium' | 'high'
    ): Promise<GlobalTodo[]> {
        let result = [...this.globalTodos];

        if (enabled && enabled !== 'all') {
            result = result.filter((t) => (enabled === 'enabled' ? t.enabled !== false : t.enabled === false));
        }
        if (category) {
            result = result.filter((t) => t.category === category);
        }
        if (priority) {
            result = result.filter((t) => t.priority === priority);
        }

        return result;
    }

    async getGlobalTodoById(id: string): Promise<GlobalTodo | undefined> {
        return this.globalTodos.find((t) => t.id === id);
    }

    async deleteGlobalTodo(id: string): Promise<GlobalTodo> {
        const idx = this.globalTodos.findIndex((t) => t.id === id);
        if (idx === -1) {
            throw new Error(`GlobalTodo not found: ${id}`);
        }

        // 停止相关的 cron 任务
        this.stopCronJob(id);

        const deleted = this.globalTodos.splice(idx, 1)[0];
        await this.saveGlobalTodos();
        return deleted;
    }

    /**
     * 启动所有触发器
     */
    private startAllTriggers(): void {
        // 启动所有已启用的 cron 任务（cron 是周期性任务，不因 completed 状态而停止）
        for (const todo of this.globalTodos) {
            if (todo.trigger?.type === 'cron' && todo.enabled !== false) {
                this.startCronJob(todo);
            }
        }

        // 启动 scheduled 任务的定时检查（每 30 秒检查一次）
        this.scheduledCheckInterval = setInterval(() => {
            this.checkScheduledTriggers().catch((err) => {
                logger.error('scheduled 触发器检查失败:', err);
            });
        }, 30_000);

        // 延迟 5 秒后执行首次检查
        setTimeout(() => {
            this.checkScheduledTriggers().catch((err) => {
                logger.error('首次 scheduled 触发器检查失败:', err);
            });
        }, 5_000);
    }

    /**
     * 启动单个 cron 任务
     * 注意：cron 是周期性任务，不因 completed 状态而停止，只有手动删除或移除触发器才会停止
     */
    private startCronJob(todo: GlobalTodo): void {
        logger.info(`[todomgr] starting cron job ${todo.title}: ${todo.trigger}`);
        if (!todo.trigger || todo.trigger.type !== 'cron') return;

        // 如果已有该 todo 的 cron 任务，先停止
        this.stopCronJob(todo.id);

        try {
            const recurrence = todo.trigger.recurrence;
            if (recurrence !== undefined && getTodoRecurrenceError(recurrence)) {
                logger.error(`[todomgr] 无效周期规则 [${todo.id}]，跳过启动`);
                return;
            }
            // Retain the intended run across delayed wakes; a resumed job coalesces missed runs into one.
            let recurrenceSearchAfter = new Date();
            let nextRecurrenceRun = recurrence
                ? getNextTodoRecurrenceRuns(recurrence, todo.trigger.timezone ?? 'UTC', 1, recurrenceSearchAfter)[0]
                : undefined;
            // Calendar rules and elapsed intervals share a UTC minute wake;
            // selected timezone and cadence are checked before any state write.
            const cronExpression = recurrence ? '* * * * *' : todo.trigger.cronExpression;
            logger.info(`[todomgr] 启动 cron 任务 [${todo.id}]: ${cronExpression} - ${todo.content}`);

            const job = new Cron(
                cronExpression,
                { timezone: recurrence ? 'UTC' : (todo.trigger.timezone ?? 'UTC') },
                async () => {
                    // 重新获取最新的 todo 状态
                    const currentTodo = this.globalTodos.find((t) => t.id === todo.id);
                    if (!currentTodo) {
                        logger.info(`[todomgr] todo [${todo.id}] 不存在，跳过触发`);
                        return;
                    }
                    if (currentTodo.enabled === false) {
                        logger.info(`[todomgr] todo [${todo.id}] 已禁用，跳过触发`);
                        return;
                    }
                    const now = new Date();
                    if (currentTodo.trigger?.type !== 'cron') return;
                    if (currentTodo.trigger.recurrence !== undefined) {
                        const currentMinute = Math.floor(now.getTime() / 60_000) * 60_000;
                        const due = nextRecurrenceRun !== undefined && nextRecurrenceRun.getTime() <= now.getTime();
                        if (due) {
                            nextRecurrenceRun = getNextTodoRecurrenceRuns(
                                currentTodo.trigger.recurrence,
                                currentTodo.trigger.timezone ?? 'UTC',
                                1,
                                now
                            )[0];
                            recurrenceSearchAfter = now;
                        }
                        // The cached next run rules out later minutes before it. Keep
                        // matching in the search minute and after backward clock changes.
                        if (!due && nextRecurrenceRun && currentMinute > recurrenceSearchAfter.getTime()) return;
                        if (
                            !due &&
                            !matchesTodoRecurrence(
                                currentTodo.trigger.recurrence,
                                now,
                                currentTodo.trigger.timezone ?? 'UTC'
                            )
                        )
                            return;
                        // A duplicate wake or a clock rewind must not replay a saved run.
                        if (currentTodo.last_triggered_at && Date.parse(currentTodo.last_triggered_at) >= currentMinute)
                            return;
                    }
                    logger.info(`[todomgr] cron 触发 [${todo.id}]: ${currentTodo.content}`);
                    // 更新触发时间
                    currentTodo.last_triggered_at = now.toISOString();
                    currentTodo.updated_at = now.toISOString();
                    await this.saveGlobalTodos();

                    // 触发任务
                    await this.fireTriggerWithoutSave(currentTodo);
                }
            );

            this.cronJobs.set(todo.id, job);
            logger.info(`[todomgr] cron 任务已启动 [${todo.id}]`);
        } catch (err) {
            logger.error(`[todomgr] 启动 cron 任务失败 [${todo.id}]:`, err);
        }
    }

    /**
     * 停止单个 cron 任务
     */
    private stopCronJob(todoId: string): void {
        const job = this.cronJobs.get(todoId);
        if (job) {
            job.stop();
            this.cronJobs.delete(todoId);
            logger.info(`[todomgr] 已停止 cron 任务: ${todoId}`);
        }
    }

    /**
     * 检查 scheduled 类型的触发器（一次性定时任务）
     */
    private async checkScheduledTriggers(): Promise<void> {
        const now = new Date();
        const nowTs = now.getTime();

        for (const todo of this.globalTodos) {
            if (!todo.trigger) continue;
            if (todo.trigger.type !== 'scheduled') continue;

            if (todo.enabled === false) {
                logger.debug(`[todomgr] scheduled [${todo.id}] 已禁用，跳过`);
                continue;
            }
            if (todo.last_triggered_at) {
                logger.debug(
                    `[todomgr] scheduled [${todo.id}] 已触发过(last_triggered=${todo.last_triggered_at})，跳过`
                );
                continue;
            }

            try {
                const triggerTime = new Date(todo.trigger.triggerAt);
                const triggerTs = triggerTime.getTime();
                const timeDiff = triggerTs - nowTs;

                logger.info(
                    `[todomgr] 检查 scheduled 待办 [${todo.id}]: 触发时间=${todo.trigger.triggerAt}, 时间差=${timeDiff}ms`
                );

                // 只有当当前时间 >= 触发时间 且 尚未触发过时才执行
                if (nowTs >= triggerTs) {
                    logger.info(`[todomgr] scheduled 触发器条件满足，准备触发待办 [${todo.id}]: ${todo.content}`);

                    // 更新状态
                    todo.last_triggered_at = now.toISOString();
                    todo.enabled = false;
                    todo.completed_at = now.toISOString();
                    todo.updated_at = now.toISOString();

                    // 先保存状态
                    await this.saveGlobalTodos();

                    // 然后发送消息创建任务
                    await this.fireTriggerWithoutSave(todo);

                    logger.info(`[todomgr] scheduled 触发器执行完成 [${todo.id}]`);
                } else {
                    logger.debug(`[todomgr] scheduled 触发器时间未到 [${todo.id}], 还需等待 ${timeDiff}ms`);
                }
            } catch (err) {
                logger.error(`[todomgr] scheduled 触发器执行失败 (todo: ${todo.id}):`, err);
            }
        }
    }

    /**
     * 手动立即触发指定的全局待办
     */
    async triggerGlobalTodoNow(todoId: string): Promise<GlobalTodo> {
        const todo = this.globalTodos.find((t) => t.id === todoId);
        if (!todo) throw new Error(`GlobalTodo not found: ${todoId}`);
        await this.fireTrigger(todo);
        return todo;
    }

    /**
     * 处理来自其他应用的事件，检查是否有匹配的事件触发器
     */
    async handleApplicationEvent(sourceBundleName: string, eventName: string, _args: any[]): Promise<void> {
        for (const todo of this.globalTodos) {
            if (!todo.trigger) continue;
            if (todo.trigger.type !== 'event') continue;
            if (todo.enabled === false) continue;

            if (todo.trigger.bundleName === sourceBundleName && todo.trigger.eventName === eventName) {
                try {
                    await this.fireTrigger(todo);
                } catch (err) {
                    logger.error(`[todomgr] 事件触发执行失败 (todo: ${todo.id}):`, err);
                }
            }
        }
    }

    private async fireTrigger(todo: GlobalTodo): Promise<void> {
        logger.info(`[todomgr] 触发待办: ${todo.id} - ${todo.title}`);
        todo.last_triggered_at = new Date().toISOString();
        todo.updated_at = new Date().toISOString();
        await this.saveGlobalTodos();

        this.callApp(
            'triggerTodoTask',
            todo.id,
            todo.title,
            todo.content,
            todo.trigger,
            todo.deliver,
            todo.workspace,
            todo.model,
            todo.reasoningEffort
        );
    }

    /**
     * 触发待办但不保存状态（因为状态已在调用前更新并保存）
     */
    private async fireTriggerWithoutSave(todo: GlobalTodo): Promise<void> {
        logger.info(`[todomgr] 触发待办: ${todo.id} - ${todo.title}`);

        this.callApp(
            'triggerTodoTask',
            todo.id,
            todo.title,
            todo.content,
            todo.trigger,
            todo.deliver,
            todo.workspace,
            todo.model,
            todo.reasoningEffort
        );
    }
}
