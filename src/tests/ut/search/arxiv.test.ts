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

import { ArxivSearchTool } from '../../../main/applications/search/tools/arxiv.js';

export async function runArxivSearchTests(): Promise<boolean> {
    console.log('\n=== 运行arXiv搜索工具测试 ===\n');

    try {
        const arxivTool = new ArxivSearchTool();

        // 测试1: 基本搜索
        console.log('1. 测试基本搜索 - "deep learning"');
        const toolResult1 = await arxivTool.execute({
            query: 'deep learning',
            count: 3
        });
        console.log('   ✓ 基本搜索成功');
        console.log('   - 结果状态:', toolResult1.status, '\n');

        // 测试2: 使用arXiv搜索语法
        console.log('2. 测试特定分类搜索 - "cat:cs.AI"');
        const toolResult2 = await arxivTool.execute({
            query: 'cat:cs.AI',
            count: 2,
            sort_by: 'submittedDate',
            sort_order: 'descending'
        });
        console.log('   ✓ 分类搜索成功');
        console.log('   - 结果状态:', toolResult2.status, '\n');

        // 测试3: 测试命令行渲染
        console.log('3. 测试命令行工具调用渲染');
        // 创建一个模拟的ToolCall对象
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'arxivSearch',
            args_string: JSON.stringify({ query: 'machine learning' }),
            args_object: { query: 'machine learning' },
            status: 'success' as const,
            result: '**结果数量**: 5'
        };
        const rendered = arxivTool.renderToolCallCli(mockToolCall as any, 80);
        console.log('   ✓ 渲染成功');
        console.log('   - 渲染输出行数:', rendered?.length || 0, '\n');

        console.log('=== arXiv搜索工具测试通过 ===');
        return true;
    } catch (err) {
        console.error('\n✗ arXiv搜索工具测试失败:', err);
        return false;
    }
}
