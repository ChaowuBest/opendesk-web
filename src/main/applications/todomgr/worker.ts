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

import { BaseWorker } from "../base";
import { logger } from '../../utils/logger';
import { matchesCron } from '../../utils/cron';
import { parentPort } from 'worker_threads';
import path from 'path';
import fs from 'fs';
import type { GlobalTodo, GlobalTodoStorage, TodoTrigger } from './common';


export default class TodoMgrWorker extends BaseWorker {

    private globalTodosPath!: string;
    private globalTodos: GlobalTodo[] = [];
    private triggerCheckInterval?: ReturnType<typeof setInterval>;

    async initialize(): Promise<void> {
        logger.info('[todomgr] TodoMgrWorker 正在初始化...');
        const dataDir = this.appDataDirectory;

        // 全局待办存储路径
        this.globalTodosPath = path.join(dataDir, 'global_todos.json');

        // 加载数据
        await this.loadGlobalTodos();

        // 启动触发器检查循环
        this.startTriggerLoop();

        logger.info('[todomgr] TodoMgrWorker 初始化完成');
    }

    async finalize(): Promise<void> {
        if (this.triggerCheckInterval) {
            clearInterval(this.triggerCheckInterval);
            this.triggerCheckInterval = undefined;
        }
    }

    // ========== 持久化 ==========

