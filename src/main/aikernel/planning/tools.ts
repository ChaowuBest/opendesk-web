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

import { z } from 'zod';
import chalk from 'chalk';
import { BaseTool, BaseToolset } from '../tool';
import { Card } from '../../tui/components/card';
import { statusDisplay, truncText } from '../../tui/components/toolcall';
import type { TaskState } from '../../states/tasks';
import { ToolCall } from '../messages';
import { analyzeSubTaskScope, type SubTaskRequest } from './subtask';

const DelegateTaskArgsSchema = z.object({
    subtask_title: z.string().max(10).optional()
        .describe('Short sub-task title, up to 10 chars.'),
    sub_goal: z.string().describe('Sub-task goal with a clear expected output.'),
    done_criteria: z.string().describe('How parent task can verify this sub-task is done.'),
    context: z.string().optional().describe('Optional focused context for this sub-task.'),
    allowed_tools: z.array(z.string()).optional()
        .describe('Optional allowlist of full tool names, e.g. ["terminal-readFiles","search-webfetch"].'),
    budget: z.object({
        max_steps: z.number().int().min(1).max(50).optional().describe('Soft step budget for this sub-task.'),
    }).optional(),
});

export class DelegateTaskTool extends BaseTool<typeof DelegateTaskArgsSchema> {
    constructor() {
        super(
            'delegateTask',
            'Delegate a focused sub-task to an isolated child task and return structured result JSON.',
            DelegateTaskArgsSchema
        );
        this.setExecutor(this.handleExecute.bind(this));
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof DelegateTaskArgsSchema> | undefined;
        const body: string[] = [];

        if (args?.sub_goal) {
            body.push(chalk.dim('Sub-goal: ') + truncText(args.sub_goal, width - 20));
        }
        if (args?.done_criteria) {
            body.push(chalk.dim('Done: ') + truncText(args.done_criteria, width - 20));
        }

        if (toolcall.status === 'success' && toolcall.result) {
            try {
                const parsed = JSON.parse(toolcall.result);
                body.push(chalk.greenBright(`  OK ${parsed.status || 'success'} | subtask=${parsed.subtask_id || 'n/a'}`));
            } catch {
                body.push(chalk.greenBright('  OK delegated sub-task completed'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(String(toolcall.result), width - 10)));
        }

        return new Card({
            icon: '[D]',
            title: 'Delegate SubTask',
            status: statusDisplay(toolcall.status),
            body,
        }).render(width);
    }

    private async handleExecute(args: z.output<typeof DelegateTaskArgsSchema>, taskState?: TaskState): Promise<string> {
        if (!taskState) {
            throw new Error('delegateTask requires task state');
        }
        const request: SubTaskRequest = {
            subtask_title: args.subtask_title,
            sub_goal: args.sub_goal,
            done_criteria: args.done_criteria,
            context: args.context,
            allowed_tools: args.allowed_tools,
            budget: args.budget,
        };

        const scopeAnalysis = analyzeSubTaskScope(request);
        if (scopeAnalysis.should_split) {
            const splitResult = {
                status: 'error',
                summary: 'Delegate request is too broad and contains multiple goals. Split into multiple planning-delegateTask calls.',
                key_data: {
                    error: 'delegate_subgoal_too_broad',
                    score: scopeAnalysis.score,
                    reasons: scopeAnalysis.reasons,
                    signals: scopeAnalysis.signals,
                    suggested_sub_goals: scopeAnalysis.suggested_sub_goals,
                },
                artifacts: [],
                next_action: 'Call planning-delegateTask once per focused sub-goal with dedicated done_criteria.',
                subtask_id: 'n/a',
            };
            return JSON.stringify(splitResult);
        }

        const result = await taskState.runSubTask(request);
        return JSON.stringify(result);
    }
}

export function createPlanningToolset(): BaseToolset {
    const toolset = new BaseToolset('planning');
    toolset.addTool(new DelegateTaskTool());
    return toolset;
}
