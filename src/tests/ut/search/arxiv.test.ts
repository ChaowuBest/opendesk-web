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

import { ArxivSearchTool } from '../../../main/applications/search/tools/arxiv';

describe('arXiv 搜索工具', () => {
    let tool: ArxivSearchTool;

    beforeAll(() => {
        tool = new ArxivSearchTool();
    });

    test('基本搜索 - "deep learning"', async () => {
        const result = await tool.execute({ query: 'deep learning', count: 3 });
        expect(result.status).not.toBe('error');
    }, 60000);

    test('特定分类搜索 - "cat:cs.AI"', async () => {
        const result = await tool.execute({
            query: 'cat:cs.AI',
            count: 2,
            sort_by: 'submittedDate',
            sort_order: 'descending'
        });
        expect(result.status).not.toBe('error');
    }, 60000);

    test('命令行渲染', () => {
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'arxivSearch',
            args_string: JSON.stringify({ query: 'machine learning' }),
            args_object: { query: 'machine learning' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = tool.renderToolCallCli(mockToolCall as any, 80);
        expect(rendered).toBeDefined();
    });
});
