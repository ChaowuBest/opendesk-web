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

import { BaseTool } from '../../../aikernel/tool';
import { ToolCall } from '../../../aikernel/messages';
import { Card } from '../../../tui/components/card';
import { statusDisplay, truncText } from '../../../tui/components/toolcall';
import { renderSearchToolCall } from './render';
import { t } from '../../../../locale/index.js';
import chalk from 'chalk';
import { z } from 'zod';
import { ArxivSearchTool } from './arxiv';

export type AcademicSearchChannel = 'arxiv' | 'none';

export interface AcademicChannelMeta {
    id: AcademicSearchChannel;
    name: string;
    description: string;
}

export const ACADEMIC_CHANNELS: AcademicChannelMeta[] = [
    { id: 'arxiv', name: 'arXiv', description: '学术论文搜索引擎' }
];

const AcademicSearchArgsSchema = z.object({
    query: z
        .string()
        .describe(
            '搜索关键词，可以使用arxiv的搜索语法，如标题搜索：ti:keyword，摘要搜索：abs:keyword，作者搜索：au:name，分类搜索：cat:cs.AI等'
        ),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10'),
    start: z.number().optional().describe('搜索结果的起始偏移量，用于分页，默认为0'),
    sort_by: z
        .enum(['relevance', 'lastUpdatedDate', 'submittedDate'])
        .optional()
        .describe(
            '排序方式：relevance（相关性）、lastUpdatedDate（最后更新日期）、submittedDate（提交日期），默认为relevance'
        ),
    sort_order: z
        .enum(['ascending', 'descending'])
        .optional()
        .describe('排序顺序：ascending（升序）、descending（降序），默认为descending')
});

export class AcademicSearchTool extends BaseTool<typeof AcademicSearchArgsSchema> {
    private channel: AcademicSearchChannel;
    private delegate: ArxivSearchTool;

    constructor(channel: AcademicSearchChannel) {
        super(
            'AcademicSearch',
            '使用学术搜索引擎搜索学术论文。返回论文的标题、作者、摘要、发布日期等信息。支持arXiv搜索语法。',
            AcademicSearchArgsSchema
        );
        this.channel = channel;
        this.delegate = new ArxivSearchTool();
        this.setExecutor(this.search.bind(this));
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-graduation-cap',
            title: `学术搜索 (${this.channel === 'arxiv' ? 'arXiv' : this.channel})`,
            toolcall,
            query,
            resultCountExtractor: (result) => {
                const match = result.match(/\*\*结果数量\*\*:\s*(\d+)/);
                return match ? `${match[1]} 篇论文` : null;
            }
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const query = toolcall.args_object?.['query'];
        const body: string[] = [];

        if (query) {
            body.push(chalk.dim('关键词: ') + chalk.cyan(`"${truncText(String(query), width - 16)}"`));
        }

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const match = toolcall.result.match(/\*\*结果数量\*\*:\s*(\d+)/);
            if (match) {
                body.push(chalk.dim('  找到 ') + chalk.white(match[1]) + chalk.dim(' 篇论文'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '📄',
            title: '学术搜索 (arXiv)',
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof AcademicSearchArgsSchema>): Promise<string> {
        const { query } = args;
        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        if (this.delegate.executor) {
            const delegateArgs: Record<string, any> = {
                query,
                count: args.count,
                start: args.start,
                sort_by: args.sort_by,
                sort_order: args.sort_order
            };
            return await this.delegate.executor(delegateArgs);
        }
        throw new Error(`学术搜索渠道 ${this.channel} 未正确配置`);
    }
}
