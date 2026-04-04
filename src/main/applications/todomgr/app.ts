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

import { BaseApplication } from "../base";
import { BaseToolset } from "../../aikernel/tool";
import { Skill } from "../../aikernel/skill.js";
import { z } from 'zod';
import { TodoWriteTool, AddGlobalTodoTool, UpdateGlobalTodoTool, ListGlobalTodosTool, DeleteGlobalTodoTool, GetCurrentTimeTool, GetSupportedEventsTool } from './tools';
import TodoMgrWorker from "./worker";
import { MANAGE_GLOBAL_TODOS_SKILL } from "./skills.js";
import chalk from "chalk";


export class TodoMgrApplication extends BaseApplication {
    constructor() {
        super('todomgr', '待办事项', false);
    }

    async getTUIStatusBlock(): Promise<string | null> {
        try {
            const res = await this.callWorker('listGlobalTodos', 'all');
            if (res?.status === 'ok' && Array.isArray(res.data)) {
                const todos = res.data;
                const pending = todos.filter((t: any) => t.status === 'pending' || t.status === 'in_progress').length;
                const completed = todos.filter((t: any) => t.status === 'completed').length;
                const total = pending + completed;
                if (total === 0) return null;
                const filled = Math.round((completed / total) * 8);
                const bar = chalk.hex('#39FF14')('█'.repeat(filled)) + chalk.hex('#4a4a4a')('░'.repeat(8 - filled));
                return `📋 ${bar} ${completed}/${total}`;
            }
            return null;
        } catch {
            return null;
        }
    }

    static getWorkerClass() {
        return TodoMgrWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({});
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('todomgr');

        toolset.addTool(new GetCurrentTimeTool());
        toolset.addTool(new TodoWriteTool(this));

        return [toolset];
    }

    async getSkills(): Promise<Skill[]> {
        const manageGlobalTodosSkill = Skill.parseMd(MANAGE_GLOBAL_TODOS_SKILL);
        const globalTodosToolset = new BaseToolset('global-todos');

        globalTodosToolset.addTool(new AddGlobalTodoTool(this));
        globalTodosToolset.addTool(new UpdateGlobalTodoTool(this));
        globalTodosToolset.addTool(new ListGlobalTodosTool(this));
        globalTodosToolset.addTool(new DeleteGlobalTodoTool(this));
        globalTodosToolset.addTool(new GetSupportedEventsTool(this));

        manageGlobalTodosSkill.toolsets = [globalTodosToolset];

        return [manageGlobalTodosSkill];
    }

    /**
     * 获取应用能够注册的事件
     */
    async getSupportedEvents(): Promise<{ eventName: string; eventDescription: string }[]> {
        return [
            {
                eventName: 'globalTodosUpdated',
                eventDescription: '全局待办列表更新事件，当添加、删除、更新待办事项时触发',
            },
        ];
    }
}
