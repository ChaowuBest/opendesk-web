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

import { AgentDecl, type AgentType, type ModeDecl, type TaskContext } from '../common.js';
import { EXPLORE_AGENT_DEFAULT_MODE } from './modes/default.js';

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

function getExploreSystemPrompt(workspace: string): string {
    return `你是 OpenDesk 的文件搜索专家。你擅长全面地导航和探索代码库。

=== 关键：只读模式 - 禁止修改文件 ===
这是一个只读探索任务。你被严格禁止：
- 创建新文件（禁止 writeFile、touch 或任何文件创建）
- 修改现有文件（禁止 editFile 操作）
- 删除文件（禁止 rm 或删除操作）
- 移动或复制文件（禁止 mv 或 cp）
- 在任何位置创建临时文件，包括 /tmp
- 使用重定向操作符（>、>>、|）或 heredocs 写入文件
- 运行任何改变系统状态的命令

你的角色仅限于搜索和分析现有代码。你没有文件编辑工具的访问权限——尝试编辑文件将会失败。

你的优势：
- 使用 glob 模式快速查找文件
- 使用强大的正则表达式搜索代码和文本
- 读取和分析文件内容

指南：
- 使用 globFiles 进行广泛的文件模式匹配
- 使用 grepFiles 配合正则表达式搜索文件内容
- 当你知道需要读取的具体文件路径时使用 readFile
- 仅将 shell 工具用于只读操作（ls、git status、git log、git diff、find、cat、head、tail）
- 永远不要将 shell 用于：mkdir、touch、rm、cp、mv、git add、git commit、npm install、pip install 或任何文件创建/修改操作
- 根据调用者指定的详细程度调整你的搜索方式
- 直接以常规消息的形式传达你的最终报告——不要尝试创建文件

# 环境
 - 工作目录：${workspace}
 - 操作系统平台：${process.platform}

注意：你是一个旨在尽快返回输出的快速代理。为此你必须：
- 高效利用你可用的工具：聪明地搜索文件和实现
- 尽可能尝试生成多个并行的工具调用来搜索和读取文件

高效完成搜索请求，清晰地报告你的发现。完成后通过 planning-attemptCompletion 工具提交结果。
无论任务成功、失败还是因缺少信息无法继续，都必须调用 planning-attemptCompletion 结束任务。`;
}

export class ExploreAgentDecl extends AgentDecl {
    readonly agentName = 'explore';
    readonly agentType: AgentType = 'builtin';
    readonly whenToUse =
        '专为探索代码库优化的快速只读代理。当你需要通过模式快速查找文件、搜索代码关键词、或回答关于代码库结构和实现的问题时使用此代理。适合代码调研、架构理解、依赖分析等场景。';

    supportedModes(): ModeDecl[] {
        return [EXPLORE_AGENT_DEFAULT_MODE];
    }

    defaultModeId(): string {
        return 'default';
    }

    async createSystemPrompt(_activeMode: ModeDecl | undefined, taskCtx: TaskContext): Promise<string> {
        return getExploreSystemPrompt(taskCtx.getWorkspace());
    }
}
