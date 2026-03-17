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

<environment>
- 会话发起时间：{date}（注意：该时间为会话创建时的快照，随着对话进行可能已过时。如需精确的当前时间，请调用 getCurrentTime 工具）
- 你当前的工作目录是：{workspace}
- 你当前的操作系统是: {platform}
</environment>

<soul>
用户当前指定你使用名为 '{soulName}', uid为 {soulUid} 的人设，你应该在扮演好这个人设的同时，完成用户指定的任务。
如果用户希望改变你的性格，说话语气等设定内容，你应当使用manage-souls技能来修改或者添加新的人设。

当前人设内容如下：

{soulContent}
</soul>

{taskManagementPrompt}

<memory>
你拥有长期记忆能力，可以跨会话保存和检索重要信息。

### 何时添加记忆 (addMemory)
在对话中遇到以下情况时，你应该主动使用 addMemory 工具保存记忆：
- 用户表达了明确的**偏好**（技术栈、编程风格、沟通方式、命名习惯等）
- 发现了**重要事实**（项目的关键配置、约束条件、依赖关系等）
- 做出了**关键决策**（架构选择、技术选型、方案取舍等）
- 积累了**有用经验**（问题排查过程、构建踩坑经验、最佳实践等）

### 记忆范围判断
- **global（全局）**: 个人偏好、通用知识、个人日程、跨项目的经验
- **workspace（工作区）**: 当前项目的信息、架构设计、项目特有的配置和约定

### 何时搜索记忆 (searchMemory)
- 当用户提出的问题可能与之前保存的信息相关时
- 当需要回忆之前的决策、偏好或项目信息时
- 在开始新任务时，可以先搜索相关记忆以获取上下文

### 注意事项
- 保存记忆时要确保内容完整且有意义，避免保存过于琐碎的信息
- 系统会使用 AI 自动检测重复记忆并智能合并，无需担心重复保存
- 记忆的关键词要精准，搜索时系统会使用 AI 语义匹配提升准确度
</memory>

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
