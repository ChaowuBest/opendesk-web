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

import path from 'path';
import fs from 'fs';
import type { PermissionRule } from '../../../security/permission.js';
import { createSensitivePathRules, createDeviceNodeRules } from '../../../../utils/permissionRules.js';
import type { ModeDecl, TaskContext } from '../../common.js';
import { getPlanFilePath } from '../../../../../utils/planSlug.js';
import { fromMsysPath, normalizePath } from '../../../../../utils/pathNormalize.js';

/**
 * Plan Mode 权限规则：
 * - 工作空间内文件可读但不可写（只读模式）
 * - .plan 目录可读可写（计划文件输出目录）
 * - 工作空间内可执行（允许 shell 只读命令）
 * - 工作空间外隐式 ask
 * - 技能可读
 * - 敏感路径保护
 */
export function createPlanModePermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(fromMsysPath(workspace)));
    const planDirNorm = `${workspaceNorm}/.plan`;
    // brace expansion：{,/**} 同时匹配目录自身和所有子路径
    const planPattern = `${planDirNorm}{,/**}`;
    const wsPattern = `${workspaceNorm}{,/**}`;

    return [
        // 设备节点始终允许（/dev/stdin, /dev/null 等）
        ...createDeviceNodeRules(),
        // .plan 目录可读可写可执行
        { resourceType: 'file', action: 'read', pathPattern: planPattern, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: planPattern, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: planPattern, effect: 'allow' },
        // 工作空间内只读 + 可执行
        { resourceType: 'file', action: 'read', pathPattern: wsPattern, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: wsPattern, effect: 'allow' },
        // 工作空间内写入不添加 allow/deny 规则，依赖隐式 ask 来阻止写入。
        // 不能用 deny 是因为引擎中 deny 优先级最高，会覆盖上面 .plan 的 allow write。
        // 隐式 ask 在无 prompt provider 时自动拒绝，效果等同于 deny。
        // 技能可读
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        // 敏感路径保护
        ...createSensitivePathRules(workspace)
    ];
}

/**
 * Plan Mode 专属 sub-prompt，指导 agent 通过子代理进行探索和规划。
 */
export function getPlanModeSubPrompt(taskCtx: TaskContext): string {
    const workspace = taskCtx.getWorkspace();
    const planFile = getPlanFilePath(taskCtx.task_id, workspace);
    const planFileRelative = planFile.startsWith(workspace) ? '.plan/' + planFile.split('.plan/')[1] : planFile;
    return `# 当前模式：Plan Mode (规划模式)

你当前处于 规划模式(Plan Mode)，这是一种只读模式。在规划模式下，你的工作目标是根据用户的需求，
通过子任务探索代码库 → 设计实现方案 → 输出计划文件 → 请求审批的流程，输出符合需要的工作计划，然后切换到
其他模式进行实现。

## 工作原则

1. **只读为主**：你不能修改工作空间中的任何文件（\`${planFileRelative}\` 目录除外，所有的计划文件都应该保存在这里）。所有文件编辑和写入工具将被禁用;
2. **深入探索**：充分利用文件读取、搜索（glob/grep）和 shell 只读命令（如 git log, git diff, ls 等）来理解代码库;
3. **设计为本**：你的目标是产出一份结构化的实现计划，而非直接编码;

## 工作流程

### 阶段 1：理解需求与探索代码库
- 仔细分析用户的需求描述，如有不清楚的地方，向用户提问澄清
- 使用 \`createSubTask\` 工具启动 **explore** 代理来并行探索代码库
- 可以启动最多 3 个使用 explore agent 的子任务并行探索不同方面（在一条消息中发出多个 createSubTask 调用）
- 每个子任务应有明确的搜索目标，例如：
  - 理解用户请求涉及的核心模块和入口文件
  - 搜索可复用的代码模式、约定和架构风格
  - 识别需要修改的关键文件和它们的依赖关系

### 阶段 2：设计方案
- 使用 \`createSubTask\` 工具启动使用 plan agent 的子任务来设计实现方案
- 基于阶段 1 的探索结果，在 plan 代理的任务描述中提供完整的上下文（包括文件名和代码路径追踪结果）
- plan agent会返回分步实现策略和关键文件列表
- 对于复杂任务，可以启动多个 plan 代理从不同视角设计方案：
  - 例如：简洁性 vs 性能 vs 可维护性
  - 例如：最小改动 vs 整洁架构

### 阶段 3：审核与完善
- 阅读 plan 代理识别的关键文件，加深理解
- 使用 \`askUser\` 工具向用户提问澄清任何疑点
- 综合所有代理的输出，形成最终方案

### 阶段 4：输出最终计划
- 使用 \`writeFile\` 工具将最终计划写入 \`${planFileRelative}\`（这是你唯一可写的路径）
- 计划文件路径：\`${planFile}\`
- **重要**：必须使用 \`writeFile\` 工具写入计划文件，不要使用 shell 命令写文件
- 计划应包含：
  - 任务摘要
  - 实现步骤（按执行顺序排列）
  - 每个步骤需要修改的文件和修改内容概述
  - 3-5 个关键文件路径
  - 潜在风险和注意事项

### 阶段 5：请求审批
- 调用 \`exitPlanMode\` 工具提交计划供用户审批
- 用户可以选择：
  - 切换到 **Standard 模式** 执行计划（需确认关键操作）
  - 切换到 **Solo 模式** 执行计划（全自动无人值守）
  - 继续编辑计划
- 如果用户选择继续编辑，回到阶段 3 迭代完善

## 输出格式

你在此模式下的文本输出应当更加详细和结构化（与标准模式的简洁风格不同），因为用户需要全面理解你的计划。
使用 Markdown 标题、列表和代码块来组织你的分析和计划。

## 重要约束

- **禁止**直接修改工作空间中的代码文件（\`${planFileRelative}\` 目录除外）
- **禁止**执行会改变状态的 shell 命令（如 git commit, npm install 等）
- **允许**在 \`${planFileRelative}\` 目录中写入计划文件
- **允许**执行只读的 shell 命令获取信息
- **必须**通过子代理（explore/plan）来完成探索和设计工作
- **必须**通过 \`exitPlanMode\` 工具提交计划，而不是提示用户手动切换模式`;
}

/**
 * plan mode：只读规划模式，仅 .plan 目录可写
 */
export const MAIN_AGENT_PLAN_MODE: ModeDecl = {
    id: 'plan',
    name: 'plan',
    description: '规划模式，只读探索 + .plan 目录可写，先设计后执行',
    icon: '📋',
    color: '#FFAB00',
    permissionFactory: (workspace) => createPlanModePermissionRules(workspace),
    getSubPrompt: (taskCtx) => getPlanModeSubPrompt(taskCtx),
    disabledTools: [],
    onEnterMode: (workspace: string) => {
        const planDir = path.join(workspace, '.plan');
        try {
            if (!fs.existsSync(planDir)) {
                fs.mkdirSync(planDir, { recursive: true });
            }
        } catch {
            /* .plan 目录创建失败不影响主流程 */
        }
    }
};
