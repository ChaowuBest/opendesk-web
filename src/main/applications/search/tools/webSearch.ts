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
import { renderSearchToolCall, extractResultCount } from './render';
import chalk from 'chalk';
import { z } from 'zod';
import { BingSearchTool } from './bing';
import { DuckDuckGoSearchTool } from './duckduckgo';
import { BraveSearchTool } from './brave';
import { TavilySearchTool } from './tavily';
import { BochaSearchTool } from './bocha';
import { ExaSearchTool } from './exa';
import { BaiduSearchTool } from './baidu';

/** 所有 Web 搜索渠道的标识 */
export type WebSearchChannel = 'tavily' | 'bing' | 'duckduckgo' | 'brave' | 'bocha' | 'exa' | 'baidu';

/** 渠道元信息 */
export interface WebChannelMeta {
    id: WebSearchChannel;
    name: string;
    description: string;
    needsApiKey: boolean;
}

export const WEB_CHANNELS: WebChannelMeta[] = [
    { id: 'duckduckgo', name: 'DuckDuckGo', description: '注重隐私的免费搜索引擎', needsApiKey: false },
    { id: 'bing', name: 'Bing', description: '免费的网页搜索引擎', needsApiKey: false },
    { id: 'baidu', name: '百度', description: '中文网页搜索引擎，自动过滤广告', needsApiKey: false },
    { id: 'tavily', name: 'Tavily', description: '专为AI设计的搜索引擎', needsApiKey: true },
    { id: 'brave', name: 'Brave', description: '隐私优先的搜索引擎', needsApiKey: true },
    { id: 'bocha', name: '博查', description: '专为AI设计的中文搜索引擎', needsApiKey: true },
    { id: 'exa', name: 'Exa', description: 'AI驱动的搜索引擎', needsApiKey: true }
];

const WebSearchArgsSchema = z.object({
    query: z.string().describe('搜索关键词'),
    count: z.number().optional().describe('期望返回的搜索结果数量，默认为10-15（取决于渠道）')
});

/** WebSearchTool 从宿主应用读取配置的接口，避免循环依赖 */
export interface WebSearchAppConfig {
    getEffectiveWebSearchChannel(): WebSearchChannel;
    getChannelApiKey(channel: string): string;
    getBingLang(): 'zh' | 'en';
}

export class WebSearchTool extends BaseTool<typeof WebSearchArgsSchema> {
    private channel: WebSearchChannel;
    private appConfig: WebSearchAppConfig;
    private delegate: BaseTool<any>;

    constructor(appConfig: WebSearchAppConfig) {
        super(
            'WebSearch',
            '使用搜索引擎搜索网页信息。返回搜索结果的标题、URL和摘要。当前使用的搜索引擎由用户配置决定。',
            WebSearchArgsSchema
        );
        this.appConfig = appConfig;
        this.channel = appConfig.getEffectiveWebSearchChannel();
        this.delegate = this.createDelegate();
        this.setExecutor(this.search.bind(this));
    }

    private createDelegate(): BaseTool<any> {
        switch (this.channel) {
            case 'tavily':
                return new TavilySearchTool(this.appConfig.getChannelApiKey('tavily'));
            case 'bing':
                return new BingSearchTool(this.appConfig.getBingLang());
            case 'duckduckgo':
                return new DuckDuckGoSearchTool();
            case 'brave':
                return new BraveSearchTool(this.appConfig.getChannelApiKey('brave'));
            case 'bocha':
                return new BochaSearchTool(this.appConfig.getChannelApiKey('bocha'));
            case 'exa':
                return new ExaSearchTool(this.appConfig.getChannelApiKey('exa'));
            case 'baidu':
                return new BaiduSearchTool();
            default:
                return new BingSearchTool(this.appConfig.getBingLang());
        }
    }

    private getChannelLabel(): string {
        const meta = WEB_CHANNELS.find((c) => c.id === this.channel);
        return meta ? meta.name : this.channel;
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const query = toolcall.args_object?.['query'] as string | undefined;
        return renderSearchToolCall({
            icon: 'fas fa-magnifying-glass',
            title: `搜索 (${this.getChannelLabel()})`,
            toolcall,
            query,
            resultCountExtractor: extractResultCount
        });
    }

    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const query = toolcall.args_object?.['query'];
        const body: string[] = [];

        if (query) {
            body.push(chalk.dim('关键词: ') + chalk.cyan(`"${truncText(String(query), width - 16)}"`));
        }
        body.push(chalk.dim('渠道: ') + chalk.yellow(this.getChannelLabel()));

        if (toolcall.status === 'running') {
            body.push(chalk.dim('  ⏳ 搜索中…'));
        } else if (toolcall.status === 'success' && toolcall.result) {
            const match = toolcall.result.match(/\*\*结果数量\*\*:\s*(\d+)/);
            if (match) {
                body.push(chalk.dim('  找到 ') + chalk.white(match[1]) + chalk.dim(' 条结果'));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔍',
            title: `搜索 (${this.getChannelLabel()})`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }

    private async search(args: z.output<typeof WebSearchArgsSchema>): Promise<string> {
        const { query } = args;
        if (!query || query.trim().length === 0) {
            throw new Error('搜索关键词不能为空');
        }

        // 委托给具体渠道的 executor
        if (this.delegate.executor) {
            // 构造兼容的参数对象
            const delegateArgs: Record<string, any> = { query };
            if (args.count !== undefined) {
                delegateArgs.count = args.count;
            }
            return await this.delegate.executor(delegateArgs);
        }
        throw new Error(`搜索渠道 ${this.channel} 未正确配置`);
    }
}
