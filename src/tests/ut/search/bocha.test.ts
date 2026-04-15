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

import { BochaSearchTool } from '../../../main/applications/search/tools/bocha';

const apiKey = process.env.BOCHA_API_KEY;

const describeIfKey = apiKey ? describe : describe.skip;

describeIfKey('博查搜索工具', () => {
    let tool: BochaSearchTool;

    beforeAll(() => {
        tool = new BochaSearchTool(apiKey!);
    });

    test('基本搜索 - "阿里巴巴 ESG报告"', async () => {
        const result = await tool.execute({ query: '阿里巴巴 ESG报告', count: 5 });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('带摘要搜索 - "人工智能发展趋势"', async () => {
        const result = await tool.execute({
            query: '人工智能发展趋势',
            count: 3,
            summary: true
        });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('时间范围筛选 - "OpenAI 最新动态" (一周内)', async () => {
        const result = await tool.execute({
            query: 'OpenAI 最新动态',
            count: 3,
            freshness: 'oneWeek'
        });
        expect(result.status).not.toBe('error');
    }, 30000);

    test('命令行渲染', () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'bochaSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
    });
});
