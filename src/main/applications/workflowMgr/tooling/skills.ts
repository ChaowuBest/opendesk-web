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
 * 职责：构建 Workflow 引导 Skill 和已保存 Definition 的 Slash Skill。
 */

import { Skill } from '../../../aikernel/skill.js';
import type { WorkflowDefinition } from '../../../aikernel/workflow.js';
import { createWorkflowDiscoveryToolset, type WorkflowToolHost } from './tools.js';

const WORKFLOW_SKILL_DESCRIPTION = '创建、查找、运行和停止可复用的 JavaScript Workflow。';
const WORKFLOW_SKILL_BODY = `# Workflow 工作流

本技能用于创建和使用可复用的 JavaScript Workflow。调用 \`LoadWorkflowTools\` 后，当前 Task 将获得完整的 Workflow 操作工具。

## 可用能力

- \`AuthorWorkflow\`：读取当前 Task 中按时间顺序保留的用户真实原始输入，完成方案设计、Definition 生成和校验。
- \`ListWorkflows\`：列出当前 Task 的临时 Definition，以及已保存和内置的 Definition，并返回来源、输入结构和准确调用方式。
- \`RunWorkflow\`：使用准确的 reference 和符合 inputSchema 的 input 对象启动一次异步运行。
- \`StopWorkflow\`：使用 runId 停止正在运行的 Workflow。

## 创建并运行

创建时依次调用 \`LoadWorkflowTools\` 和 \`AuthorWorkflow\`。创建与运行是两次独立工具调用，\`AuthorWorkflow\` 返回 Definition 和 invocation。

- \`launchReady=true\` 表示首次运行所需输入已经齐全，可在当前回合继续调用返回的 invocation。
- \`launchReady=false\` 表示需要按 \`nextAction\` 向用户收集 \`missingRequiredInputs\`。收到用户下一条回复后，使用同一 reference 和符合 inputSchema 的 input 对象调用 \`RunWorkflow\`。

## 运行结果

\`status="started"\` 和运行卡片共同构成启动回执。当前回合在启动回执后结束，OpenDesk 会在 Workflow 到达终态后向宿主 Task 投递结果。`;

export function createWorkflowSkills(definitions: WorkflowDefinition[], host: WorkflowToolHost): Skill[] {
    const managerSkill = new Skill(
        {
            name: 'workflow',
            description: WORKFLOW_SKILL_DESCRIPTION,
            'user-invocable': true,
            'disable-model-invocation': true,
            'argument-hint': '<需求或 Workflow 名称>'
        },
        WORKFLOW_SKILL_BODY
    );
    managerSkill.toolsets = [createWorkflowDiscoveryToolset(host)];

    const definitionSkills = definitions.map((definition) => {
        const skill = new Skill(
            {
                name: definition.name,
                description: definition.description,
                'user-invocable': true,
                'disable-model-invocation': true,
                'argument-hint': inputHint(definition)
            },
            [
                `# ${definition.name}`,
                '',
                definition.description,
                ...(definition.whenToUse ? ['', `适用场景：${definition.whenToUse}`] : []),
                '',
                '## 运行方式',
                '',
                '调用 `LoadWorkflowTools` 为当前 Task 加载 Workflow 操作工具。',
                `随后调用 \`RunWorkflow\`，使用 reference \`${definition.name}\`。`,
                '`status="started"` 和运行卡片共同构成启动回执，最终结果会在 Workflow 到达终态后投递给宿主 Task。',
                '',
                '## 输入结构',
                '',
                '`RunWorkflow.input` 使用符合以下 JSON Schema 的对象：',
                '```json',
                JSON.stringify(definition.inputSchema, null, 2),
                '```'
            ].join('\n')
        );
        skill.toolsets = [createWorkflowDiscoveryToolset(host)];
        return skill;
    });

    return [managerSkill, ...definitionSkills];
}

function inputHint(definition: WorkflowDefinition): string {
    const properties = definition.inputSchema.properties;
    if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
        return '';
    }
    return Object.keys(properties)
        .map((name) => `<${name}>`)
        .join(' ');
}
