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
import { BaseToolset } from "../../agents/tool";
import { z } from 'zod';
import { TodoWriteTool, AddGlobalTodoTool, UpdateGlobalTodoTool, ListGlobalTodosTool } from './tools';
import TodoMgrWorker from "./worker";


export class TodoMgrApplication extends BaseApplication {
    constructor() {
        super('todomgr', '待办事项', false);
    }

    static getWorkerClass() {
        return TodoMgrWorker;
    }

    static getConfigSchema(): z.ZodObject<any> {
        return z.object({});
    }

    async getToolsets(): Promise<BaseToolset[]> {
        const toolset = new BaseToolset('todomgr');

        // ========== TodoWrite 工具 ==========
        toolset.addTool(new TodoWriteTool(this));

        // ========== addGlobalTodo 工具 ==========
        toolset.addTool(new AddGlobalTodoTool(this));

        // ========== updateGlobalTodo 工具 ==========
        toolset.addTool(new UpdateGlobalTodoTool(this));

        // ========== listGlobalTodos 工具 ==========
        toolset.addTool(new ListGlobalTodosTool(this));

        return [toolset];
    }
}
