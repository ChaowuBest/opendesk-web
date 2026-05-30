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
import chalk from 'chalk';
import { z } from 'zod';
import { BaseAcademicSearchEngine, ACADEMIC_ENGINE_ARGS_SCHEMA } from './baseAcademicEngine';
import { ArxivSearchTool } from './arxiv';
import { DblpSearchTool } from './dblp';

export type AcademicSearchChannel = 'arxiv' | 'dblp' | 'none';

export interface AcademicChannelMeta {
    id: AcademicSearchChannel;
    name: string;
    description: string;
}

export const ACADEMIC_CHANNELS: AcademicChannelMeta[] = [
    { id: 'arxiv', name: 'arXiv', description: '学术论文预印本搜索引擎' },
    { id: 'dblp', name: 'DBLP', description: '计算机科学文献数据库' }
];

/**
 * AcademicSearch 工具对外暴露的统一 Schema。
 * 与底层引擎基类的 Schema 完全一致，AI 模型无需感知渠道差异。
 */
const AcademicSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10-15（取决于渠道）'),
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

/** arXiv → DBLP 语法前缀映射（DBLP 兼容但命名不同） */
const ARXIV_TO_DBLP_PREFIX_MAP: Record<string, string> = {
    'au:': 'author:',
    'ti:': 'title:'
};

/** arXiv 特有的语法前缀，DBLP 完全不支持，需清洗 */
const ARXIV_ONLY_PREFIXES = ['cat:', 'abs:', 'all:', 'jr:', 'rn:', 'co:'];

export class AcademicSearchTool extends BaseTool<typeof AcademicSearchArgsSchema> {
    private channel: AcademicSearchChannel;
    private delegate: BaseAcademicSearchEngine;

    private static createDelegate(channel: AcademicSearchChannel): BaseAcademicSearchEngine {
        switch (channel) {
            case 'dblp':
                return new DblpSearchTool();
            case 'arxiv':
            default:
                return new ArxivSearchTool();
        }
    }

    constructor(channel: AcademicSearchChannel) {
        super(
            'AcademicSearch',
            '使用学术搜索引擎搜索学术论文。返回论文的标题、作者、摘要、发布日期等信息。支持arXiv和DBLP搜索。',
            AcademicSearchArgsSchema
        );
        this.channel = channel;
        this.delegate = AcademicSearchTool.createDelegate(channel);
        this.setExecutor(this.search.bind(this));
    }

    // ──────────────────── 渲染 ────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        const channelName = this.channel === 'dblp' ? 'DBLP' : 'arXiv';
        return renderSearchToolCall({
            icon: 'fas fa-graduation-cap',
            title: `学术搜索 (${channelName})`,
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
            title: `学术搜索 (${this.channel === 'dblp' ? 'DBLP' : 'arXiv'})`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ──────────────────── 搜索 ────────────────────

    private async search(args: z.output<typeof AcademicSearchArgsSchema>): Promise<string> {
        const { query } = args;
        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        if (!this.delegate.executor) {
            throw new Error(`学术搜索渠道 ${this.channel} 未正确配置`);
        }

        // 由于 Facade 和引擎基类使用相同的 Schema，参数可直接透传
        const delegateArgs: Record<string, any> = {
            query,
            count: args.count,
            start: args.start,
            sort_by: args.sort_by,
            sort_order: args.sort_order
        };
        const result = await this.delegate.executor(delegateArgs);

        // DBLP 返回空结果时，分两步降级重试
        if (this.channel === 'dblp' && this.isDblpNoResult(result)) {
            // 第一步：尝试将 arXiv 语法前缀映射为 DBLP 对应语法（au: → author:, ti: → title:）
            const mappedQuery = mapArxivToDblpPrefixes(query);
            if (mappedQuery !== query) {
                delegateArgs.query = mappedQuery;
                const mappedResult = await this.delegate.executor(delegateArgs);
                if (!this.isDblpNoResult(mappedResult)) return mappedResult;
            }
            // 第二步：清洗 arXiv 特有前缀，用纯关键词重试
            const cleanedQuery = cleanArxivPrefixes(query);
            if (cleanedQuery !== query && cleanedQuery.length > 0) {
                delegateArgs.query = cleanedQuery;
                return await this.delegate.executor(delegateArgs);
            }
        }

        return result;
    }

    /** 判断 DBLP 搜索结果是否为空 */
    private isDblpNoResult(result: string): boolean {
        return result.includes('未找到与') && result.includes('相关的DBLP论文');
    }
}

/** 将 arXiv 语法前缀映射为 DBLP 对应语法（如 au: → author:） */
function mapArxivToDblpPrefixes(query: string): string {
    let mapped = query;
    for (const [arxivPrefix, dblpPrefix] of Object.entries(ARXIV_TO_DBLP_PREFIX_MAP)) {
        mapped = mapped.replace(new RegExp(arxivPrefix, 'gi'), dblpPrefix);
    }
    return mapped;
}

/** 清洗 arXiv 特有语法前缀，保留纯关键词 */
function cleanArxivPrefixes(query: string): string {
    let cleaned = query;
    for (const prefix of ARXIV_ONLY_PREFIXES) {
        cleaned = cleaned.replace(new RegExp(`${prefix}\\S+\\s*`, 'gi'), ' ');
    }
    cleaned = cleaned.trim();
    if (!cleaned) {
        for (const prefix of ARXIV_ONLY_PREFIXES) {
            cleaned = query.replace(new RegExp(`^\\s*${prefix}`, 'i'), '').trim();
            if (cleaned) break;
        }
    }
    return cleaned || query;
}