    private async loadGlobalTodos(): Promise<void> {
        if (fs.existsSync(this.globalTodosPath)) {
            try {
                const raw = fs.readFileSync(this.globalTodosPath, 'utf-8');
                const storage: GlobalTodoStorage = JSON.parse(raw);
                this.globalTodos = storage.todos;
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
            last_updated: new Date().toISOString(),
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
        content: string,
        priority: 'low' | 'medium' | 'high' = 'medium',
        category?: string,
        trigger?: TodoTrigger
    ): Promise<GlobalTodo> {
        const todo: GlobalTodo = {
            id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            status: 'pending',
            priority,
            category,
            trigger,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        this.globalTodos.unshift(todo);
        await this.saveGlobalTodos();
        return todo;
    }

    async updateGlobalTodo(id: string, updates: Partial<GlobalTodo> & { removeTrigger?: boolean }): Promise<GlobalTodo> {
        const idx = this.globalTodos.findIndex(t => t.id === id);
        if (idx === -1) throw new Error(`GlobalTodo not found: ${id}`);

        const { removeTrigger, ...todoUpdates } = updates;

        this.globalTodos[idx] = {
            ...this.globalTodos[idx],
            ...todoUpdates,
            id,
            updated_at: new Date().toISOString(),
        };

        if (removeTrigger) {
            delete this.globalTodos[idx].trigger;
            delete this.globalTodos[idx].last_triggered_at;
        }

        // 如果状态变为 completed，记录完成时间
        if (todoUpdates.status === 'completed' && !this.globalTodos[idx].completed_at) {
            this.globalTodos[idx].completed_at = new Date().toISOString();
        }

        await this.saveGlobalTodos();
        return this.globalTodos[idx];
    }

    async listGlobalTodos(
        status?: 'pending' | 'in_progress' | 'completed' | 'all',
        category?: string,
        priority?: 'low' | 'medium' | 'high'
    ): Promise<GlobalTodo[]> {
        let result = [...this.globalTodos];

        if (status && status !== 'all') {
            result = result.filter(t => t.status === status);
        }
        if (category) {
            result = result.filter(t => t.category === category);
        }
        if (priority) {
            result = result.filter(t => t.priority === priority);
        }

        return result;
    }

    async getGlobalTodoById(id: string): Promise<GlobalTodo | undefined> {
        return this.globalTodos.find(t => t.id === id);
    }

    async deleteGlobalTodo(id: string): Promise<GlobalTodo> {
        const idx = this.globalTodos.findIndex(t => t.id === id);
        if (idx === -1) {
            throw new Error(`GlobalTodo not found: ${id}`);
        }
        const deleted = this.globalTodos.splice(idx, 1)[0];
        await this.saveGlobalTodos();
        return deleted;
    }

    // ========== 触发器机制 ==========

    private startTriggerLoop(): void {
        // 启动后延迟 5 秒执行首次检查（等待系统就绪）
        setTimeout(async () => {
            await this.checkTimerTriggers().catch(err => {
                logger.error('首次触发器检查失败:', err);
            });
            // 后续每 30 秒检查定时和重复触发器
            this.triggerCheckInterval = setInterval(() => {
                this.checkTimerTriggers().catch(err => {
                    logger.error('触发器检查失败:', err);
                });
            }, 30_000);
        }, 5_000);
    }

    private async checkTimerTriggers(): Promise<void> {
        const now = new Date();
        const nowTs = now.getTime();

        logger.info(`开始检查触发器，当前时间：${now.toISOString()} (ts: ${nowTs})`);

        for (const todo of this.globalTodos) {
            logger.info(JSON.stringify(todo));
            // 跳过没有触发器的待办
            if (!todo.trigger) continue;
            // 对于 scheduled 类型（一次性任务），已完成则跳过
            // 对于 cron 类型（周期任务），即使已完成也应继续触发
            if (todo.status === 'completed' && todo.trigger.type !== 'cron') continue;

            try {
                if (todo.trigger.type === 'scheduled') {
                    const triggerTime = new Date(todo.trigger.triggerAt);
                    const triggerTs = triggerTime.getTime();
                    const timeDiff = triggerTs - nowTs;

                    logger.info(`检查 scheduled 待办 [${todo.id}]: 触发时间=${todo.trigger.triggerAt}, 时间差=${timeDiff}ms, last_triggered_at=${todo.last_triggered_at}`);

                    // 只有当当前时间 >= 触发时间 且 尚未触发过时才执行
                    if (nowTs >= triggerTs && !todo.last_triggered_at) {
                        logger.info(`scheduled 触发器条件满足，准备触发待办 [${todo.id}]: ${todo.content}`);

                        // 统一在此处更新所有状态，避免 fireTrigger 内部保存导致的状态不一致
                        todo.last_triggered_at = now.toISOString();
                        todo.status = 'completed';
                        todo.completed_at = now.toISOString();
                        todo.updated_at = now.toISOString();

                        // 先保存状态
                        await this.saveGlobalTodos();

                        // 然后发送消息创建任务（即使任务创建失败，状态也已正确记录）
                        await this.fireTriggerWithoutSave(todo);

                        logger.info(`scheduled 触发器执行完成 [${todo.id}]`);
                    } else if (nowTs < triggerTs) {
                        logger.debug(`scheduled 触发器时间未到 [${todo.id}], 还需等待 ${timeDiff}ms`);
                    } else if (todo.last_triggered_at) {
                        logger.debug(`scheduled 触发器已触发过 [${todo.id}], last_triggered_at=${todo.last_triggered_at}`);
                    }
                } else if (todo.trigger.type === 'cron') {
                    if (matchesCron(todo.trigger.cronExpression, now)) {
                        // 避免同一分钟内重复触发
                        if (todo.last_triggered_at) {
                            const last = new Date(todo.last_triggered_at);
                            if (
                                last.getFullYear() === now.getFullYear() &&
                                last.getMonth() === now.getMonth() &&
                                last.getDate() === now.getDate() &&
                                last.getHours() === now.getHours() &&
                                last.getMinutes() === now.getMinutes()
                            ) {
                                logger.debug(`cron 触发器在同一分钟内已触发 [${todo.id}], 跳过`);
                                continue;
                            }
                        }
                        logger.info(`cron 触发器条件满足 [${todo.id}]: ${todo.content}`);
                        todo.last_triggered_at = now.toISOString();
                        todo.updated_at = now.toISOString();
                        await this.saveGlobalTodos();
                        await this.fireTriggerWithoutSave(todo);
                    }
                }
            } catch (err) {
                logger.error(`触发器执行失败 (todo: ${todo.id}):`, err);
            }
        }
    }

    /**
     * 处理来自其他应用的事件，检查是否有匹配的事件触发器
     */
    async handleApplicationEvent(sourceBundleName: string, eventName: string, _args: any[]): Promise<void> {
        for (const todo of this.globalTodos) {
            if (!todo.trigger) continue;
            if (todo.trigger.type !== 'event') continue;
            // event 类型触发器通常是一次性的，完成后不再触发
            if (todo.status === 'completed') continue;

            if (todo.trigger.bundleName === sourceBundleName && todo.trigger.eventName === eventName) {
                try {
                    await this.fireTrigger(todo);
                } catch (err) {
                    logger.error(`事件触发执行失败 (todo: ${todo.id}):`, err);
                }
            }
        }
    }

    private async fireTrigger(todo: GlobalTodo): Promise<void> {
        logger.info(`触发待办: ${todo.id} - ${todo.content}`);
        todo.last_triggered_at = new Date().toISOString();
        todo.updated_at = new Date().toISOString();
        await this.saveGlobalTodos();

        // 请求主进程创建并执行任务
        parentPort?.postMessage({
            type: 'triggerTodoTask',
            bundleName: this.bundleName,
            todoId: todo.id,
            todoContent: todo.content,
            trigger: todo.trigger,
        });
    }

    /**
     * 触发待办但不保存状态（因为状态已在调用前更新并保存）
     */
    private async fireTriggerWithoutSave(todo: GlobalTodo): Promise<void> {
        logger.info(`触发待办: ${todo.id} - ${todo.content}`);

        // 请求主进程创建并执行任务
        parentPort?.postMessage({
            type: 'triggerTodoTask',
            bundleName: this.bundleName,
            todoId: todo.id,
            todoContent: todo.content,
            trigger: todo.trigger,
        });
    }
}
