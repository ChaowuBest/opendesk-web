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

import { Skill } from '../../aikernel/skill.js';
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import { z } from 'zod';
import { t } from './locale/index.js';
import type { SlidesCapabilityDefinition, SlidesCapabilityExecution } from './provider.js';

export type { SlidesCapabilityDefinition } from './provider.js';

export type SlidesCapabilityExecutor = (
    taskId: string,
    name: string,
    input: Record<string, unknown>
) => Promise<SlidesCapabilityExecution>;

const SLIDES_ACTION_CATEGORIES = ['read', 'text', 'layout', 'slide', 'insert', 'chart', 'table'] as const;
type SlidesActionCategory = (typeof SLIDES_ACTION_CATEGORIES)[number];

interface SlidesActionMetadata {
    category: SlidesActionCategory;
    summary: string;
}

interface PreparedSlidesAction extends SlidesActionMetadata {
    definition: SlidesCapabilityDefinition;
    validator: BaseTool<z.ZodType>;
}

const SLIDES_ACTION_METADATA: Record<string, SlidesActionMetadata> = {
    get_deck_context: { category: 'read', summary: '读取整份演示文稿概览' },
    read_slide: { category: 'read', summary: '读取指定页面及元素详情' },
    set_element_text: { category: 'text', summary: '替换元素文本' },
    set_element_style: { category: 'text', summary: '修改元素文字样式' },
    set_element_transform: { category: 'layout', summary: '移动、缩放或旋转元素' },
    execute_slide_script: { category: 'layout', summary: '批量执行页面布局与样式操作' },
    set_element_fill: { category: 'layout', summary: '修改元素填充' },
    set_element_stroke: { category: 'layout', summary: '修改元素边框' },
    delete_element: { category: 'layout', summary: '删除元素' },
    ungroup_element: { category: 'layout', summary: '取消元素组合' },
    delete_slide: { category: 'slide', summary: '删除页面' },
    add_slide: { category: 'slide', summary: '新增页面' },
    set_slide_background: { category: 'slide', summary: '修改页面背景' },
    add_text_box: { category: 'insert', summary: '插入文本框' },
    add_shape: { category: 'insert', summary: '插入形状' },
    add_smartart: { category: 'insert', summary: '插入图示' },
    add_chart: { category: 'chart', summary: '插入图表' },
    edit_chart: { category: 'chart', summary: '修改已有图表' },
    add_table: { category: 'table', summary: '插入表格' },
    edit_table_cell: { category: 'table', summary: '修改表格单元格' },
    edit_table_structure: { category: 'table', summary: '修改表格行列结构' },
    edit_table_style: { category: 'table', summary: '修改表格样式' }
};

const ListActionsSchema = z.object({
    category: z.enum(SLIDES_ACTION_CATEGORIES).optional().describe('固定能力类别；省略时返回全部动作')
});

const GetActionDefinitionSchema = z.object({
    name: z.string().min(1).describe('动作目录中的精确动作名称')
});

const ExecuteActionSchema = z.object({
    name: z.string().min(1).describe('已通过 get_action_definition 确认的精确动作名称'),
    input: z.record(z.string(), z.unknown()).describe('严格符合该动作 inputSchema 的输入对象')
});

function toInternalToolSchema(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(toInternalToolSchema);
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => {
            if (key === '$ref' && typeof child === 'string') {
                return [key, child.replace('#/definitions/', '#/$defs/')];
            }
            return [key === 'definitions' ? '$defs' : key, toInternalToolSchema(child)];
        })
    );
}

