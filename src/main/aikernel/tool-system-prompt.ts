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

import { logger } from '../utils/logger.js';
import type { TaskState } from './states/tasks.js';
import type { BaseToolset, ToolSystemPromptContribution } from './tool.js';

/** Collect contributions from already-filtered toolsets, replacing duplicate ids with the last value. */
export function collectToolSystemPromptContributions(
    toolsets: readonly BaseToolset[],
    taskState?: TaskState
): ToolSystemPromptContribution[] {
    const contributions = new Map<string, ToolSystemPromptContribution>();
    for (const toolset of toolsets) {
        for (const tool of toolset.tools.values()) {
            let contribution: ToolSystemPromptContribution | undefined;
            try {
                contribution = tool.getSystemPromptContribution(taskState);
            } catch (error) {
                // 单个工具的 prompt 贡献失败只降级为无贡献，不能阻断整个 system prompt 的构建。
                logger.warn(`failed to collect system prompt contribution from tool ${tool.name}: ${error}`);
                continue;
            }
            if (!contribution) continue;
            const id = contribution.id.trim();
            const content = contribution.content.trim();
            if (!id || !content) continue;
            contributions.set(id, { id, content });
        }
    }
    return [...contributions.values()];
}
