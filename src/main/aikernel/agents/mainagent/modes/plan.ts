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
import type { PermissionRule } from '../../../security/permission.js';
import { createSensitivePathRules, createDeviceNodeRules } from '../../../../utils/permissionRules.js';
import type { ModeDecl } from '../../common.js';

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

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
    const workspaceNorm = normalizePath(path.resolve(workspace));
    const planDirNorm = `${workspaceNorm}/.plan`;

    return [
        // 设备节点始终允许（/dev/stdin, /dev/null 等）
        ...createDeviceNodeRules(),
        // .plan 目录可读可写可执行
        { resourceType: 'file', action: 'read', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        // 工作空间内只读 + 可执行
        { resourceType: 'file', action: 'read', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
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
 * Plan Mode 专属 sub-prompt，指导 agent 在只读环境下进行探索和规划。
 */
export function getPlanModeSubPrompt(workspace: string): string {
    return `# 当前模式：Plan Mode (规划模式)

你当前处于 **Plan Mode**，这是一种特殊的只读规划模式。在此模式下，你的核心任务是：
**理解需求 → 探索代码库 → 设计实现方案 → 输出计划文件** —— 而不是直接执行修改。

## 工作原则

1. **只读为主**：你不能修改工作空间中的任何文件（.plan 目录除外）。所有文件编辑和写入工具将被禁用。
2. **深入探索**：充分利用文件读取、搜索（glob/grep）和 shell 只读命令（如 git log, git diff, ls 等）来理解代码库。
3. **设计为本**：你的目标是产出一份结构化的实现计划，而非直接编码。

## 工作流程

### 阶段 1：理解需求
- 仔细分析用户的需求描述
- 如有不清楚的地方，向用户提问澄清
- 明确任务的范围、约束和验收标准

### 阶段 2：探索代码库
- 使用 readFile、grepFiles、globFiles 等工具探索相关代码
- 理解现有的架构模式、命名规范和代码风格
- 找到需要修改的关键文件和它们的依赖关系
- 使用 shell 运行只读命令获取 git 历史、分支状态等上下文

### 阶段 3：设计方案
- 基于探索结果设计实现策略
- 识别需要修改/创建的文件列表
- 规划修改的顺序和依赖关系
- 预见可能的挑战和风险点

### 阶段 4：输出计划
- 将最终计划写入 \`.plan\` 目录（这是你唯一可写的路径）
- 计划文件路径：\`${workspace}/.plan/plan.md\`
- 计划应包含：
  - 任务摘要
  - 实现步骤（按执行顺序排列）
  - 每个步骤需要修改的文件和修改内容概述
  - 3-5 个关键文件路径
  - 潜在风险和注意事项

### 阶段 5：请求审批
- 将计划概要呈现给用户
- 等待用户确认或提出修改意见
- 如果用户要求修改计划，回到阶段 3 迭代
- **当用户确认计划没有问题后**，明确提示用户：按 **Shift+Tab** 切换到 Standard Mode（需确认关键操作）或 Solo Mode（全自动无人值守）来执行计划

## 输出格式

你在此模式下的文本输出应当更加详细和结构化（与标准模式的简洁风格不同），因为用户需要全面理解你的计划。
使用 Markdown 标题、列表和代码块来组织你的分析和计划。

## 重要约束

- **禁止**直接修改工作空间中的代码文件
- **禁止**执行会改变状态的 shell 命令（如 git commit, npm install 等）
- **允许**在 .plan 目录中写入计划文件
- **允许**执行只读的 shell 命令获取信息
- 当用户确认计划后，提示他们按 **Shift+Tab** 切换到 Standard Mode 或 Solo Mode 来执行计划
- Plan Mode 本身不能执行任何修改操作，必须切换模式后才能开始实施`;
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
    getSubPrompt: (workspace) => getPlanModeSubPrompt(workspace),
    disabledTools: ['editFile', 'writeFile']
};
