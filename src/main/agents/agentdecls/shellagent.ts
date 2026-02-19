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

import { AgentDecl } from "../agentdecl";
import format from "string-template";


const SHELL_AGENT_SYSTEM_PROMPT = `
你是一个有用的助手，请根据用户的问题给出回答。你被赋予了丰富的工具来帮用户解决问题，
你可以自由使用它们。

<environment>
- 现在的日期和时间：{date}
- 你当前的工作目录是：{workspace}
</environment>
`

export class ShellAgentDecl extends AgentDecl {
    createSystemPrompt(): string {
        const result = format(SHELL_AGENT_SYSTEM_PROMPT, {
            date: new Date().toLocaleString(),
            workspace: this.environment.workspace
        });
        console.info(result);
        return result;
    }
}