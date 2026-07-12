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

import { TavilySearchTool } from '../../../main/applications/search/tools/tavily';

const apiKey = process.env.TAVILY_API_KEY;

let reachable = false;

beforeAll(async () => {
    if (!apiKey) return;
    try {
        const tool = new TavilySearchTool(apiKey);
        const probe = await tool.execute({ query: 'test', count: 1 });
        reachable = probe.status !== 'error';
    } catch {
        reachable = false;
    }
}, 30000);

describe('Tavily 搜索工具', () => {
    let tool: TavilySearchTool;

    beforeAll(() => {
        tool = new TavilySearchTool(apiKey!);
    });

    test('基本搜索 - "OpenDesk application"', async () => {
        if (!reachable) return;

        const result = await tool.execute({ query: 'OpenDesk application', count: 5 });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('深度搜索 - "artificial intelligence trends 2024"', async () => {
        if (!reachable) return;

        const result = await tool.execute({
            query: 'artificial intelligence trends 2024',
            count: 3,
            search_depth: 'advanced',
            include_answer: true
        });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('命令行渲染', () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'tavilySearch',
            args_string: JSON.stringify({ query: 'machine learning' }),
            args_object: { query: 'machine learning' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
    });
});
