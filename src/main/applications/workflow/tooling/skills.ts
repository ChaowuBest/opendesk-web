/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * 职责：构建 Workflow 引导 Skill 和已保存 Definition 的 Slash Skill。
 */

import { Skill } from '../../../aikernel/skill.js';
import type { WorkflowDefinition } from '../../../aikernel/workflow.js';
import { t } from '../../../../locale/index.js';

export function createWorkflowSkills(definitions: WorkflowDefinition[]): Skill[] {
    const managerSkill = new Skill(
        {
            name: 'workflow',
            description: t('workflow.skill.description'),
            'user-invocable': true,
            'argument-hint': t('workflow.skill.argumentHint')
        },
        t('workflow.skill.body')
    );

    const definitionSkills = definitions.map((definition) => {
        return new Skill(
            {
                name: definition.name,
                description: definition.description,
                'user-invocable': true,
                'argument-hint': inputHint(definition)
            },
            [
                `# ${definition.name}`,
                '',
                definition.description,
                ...(definition.whenToUse
                    ? ['', `${t('workflow.skill.definition.whenToUse')}${definition.whenToUse}`]
                    : []),
                '',
                `## ${t('workflow.skill.definition.runTitle')}`,
                '',
                t('workflow.skill.definition.loadTools'),
                t('workflow.skill.definition.run', { reference: definition.name }),
                t('workflow.skill.definition.started'),
                '',
                `## ${t('workflow.skill.definition.inputTitle')}`,
                '',
                t('workflow.skill.definition.input'),
                '```json',
                JSON.stringify(definition.inputSchema, null, 2),
                '```'
            ].join('\n')
        );
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
