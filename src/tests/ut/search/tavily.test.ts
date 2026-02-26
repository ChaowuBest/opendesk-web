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

import { TavilySearchTool } from '../../../main/applications/search/tools/tavily.js';

export async function runTavilySearchTests(): Promise<boolean> {
    console.log('\n=== 运行Tavily搜索工具测试 ===\n');

    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
        console.log('⚠️ 跳过Tavily搜索测试: 未设置环境变量 TAVILY_API_KEY');
        return true; // 没有API Key时跳过测试，不算失败
    }

    try {
        const tavilyTool = new TavilySearchTool(apiKey);

        // 测试1: 基本搜索
        console.log('1. 测试基本搜索 - "OpenDesk application"');
        const toolResult1 = await tavilyTool.execute({
            query: 'OpenDesk application',
            count: 5,
        });
        console.log('   ✓ 基本搜索成功');
        console.log('   - 结果状态:', toolResult1.status, '\n');

        // 测试2: 深度搜索
        console.log('2. 测试深度搜索 - "artificial intelligence trends 2024"');
        const toolResult2 = await tavilyTool.execute({
            query: 'artificial intelligence trends 2024',
            count: 3,
            search_depth: 'advanced',
            include_answer: true,
        });
        console.log('   ✓ 深度搜索成功');
        console.log('   - 结果状态:', toolResult2.status, '\n');

        // 测试3: 测试命令行渲染
        console.log('3. 测试命令行工具调用渲染');
        // 创建一个模拟的ToolCall对象
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'tavilySearch',
            args_string: JSON.stringify({ query: 'machine learning' }),
            args_object: { query: 'machine learning' },
            status: 'success' as const,
            result: '**结果数量**: 5',
        };
        const rendered = tavilyTool.renderToolCallCli(mockToolCall as any, 80);
        console.log('   ✓ 渲染成功');
        console.log('   - 渲染输出行数:', rendered?.length || 0, '\n');

        console.log('=== Tavily搜索工具测试通过 ===');
        return true;
    } catch (err) {
        console.error('\n✗ Tavily搜索工具测试失败:', err);
        return false;
    }
}