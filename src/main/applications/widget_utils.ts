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

import { BaseTool, BaseToolset } from '../aikernel/tool';
import { z } from 'zod';
import type { TaskState } from '../aikernel/states/tasks';

export class AgentOperableHTMLElement extends HTMLElement {
    constructor() {
        super();
    }

    /**
     * 获取工具集
     */
    getToolset(): RendererToolset | null {
        return null;
    }

    /**
     * 获取Agent的指示
     */
    getAgentInstruct(): string | null {
        return null;
    }
}

/**
 * 运行在渲染进程的工具，可以通过后端的Agent调用
 */
export class RendererTool<T extends z.ZodType> extends BaseTool<T> {
    /**
     * 设置工具的执行器。
     */
    setExecutor(executor: (args: z.output<T>, taskState?: TaskState) => Promise<string>): ThisType<T> {
        this.executor = executor;
        return this;
    }

    setParams(params: T): ThisType<T> {
        this.params = params;
        return this;
    }

    async execute(args: z.output<T>, updatedCallback?: (result: any) => void, taskState?: TaskState): Promise<any> {
        if (!this.executor) {
            throw new Error(`executor of tool ${this.name} hasn't been set yet`);
        }
        return this.executor(args, taskState);
    }
}

export class RendererToolset extends BaseToolset {
    constructor(name: string) {
        super(name);
    }
}
