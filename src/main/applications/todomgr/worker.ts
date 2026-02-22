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
import path from 'path';
import fs from 'fs';
import type { GlobalTodo, GlobalTodoStorage } from './common';

export default class TodoMgrWorker extends BaseWorker {

    private globalTodosPath!: string;
    private globalTodos: GlobalTodo[] = [];

    async initialize(): Promise<void> {
        logger.info('TodoMgrWorker 正在初始化...');
        const dataDir = this.appDataDirectory;

        // 全局待办存储路径
        this.globalTodosPath = path.join(dataDir, 'global_todos.json');

        // 加载数据
        await this.loadGlobalTodos();

        logger.info('TodoMgrWorker 初始化完成');
    }

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
            version: '1.0',
            todos: this.globalTodos,
            last_updated: new Date().toISOString(),
        };

        fs.writeFileSync(this.globalTodosPath, JSON.stringify(storage, null, 2));

        // 通知界面刷新
        await this.emitEvent('globalTodosUpdated', this.globalTodos);
    }

    // ========== 全局待办操作 ==========

    async addGlobalTodo(content: string, priority: 'low' | 'medium' | 'high' = 'medium', category?: string): Promise<GlobalTodo> {
        const todo: GlobalTodo = {
            id: `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            status: 'pending',
            priority,
            category,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
        };
        this.globalTodos.unshift(todo);
        await this.saveGlobalTodos();
        return todo;
    }

    async updateGlobalTodo(id: string, updates: Partial<GlobalTodo>): Promise<GlobalTodo> {
        const idx = this.globalTodos.findIndex(t => t.id === id);
        if (idx === -1) throw new Error(`GlobalTodo not found: ${id}`);

        this.globalTodos[idx] = {
            ...this.globalTodos[idx],
            ...updates,
            id,
            updated_at: new Date().toISOString(),
        };

        // 如果状态变为 completed，记录完成时间
        if (updates.status === 'completed' && !this.globalTodos[idx].completed_at) {
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
}
