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

import { BochaSearchTool } from '../../../main/applications/search/tools/bocha.js';

export async function runBochaSearchTests(): Promise<boolean> {
    console.log('\n=== 运行博查搜索工具测试 ===\n');

    const apiKey = process.env.BOCHA_API_KEY;
    if (!apiKey) {
        console.log('⚠️ 跳过博查搜索测试: 未设置环境变量 BOCHA_API_KEY');
        return true; // 没有API Key时跳过测试，不算失败
    }

    try {
        const bochaTool = new BochaSearchTool(apiKey);

        // 测试1: 基本搜索
        console.log('1. 测试基本搜索 - "阿里巴巴 ESG报告"');
        const toolResult1 = await bochaTool.execute({
            query: '阿里巴巴 ESG报告',
            count: 5,
        });
        if (toolResult1.status === 'error') {
            console.error('   ✗ 基本搜索失败:', toolResult1.result);
            return false;
        }
        console.log('   ✓ 基本搜索成功');
        console.log('   - 结果状态:', toolResult1.status, '\n');

        // 测试2: 带摘要的搜索
        console.log('2. 测试带摘要搜索 - "人工智能发展趋势"');
        const toolResult2 = await bochaTool.execute({
            query: '人工智能发展趋势',
            count: 3,
            summary: true,
        });
        if (toolResult2.status === 'error') {
            console.error('   ✗ 带摘要搜索失败:', toolResult2.result);
            return false;
        }
        console.log('   ✓ 带摘要搜索成功');
        console.log('   - 结果状态:', toolResult2.status, '\n');

        // 测试3: 时间范围筛选
        console.log('3. 测试时间范围筛选 - "OpenAI 最新动态" (一周内)');
        const toolResult3 = await bochaTool.execute({
            query: 'OpenAI 最新动态',
            count: 3,
            freshness: 'oneWeek',
        });
        if (toolResult3.status === 'error') {
            console.error('   ✗ 时间范围筛选搜索失败:', toolResult3.result);
            return false;
        }
        console.log('   ✓ 时间范围筛选搜索成功');
        console.log('   - 结果状态:', toolResult3.status, '\n');

        // 测试4: 测试命令行渲染
        console.log('4. 测试命令行工具调用渲染');
        // 创建一个模拟的ToolCall对象
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'bochaSearch',
            args_string: JSON.stringify({ query: '机器学习' }),
            args_object: { query: '机器学习' },
            status: 'success' as const,
            result: '**结果数量**: 5',
        };
        const rendered = bochaTool.renderToolCallCli(mockToolCall as any, 80);
        console.log('   ✓ 渲染成功');
        console.log('   - 渲染输出行数:', rendered?.length || 0, '\n');

        console.log('=== 博查搜索工具测试通过 ===');
        return true;
    } catch (err) {
        console.error('\n✗ 博查搜索工具测试失败:', err);
        return false;
    }
}