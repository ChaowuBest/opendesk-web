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

import { DuckDuckGoSearchTool } from '../../../main/applications/search/tools/duckduckgo.js';

export async function runDuckDuckGoSearchTests(): Promise<boolean> {
    console.log('\n=== 运行 DuckDuckGo 搜索工具测试 ===\n');

    // 检查是否可以连接到 DuckDuckGo
    const canConnect = await checkDuckDuckGoConnection();
    if (!canConnect) {
        console.log('⚠️ 跳过 DuckDuckGo 搜索测试: 无法连接到 DuckDuckGo 服务器（可能需要代理）');
        return true; // 无法连接时跳过测试，不算失败
    }

    try {
        const duckduckgoTool = new DuckDuckGoSearchTool();

        // 测试1: 基本搜索
        console.log('1. 测试基本搜索 - "OpenAI GPT"');
        const toolResult1 = await duckduckgoTool.execute({
            query: 'OpenAI GPT',
            count: 5,
        });
        if (toolResult1.status === 'error') {
            console.error('   ✗ 基本搜索失败:', toolResult1.result);
            return false;
        }
        console.log('   ✓ 基本搜索成功');
        console.log('   - 结果状态:', toolResult1.status);
        console.log('   - 结果预览:', toolResult1.result?.substring(0, 200) + '...\n');

        // 测试2: 中文搜索
        console.log('2. 测试中文搜索 - "人工智能发展趋势"');
        const toolResult2 = await duckduckgoTool.execute({
            query: '人工智能发展趋势',
            count: 3,
            region: 'cn-zh',
        });
        if (toolResult2.status === 'error') {
            console.error('   ✗ 中文搜索失败:', toolResult2.result);
            return false;
        }
        console.log('   ✓ 中文搜索成功');
        console.log('   - 结果状态:', toolResult2.status, '\n');

        // 测试3: 不同区域搜索
        console.log('3. 测试不同区域搜索 - "machine learning" (美国英文)');
        const toolResult3 = await duckduckgoTool.execute({
            query: 'machine learning',
            count: 3,
            region: 'us-en',
        });
        if (toolResult3.status === 'error') {
            console.error('   ✗ 区域搜索失败:', toolResult3.result);
            return false;
        }
        console.log('   ✓ 区域搜索成功');
        console.log('   - 结果状态:', toolResult3.status, '\n');

        // 测试4: 测试命令行渲染
        console.log('4. 测试命令行工具调用渲染');
        // 创建一个模拟的ToolCall对象
        const mockToolCall = {
            index: 0,
            id: 'test-id',
            tool_name: 'duckduckgoSearch',
            args_string: JSON.stringify({ query: 'TypeScript tutorial' }),
            args_object: { query: 'TypeScript tutorial', region: 'us-en' },
            status: 'success' as const,
            result: '**结果数量**: 5',
        };
        const rendered = duckduckgoTool.renderToolCallCli(mockToolCall as any, 80);
        console.log('   ✓ 渲染成功');
        console.log('   - 渲染输出行数:', rendered?.length || 0, '\n');

        // 测试5: 空关键词测试
        console.log('5. 测试空关键词处理');
        const toolResult5 = await duckduckgoTool.execute({
            query: '',
            count: 5,
        });
        if (toolResult5.status === 'error') {
            console.log('   ✓ 空关键词正确返回错误');
            console.log('   - 错误信息:', toolResult5.result, '\n');
        } else {
            console.error('   ✗ 空关键词应该返回错误');
            return false;
        }

        console.log('=== DuckDuckGo 搜索工具测试通过 ===');
        return true;
    } catch (err) {
        console.error('\n✗ DuckDuckGo 搜索工具测试失败:', err);
        return false;
    }
}

/**
 * 检查是否可以连接到 DuckDuckGo
 */
async function checkDuckDuckGoConnection(): Promise<boolean> {
    try {
        const { fetch, ProxyAgent } = await import('undici');
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);

        try {
            const fetchOptions: {
                method: string;
                signal: AbortSignal;
                dispatcher?: any;
            } = {
                method: 'HEAD',
                signal: controller.signal,
            };

            // 支持代理 - 优先使用环境变量，其次尝试常见本地代理端口
            let proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;

            // 如果没有设置环境变量，尝试检测常见代理端口
            if (!proxyUrl) {
                const commonProxies = [
                    'http://127.0.0.1:7890',  // Clash 默认端口
                    'http://127.0.0.1:10809', // v2rayN 默认端口
                    'http://127.0.0.1:1080',  // 常见 SOCKS 转 HTTP 端口
                ];

                for (const proxy of commonProxies) {
                    try {
                        const testController = new AbortController();
                        const testTimer = setTimeout(() => testController.abort(), 3000);

                        await fetch('https://html.duckduckgo.com/html/', {
                            method: 'HEAD',
                            signal: testController.signal,
                            dispatcher: new ProxyAgent(proxy),
                        });

                        clearTimeout(testTimer);
                        proxyUrl = proxy;
                        console.log(`   检测到本地代理: ${proxy}`);
                        break;
                    } catch {
                        // 继续尝试下一个代理
                    }
                }
            }

            if (proxyUrl) {
                fetchOptions.dispatcher = new ProxyAgent(proxyUrl);
            }

            const response = await fetch('https://html.duckduckgo.com/html/', fetchOptions);
            clearTimeout(timer);
            // 400 Bad Request 也算连接成功（HEAD 请求可能不被支持，但代理连接正常）
            return response.ok || response.status === 200 || response.status === 400 || response.status === 403;
        } catch {
            clearTimeout(timer);
            return false;
        }
    } catch {
        return false;
    }
}