const EDIT_CURRENT_PRESENTATION_SKILL = `
---
name: edit-current-presentation
description: 读取和编辑当前任务中已打开的 PPT，包括幻灯片、文本、形状、表格、图表和布局等确定性操作
---

# 编辑当前任务中的 PPT

本 Skill 操作当前任务右侧编辑器中已经打开的 PPT。它不会查找其他任务或其他窗口中的文档。

## 使用顺序

1. 从下方固定目录选择精确动作名称；可用 \`list_actions\` 按固定类别重新列举，不进行关键词或语义搜索。
2. 调用 \`get_action_definition\` 获取该动作的完整参数 Schema。
3. 调用 \`execute_action\` 执行；同一份文档上的多步修改应按顺序调用。
4. 修改前后使用 \`get_deck_context\` 或 \`read_slide\` 对应动作读取并确认页面状态。

工具只作用于当前 task 绑定的 PPT 编辑器会话。如果当前任务没有打开 PPT，应先让用户在工作空间中打开目标 .pptx 文件。
`;

function prepareSlidesActions(definitions: readonly SlidesCapabilityDefinition[]): PreparedSlidesAction[] {
    return definitions.map((definition) => {
        const metadata = SLIDES_ACTION_METADATA[definition.name];
        if (!metadata) throw new Error(`${t('error.actionMetadataMissing')}: ${definition.name}`);
        const validator = BaseTool.fromJSON({
            name: definition.name,
            description: definition.description,
            params: toInternalToolSchema(definition.inputSchema)
        });
        return { definition, validator, ...metadata };
    });
}

function buildActionCatalog(actions: readonly PreparedSlidesAction[]): string {
    const lines = SLIDES_ACTION_CATEGORIES.flatMap((category) =>
        actions
            .filter((action) => action.category === category)
            .map((action) => `- [${category}] ${action.definition.name}: ${action.summary}`)
    );
    return `\n\n## 可用动作目录\n\n${lines.join('\n')}\n`;
}

export function buildSlidesSkill(
    definitions: readonly SlidesCapabilityDefinition[],
    executeCapability: SlidesCapabilityExecutor
): Skill {
    const actions = prepareSlidesActions(definitions);
    const actionsByName = new Map(actions.map((action) => [action.definition.name, action]));
    const getAction = (name: string): PreparedSlidesAction => {
        const action = actionsByName.get(name);
        if (!action) throw new Error(`${t('error.actionNotFound')}: ${name}`);
        return action;
    };

    const skill = Skill.parseMd(EDIT_CURRENT_PRESENTATION_SKILL + buildActionCatalog(actions));
    const toolset = new BaseToolset('current-presentation');

    const listActions = new BaseTool(
        'list_actions',
        '按固定类别枚举 PPT 动作；不执行关键词或语义搜索',
        ListActionsSchema
    ).setExecutor(async ({ category }) =>
        JSON.stringify(
            actions
                .filter((action) => category === undefined || action.category === category)
                .map((action) => ({
                    name: action.definition.name,
                    category: action.category,
                    summary: action.summary
                })),
            null,
            2
        )
    );

    const getActionDefinition = new BaseTool(
        'get_action_definition',
        '按精确名称获取一个 PPT 动作的完整 Office 参数定义',
        GetActionDefinitionSchema
    ).setExecutor(async ({ name }) => {
        const action = getAction(name);
        return JSON.stringify(
            {
                name: action.definition.name,
                category: action.category,
                description: action.definition.description,
                inputSchema: action.definition.inputSchema
            },
            null,
            2
        );
    });

    const executeAction = new BaseTool(
        'execute_action',
        '按精确名称校验并执行一个已确认参数定义的 PPT 动作',
        ExecuteActionSchema
    ).setExecutor(async ({ name, input }, taskState) => {
        const action = getAction(name);
        const validatedInput = action.validator.validateArgs(input);
        if (!validatedInput.success) throw new Error(validatedInput.error);
        const taskId = taskState?.task_id;
        if (!taskId) throw new Error(t('error.taskContextRequired'));
        const result = await executeCapability(
            taskId,
            action.definition.name,
            validatedInput.data as Record<string, unknown>
        );
        if (result.isError) throw new Error(result.output || result.summary);
        return result.output;
    });
    executeAction.serialExecution = true;

    toolset.addTools(listActions, getActionDefinition, executeAction);

    skill.toolsets = [toolset];
    return skill;
}
