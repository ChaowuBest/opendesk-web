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

import type { Command } from 'commander';
import { setPlatform } from '../../../platforms/base.js';
import { CliPlatform } from '../../../platforms/cli.js';
import { useConsoleTransport } from '../../utils/logger.js';
import { initializeRegistry, ApplicationRegistry } from '../../applications/registry.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { BaseTool, BaseToolset } from '../../aikernel/tool.js';
import { SkillRegistry } from '../../aikernel/skill.js';
import { createMemoryToolset } from '../../aikernel/memory/tools.js';
import { createMainPlanningToolset } from '../../aikernel/planning/tools.js';
import type { z } from 'zod';
import process from 'process';

/**
 * 收集 shellagent 可使用的全部工具集（与 TaskState.buildToolsets 保持一致）。
 */
async function collectAllToolsets(): Promise<BaseToolset[]> {
    setPlatform(new CliPlatform());
    GlobalState.initialize();
    initializeRegistry();

    const appToolsets = await ApplicationRegistry.listAvailableToolsets();
    const skillToolset = SkillRegistry.getInstance().getToolset();
    const memoryToolset = createMemoryToolset();
    const planningToolset = createMainPlanningToolset();
    return [...appToolsets, skillToolset, memoryToolset, planningToolset];
}

function findTool(toolsets: BaseToolset[], toolName: string): { tool: BaseTool<z.ZodType>; toolsetName: string } | undefined {
    for (const toolset of toolsets) {
        const tool = toolset.getTool(toolName);
        if (tool) {
            return { tool, toolsetName: toolset.name };
        }
    }
    return undefined;
}

export function registerToolsCommand(prog: Command): void {
    const toolsCmd = prog.command('tools').description('工具管理与调试');

    toolsCmd
        .command('list')
        .description('列出所有可用工具')
        .action(async () => {
            useConsoleTransport();
            const toolsets = await collectAllToolsets();
            for (const toolset of toolsets) {
                console.log(`\n[${toolset.name}]`);
                for (const [name, tool] of toolset.getTools()) {
                    const desc = tool.description.length > 80
                        ? tool.description.slice(0, 77) + '...'
                        : tool.description;
                    console.log(`  ${name}  -  ${desc}`);
                }
            }
            process.exit(0);
        });

    toolsCmd
        .command('info <toolName>')
        .description('显示工具详细信息')
        .action(async (toolName: string) => {
            useConsoleTransport();
            const toolsets = await collectAllToolsets();
            const found = findTool(toolsets, toolName);
            if (!found) {
                console.error(`未找到工具: ${toolName}`);
                process.exit(1);
                return;
            }
            const { tool, toolsetName } = found;
            console.log(`名称:      ${tool.name}`);
            console.log(`描述:      ${tool.description}`);
            console.log(`所在Bundle: ${toolsetName}`);
            console.log(`执行方式:   ${tool.universalExecutor ? 'universalExecutor (流式)' : tool.executor ? 'executor' : '(无)'}`);
            console.log(`InputSchema:`);
            console.log(JSON.stringify(tool.params.toJSONSchema(), null, 2));
            process.exit(0);
        });

    toolsCmd
        .command('call <toolName> [argsJson]')
        .description('调用工具并打印结果')
        .action(async (toolName: string, argsJson?: string) => {
            useConsoleTransport();
            const toolsets = await collectAllToolsets();
            const found = findTool(toolsets, toolName);
            if (!found) {
                console.error(`未找到工具: ${toolName}`);
                process.exit(1);
                return;
            }

            let args: Record<string, unknown> = {};
            if (argsJson) {
                try {
                    args = JSON.parse(argsJson);
                } catch {
                    console.error(`参数解析失败，请传入合法的 JSON 字符串`);
                    process.exit(1);
                    return;
                }
            }

            const { tool, toolsetName } = found;
            console.log(`--- 调用工具: ${toolName} (${toolsetName}) ---`);
            console.log(`参数: ${JSON.stringify(args, null, 2)}`);
            console.log(`---`);

            let chunkIndex = 0;
            const result = await tool.execute(args, (toolResult) => {
                chunkIndex++;
                console.log(`[chunk #${chunkIndex}] status=${toolResult.status}`);
                if (toolResult.result) {
                    console.log(toolResult.result);
                }
                if (toolResult.result_object) {
                    console.log(JSON.stringify(toolResult.result_object, null, 2));
                }
            });

            console.log(`\n--- 执行完成 ---`);
            console.log(`状态: ${result.status}`);
            if (result.result) {
                console.log(`结果:`);
                console.log(result.result);
            }
            if (result.result_object) {
                console.log(`结果对象:`);
                console.log(JSON.stringify(result.result_object, null, 2));
            }
            process.exit(result.status === 'error' ? 1 : 0);
        });
}
