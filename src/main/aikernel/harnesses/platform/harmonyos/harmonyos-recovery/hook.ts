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

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GlobalHooks } from '../../../../hooks.js';
import type { ToolCall } from '../../../../messages.js';
import type { TaskState } from '../../../../states/tasks.js';
import { BASH_FRICTION_WINDOW_SIZE, BASH_FRICTION_FAILURE_THRESHOLD } from '../constants.js';
import { ReadableDirectoryRegistry } from '../../../../security/enforcer.js';

// 从当前模块向上查找 resources/knowledges/harmonyos-recovery/
function resolveKbDir(): string {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        const candidate = path.join(dir, 'resources', 'knowledges', 'harmonyos-recovery');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return 'resources/knowledges/harmonyos-recovery';
}

const KB_DIR = resolveKbDir();

const HARMONYOS_BASH_FRICTION_PROMPT = `当前任务在 OpenHarmony 上执行，并已在最近 ${BASH_FRICTION_WINDOW_SIZE} 次 Bash 执行中累计出现 ${BASH_FRICTION_FAILURE_THRESHOLD} 次失败。

HarmonyOS 下常见错误的症状可能与 Linux 相同，但安装、依赖、工具链和系统能力等解决方式可能不同。

继续尝试前，请查看 ${KB_DIR} 下的知识库文档：从 README.md 总索引开始，沿分类链接逐层定位最匹配的条目，不要一次读取全部文档。如果知识库未覆盖该问题，明确说明未命中。

- 这只是基于 Bash 失败密度的提示，不是对错误原因的平台归因。如果当前问题明显属于项目代码、测试或业务逻辑，或者你已经查询过该知识库，可以忽略此提示并继续当前路线。

- 若问题来自 HarmonyOS PC 环境差异且多次尝试解决仍然失败，可切换到 Headless Node 的 Linux 环境执行。`;

type BashOutcome = 'success' | 'failure';
type BashOutcomesByTask = WeakMap<TaskState, BashOutcome[]>;

/**
 * 创建 executeBash 的 afterToolCall 回调。
 *
 * 回调在每次 Bash 执行完成后被调用，根据 exitCode 判定成功 (0) 或失败 (非 0)，
 * 将结果记入以 TaskState 为键的滑动窗口。当窗口内失败数达到阈值时，通过
 * appendInternalUserMessage 向模型注入一条内部提示（用户不可见），引导其查询
 * HarmonyOS 错误处理知识库，随后清空窗口以避免连续重复触发。
 */
export function createHarmonyosBashFrictionAfterToolCall(
    outcomesByTask: BashOutcomesByTask = new WeakMap()
): (task: TaskState, toolCall: ToolCall) => Promise<void> {
    return async (task, toolCall) => {
        const exitCode = (toolCall.result_object as { exitCode?: unknown } | undefined)?.exitCode;
        if (!Number.isInteger(exitCode)) {
            return;
        }

        const outcomes = outcomesByTask.get(task) ?? [];
        outcomes.push(exitCode === 0 ? 'success' : 'failure');
        if (outcomes.length > BASH_FRICTION_WINDOW_SIZE) {
            outcomes.shift();
        }
        outcomesByTask.set(task, outcomes);

        const failureCount = outcomes.filter((outcome) => outcome === 'failure').length;
        if (failureCount < BASH_FRICTION_FAILURE_THRESHOLD) {
            return;
        }

        outcomesByTask.delete(task);
        try {
            await task.appendInternalUserMessage(HARMONYOS_BASH_FRICTION_PROMPT);
        } catch {
            // 提示失败不能影响原始 Bash 工具结果。
        }
    };
}

/**
 * 注册 HarmonyOS Bash 摩擦检测 hook。
 *
 * 注册两个回调：
 * - afterToolCall (executeBash)：滑动窗口统计失败次数，达到阈值后注入知识库查询提示。
 * - afterFinishTurn：任务结束或中断时清理对应的滑动窗口状态。
 *
 * 调用方负责在非 openharmony 平台跳过注册。
 */
export function registerHarmonyosBashFrictionHook(): void {
    // 将知识库目录注册为可读目录，避免读取时触发权限弹窗
    if (fs.existsSync(KB_DIR)) {
        ReadableDirectoryRegistry.getInstance().register(KB_DIR);
    }

    const outcomesByTask: BashOutcomesByTask = new WeakMap();
    GlobalHooks.registerToolHook('executeBash', {
        afterToolCall: createHarmonyosBashFrictionAfterToolCall(outcomesByTask)
    });
    GlobalHooks.afterFinishTurn(({ task }) => {
        if (task.lastTerminationState === 'finished' || task.lastTerminationState === 'interrupted') {
            outcomesByTask.delete(task);
        }
    });
}
