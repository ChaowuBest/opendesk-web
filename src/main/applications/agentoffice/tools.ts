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
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { PermissionRequest } from '../../aikernel/security/permission.js';
import { t } from '../../../locale/index.js';
import type { HistoryQuery } from './common.js';

const SendReplySchema = z
    .object({
        text: z.string().optional().describe(t('agentoffice.tool.sendReply.textArg')),
        files: z.array(z.string()).optional().default([]).describe(t('agentoffice.tool.sendReply.filesArg'))
    })
    .refine((value) => Boolean(value.text?.trim()) || value.files.length > 0, {
        message: t('agentoffice.tool.sendReply.requiredArg')
    });

const GetHistoryMessagesSchema = z
    .object({
        mode: z.enum(['recent', 'time_range']),
        limit: z.number().int().min(1).max(200).optional().default(50),
        start_time: z.string().min(1).optional(),
        end_time: z.string().min(1).optional(),
        cursor: z.string().optional()
    })
    .superRefine((value, context) => {
        if (value.mode !== 'time_range') return;
        if (!value.start_time) {
            context.addIssue({
                code: 'custom',
                path: ['start_time'],
                message: t('agentoffice.error.invalidHistoryQuery')
            });
        }
        if (!value.end_time) {
            context.addIssue({
                code: 'custom',
                path: ['end_time'],
                message: t('agentoffice.error.invalidHistoryQuery')
            });
        }
    });

class SendReplyTool extends BaseTool<typeof SendReplySchema> {
    constructor(
        private readonly sendReply: (text: string | undefined, files: string[], taskState?: TaskState) => Promise<void>
    ) {
        super('sendReply', t('agentoffice.tool.sendReply.description'), SendReplySchema);
        this.setExecutor(async (args, taskState) => {
            await this.sendReply(args.text, args.files, taskState);
            return t('agentoffice.tool.sendReply.success');
        });
    }

    getDeclaredPermissions(args: z.output<typeof SendReplySchema>): PermissionRequest[] {
        return (args.files ?? []).map((filePath) => ({
            resourceType: 'file',
            action: 'read',
            resourcePath: filePath
        }));
    }
}

class GetHistoryMessagesTool extends BaseTool<typeof GetHistoryMessagesSchema> {
    constructor(private readonly getHistory: (query: HistoryQuery) => Promise<unknown>) {
        super('getHistoryMessages', t('agentoffice.tool.getHistory.description'), GetHistoryMessagesSchema);
        this.setExecutor(async (args) => {
            const cursor = args.cursor ? { cursor: args.cursor } : {};
            const query: HistoryQuery =
                args.mode === 'recent'
                    ? { mode: 'recent', limit: args.limit, ...cursor }
                    : {
                          mode: 'time_range',
                          start_time: args.start_time!,
                          end_time: args.end_time!,
                          limit: args.limit,
                          ...cursor
                      };
            return JSON.stringify(await this.getHistory(query));
        });
    }
}

export function createAgentOfficeTaskToolset(options: {
    sendReply: (text: string | undefined, files: string[], taskState?: TaskState) => Promise<void>;
    getHistory: (query: HistoryQuery) => Promise<unknown>;
}): BaseToolset {
    const toolset = new BaseToolset('agentoffice');
    toolset.addTool(new SendReplyTool(options.sendReply));
    toolset.addTool(new GetHistoryMessagesTool(options.getHistory));
    return toolset;
}
