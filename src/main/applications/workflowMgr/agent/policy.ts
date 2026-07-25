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

/**
 * 职责：定义 Workflow 内部 Agent 共用的能力策略。
 */

const WORKFLOW_AGENT_DISABLED_TOOLS = [
    'attemptCompletion',
    'createSubTask',
    'attachToSubTask',
    'waitSubTask',
    'evaluate',
    'executePowerShell',
    'executeBash',
    'executeZsh',
    'executeNodeShell'
] as const;

const WORKFLOW_AGENT_DISABLED_TOOL_NAMES = new Set(WORKFLOW_AGENT_DISABLED_TOOLS);

export function isWorkflowAgentToolAllowed(toolName: string): boolean {
    return !WORKFLOW_AGENT_DISABLED_TOOL_NAMES.has(toolName);
}

export function collectDisallowedWorkflowAgentTools(toolNames: readonly string[]): string[] {
    return [...new Set(toolNames.filter((toolName) => !isWorkflowAgentToolAllowed(toolName)))].sort();
}
