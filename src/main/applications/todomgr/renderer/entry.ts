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

import { AgentOperableHTMLElement } from '../../widget_utils.js';

class TodoMgrEntryWidget extends AgentOperableHTMLElement {
    private _onGlobalTodosUpdated: ((todos: any[]) => void) | null = null;
    private globalTodos: any[] = [];

    connectedCallback() {
        this.render();
        this.loadData();

        this._onGlobalTodosUpdated = (todos: any[]) => {
            this.globalTodos = todos;
            this.renderTodoList();
        };
        window.applicationAPI.subscribe('globalTodosUpdated', this._onGlobalTodosUpdated);
    }

    disconnectedCallback() {
        if (this._onGlobalTodosUpdated) {
            window.applicationAPI.unsubscribe('globalTodosUpdated', this._onGlobalTodosUpdated);
            this._onGlobalTodosUpdated = null;
        }
    }

    getAgentInstruct(): string {
        return '你是待办事项管理助手，可以帮助用户查看和管理全局待办。当前页面展示了所有全局待办。你可以使用 TodoWrite 工具管理当前任务的待办，使用 addGlobalTodo 等工具管理全局待办。';
    }

    render() {
        this.innerHTML = `
      <div class="w-full h-full flex flex-col bg-gradient-to-br from-slate-50 via-white to-slate-100">
        <header class="pl-6 pr-16 py-4 flex items-center justify-between border-b border-gray-200 bg-white/80 backdrop-blur">
          <div>
            <p class="text-xs uppercase tracking-wide text-gray-400">TodoMgr</p>
            <h1 class="text-xl font-semibold text-gray-800">待办管理</h1>
          </div>
          <button id="refresh-btn" class="px-4 py-2 rounded-full bg-blue-600 text-white text-sm hover:bg-blue-700 transition">
            刷新
          </button>
        </header>

        <div id="content" class="flex-1 p-4 overflow-auto">
          <p class="text-center text-gray-400 pt-8">加载中...</p>
        </div>
      </div>
    `;

        this.querySelector('#refresh-btn')?.addEventListener('click', () => this.loadData());
    }

    async loadData() {
        try {
            const result = await window.applicationAPI.call('listGlobalTodos', 'all');
            const data = JSON.parse(result);
            if (data.success) {
                this.globalTodos = data.todos;
            }
            this.renderTodoList();
        } catch (error: any) {
            const contentDiv = this.querySelector('#content');
            if (contentDiv) {
                contentDiv.innerHTML = `<p class="text-center text-red-500 pt-8">加载失败: ${error.message}</p>`;
            }
        }
    }

    renderTodoList() {
        const contentDiv = this.querySelector('#content');
        if (!contentDiv) return;

        if (this.globalTodos.length === 0) {
            contentDiv.innerHTML = `
        <div class="flex flex-col items-center justify-center h-full">
          <p class="text-gray-400">暂无全局待办</p>
          <p class="text-xs text-gray-300 mt-2">使用 addGlobalTodo 工具添加待办</p>
        </div>
      `;
            return;
        }

        const getStatusIcon = (status: string) => {
            const map: Record<string, string> = { pending: '⭕', in_progress: '🔄', completed: '✅' };
            return map[status] || '⭕';
        };

        const getPriorityBadge = (priority: string) => {
            const colorMap: Record<string, string> = {
                low: 'bg-blue-100 text-blue-700',
                medium: 'bg-amber-100 text-amber-700',
                high: 'bg-red-100 text-red-700',
            };
            const labelMap: Record<string, string> = { low: '低', medium: '中', high: '高' };
            const cls = colorMap[priority] || colorMap['medium'];
            const label = labelMap[priority] || '中';
            return `<span class="${cls} px-2 py-1 rounded-full text-xs font-medium">${label}</span>`;
        };

        contentDiv.innerHTML = `
      <div class="space-y-3">
        ${this.globalTodos.map(todo => `
          <div class="bg-white rounded-2xl p-4 shadow-sm border border-[#F0F0F2]">
            <div class="flex items-start gap-3">
              <span class="text-xl">${getStatusIcon(todo.status)}</span>
              <div class="flex-1">
                <div class="flex items-center gap-2">
                  ${getPriorityBadge(todo.priority)}
                  <span class="font-semibold text-gray-800">${this.escapeHtml(todo.content)}</span>
                </div>
                <div class="text-xs text-gray-400 mt-1">
                  创建于 ${new Date(todo.created_at).toLocaleString()}
                  ${todo.category ? ` · ${this.escapeHtml(todo.category)}` : ''}
                  ${todo.completed_at ? ` · 完成于 ${new Date(todo.completed_at).toLocaleString()}` : ''}
                </div>
              </div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
    }

    private escapeHtml(s: string): string {
        return s.replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
    }
}

customElements.define('todomgr-entry-widget', TodoMgrEntryWidget);
