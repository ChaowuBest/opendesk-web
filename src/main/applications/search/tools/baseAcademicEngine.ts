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

import { SearchPresentationTool } from './presentation.js';
import { ToolCall } from '../../../aikernel/messages';
import { Card } from '../../../tui/components/card';
import { statusDisplay, truncText } from '../../../tui/components/toolcall';
import { renderSearchToolCall } from './render';
import chalk from 'chalk';
import { z } from 'zod';

/**
 * 学术搜索引擎统一参数 Schema。
 * 对外统一暴露这组参数，各引擎内部自行适配（忽略不支持的字段）。
 */
export const ACADEMIC_ENGINE_ARGS_SCHEMA = z.object({
    query: z.string().describe('搜索关键词'),
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

export type AcademicEngineArgs = z.output<typeof ACADEMIC_ENGINE_ARGS_SCHEMA>;

/** 学术论文搜索结果 */
export interface AcademicPaper {
    title: string;
    authors: string[];
    year: string;
    venue: string;
    doi: string;
    url: string;
    summary?: string;
    published?: string;
    updated?: string;
    categories?: string[];
}

/**
 * 学术搜索引擎基类。
 * 子类只需提供引擎元信息 + 实现 doSearch()，渲染和格式化由基类统一处理。
 */
export abstract class BaseAcademicSearchEngine extends SearchPresentationTool<typeof ACADEMIC_ENGINE_ARGS_SCHEMA> {
    /** 引擎显示名称（如 "arXiv"、"DBLP"） */
    protected abstract engineName: string;

    /** GUI 渲染图标 */
    protected abstract guiIcon: string;

    /** CLI 渲染图标 */
    protected abstract cliIcon: string;

    constructor(name: string, description: string) {
        super(name, description, ACADEMIC_ENGINE_ARGS_SCHEMA);
        this.setExecutor(this._executeSearch.bind(this));
    }

    // ──────────────────── 公共渲染 ────────────────────

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: this.guiIcon,
            title: `${this.engineName} 论文搜索`,
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
            icon: this.cliIcon,
            title: `${this.engineName}论文搜索`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    // ──────────────────── 搜索入口 ────────────────────

    private async _executeSearch(args: AcademicEngineArgs): Promise<string> {
        const { query } = args;
        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }
        return this.doSearch(args);
    }

    /** 子类实现：执行具体搜索并返回格式化结果 */
    protected abstract doSearch(args: AcademicEngineArgs): Promise<string>;

    // ──────────────────── 公共辅助 ────────────────────

    /** 安全地将字段值转为字符串并去空格（兼容 DBLP API 返回数组/对象的情况） */
    protected static safeStr(value: any): string {
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'number') return String(value);
        if (Array.isArray(value))
            return value
                .map((v: any) => BaseAcademicSearchEngine.safeStr(v))
                .filter(Boolean)
                .join(', ');
        if (value && typeof value === 'object' && value.text) return String(value.text).trim();
        return '';
    }

    /**
     * 格式化搜索结果为统一的 Markdown 格式。
     * 子类可调用此方法来输出一致的结果格式。
     */
    protected formatResults(query: string, papers: AcademicPaper[]): string {
        let output = `## ${this.engineName} 论文搜索结果\n`;
        output += `**搜索词**: ${query}\n`;
        output += `**结果数量**: ${papers.length}\n\n`;

        for (const p of papers) {
            output += `- 论文标题： ${p.title}\n`;
            if (p.authors.length > 0) {
                output += `  - 作者: ${p.authors.join(', ')}\n`;
            }
            if (p.year) {
                output += `  - 年份: ${p.year}\n`;
            }
            if (p.venue) {
                output += `  - 会议/期刊: ${p.venue}\n`;
            }
            if (p.published) {
                output += `  - 发布日期: ${p.published}\n`;
            }
            if (p.updated) {
                output += `  - 更新日期: ${p.updated}\n`;
            }
            if (p.categories && p.categories.length > 0) {
                output += `  - 分类: ${p.categories.join(', ')}\n`;
            }
            if (p.doi) {
                output += `  - DOI: ${p.doi}\n`;
            }
            if (p.url) {
                output += `  - 链接: ${p.url}\n`;
            }
            if (p.summary) {
                output += `  - 摘要: <summary>${p.summary}</summary>\n`;
            }
            output += '\n';
        }

        return output;
    }
}
