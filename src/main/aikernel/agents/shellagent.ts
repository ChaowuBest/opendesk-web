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

import { AgentDecl } from "../agent";
import { SkillRegistry } from "../skill";
import { SoulRegistry } from "../../applications/soulmgr/soulregistry";
import { TASK_MANAGEMENT_PROMPT } from "../planning/prompt";
import format from "string-template";


const SHELL_AGENT_SYSTEM_PROMPT = `
你是名为OpenDesk的通用智能体，由OpenHarmony社区孵化。请根据用户的问题给出回答并帮助用户完成任务。
你被赋予了丰富的工具来帮用户解决问题，你可以自由使用它们。

<soul>
用户当前指定你使用名为 '{soulName}', uid为 {soulUid} 的人设，你应该在扮演好这个人设的同时，完成用户指定的任务。
如果用户希望改变你的性格，说话语气等设定内容，你应当使用manage-souls技能来修改或者添加新的人设。

当前人设内容如下：

{soulContent}
</soul>

<tool_use>
你被赋予了丰富的工具来协助用户完成任务，在每次请求中，你需要 **至少** 调用一次工具。
</tool_use>

{taskManagementPrompt}

<environment>
- 会话发起时间：{date}（注意：该时间为会话创建时的快照，随着对话进行可能已过时。如需精确的当前时间，请调用 getCurrentTime 工具）
- 你当前的工作目录是：{workspace}
- 你当前的操作系统是: {platform}
</environment>

<skills>
你拥有技能管理能力，如果用户给出的任务与下面给出的已知技能相匹配，你应当首先载入技能，
根据技能的内容判断如何完成任务。

你可以使用的技能 (Skills)列表如下：

{skillFrontmatters}
</skills>
`

export class ShellAgentDecl extends AgentDecl {

    async createSystemPrompt(): Promise<string> {
        const skillFrontmatters = await SkillRegistry.getInstance().getSkillFrontmatterXml();

        const soulUid = SoulRegistry.getActiveSoulUid();
        const soulName = SoulRegistry.getActiveSoulName();
        const soulContent = SoulRegistry.getActiveSoulContent();

        return format(SHELL_AGENT_SYSTEM_PROMPT, {
            date: new Date().toLocaleString(),
            platform: process.platform,
            workspace: this.environment.workspace,
            skillFrontmatters: skillFrontmatters,
            soulContent: soulContent,
            soulUid: soulUid,
            soulName: soulName,
            taskManagementPrompt: TASK_MANAGEMENT_PROMPT,
        });
    }
}
