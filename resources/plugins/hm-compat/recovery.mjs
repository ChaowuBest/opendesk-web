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

/**
 * HarmonyOS 排障知识库摩擦检测（hm-compat 插件的一部分，由 index.mjs 接线）。
 *
 * 通过 plugin SDK hook 实现：
 * - shell.execute.after（bash/zsh）：滑动窗口统计失败次数，达到阈值后把知识库
 *   查询提示追加到工具结果，引导模型查询插件内置的 harmonyos-recovery 知识库；
 * - permission.ask：知识库目录内的 file:read 自动放行，避免读取时触发权限弹窗
 *   （替代宿主侧 ReadableDirectoryRegistry 注册）。
 */

import path from 'path';

// Bash 摩擦检测滑动窗口大小：跟踪近期 Bash/Zsh 执行成败的窗口长度。
export const BASH_FRICTION_WINDOW_SIZE = 5;

// Bash 摩擦检测失败阈值：窗口内失败次数达到此值时触发提示。
export const BASH_FRICTION_FAILURE_THRESHOLD = 2;

/**
 * 注册 HarmonyOS 排障知识库摩擦检测 hook。
 *
 * @param {import('@bitclub.ai/opendesk-plugin-sdk').PluginContext} context
 */
export function setupRecovery(context) {
    const kbDir = path.resolve(context.pluginDir, 'harmonyos-recovery');

    /** 判断 target 是否位于 root 目录内（含 root 自身） */
    const isPathInside = (root, target) => {
        if (typeof target !== 'string' || target === '') return false;
        const resolved = path.resolve(target);
        return resolved === root || resolved.startsWith(root + path.sep);
    };

    const outcomesByTask = new Map();

    context.hooks.on('shell.execute.after', (input, output) => {
        // OpenHarmony 上 terminal 应用优先注册 executeZsh（zsh 交互模式），bash 仅为回退，
        // 两种 shell 的失败都必须计入同一窗口
        if (input.shellType !== 'bash' && input.shellType !== 'zsh') return;
        // returnCode 为 null 表示结果对象中无退出码（如执行器异常），不计入统计
        if (!Number.isInteger(input.returnCode)) return;

        const outcomes = outcomesByTask.get(input.taskId) ?? [];
        outcomes.push(input.returnCode === 0 ? 'success' : 'failure');
        if (outcomes.length > BASH_FRICTION_WINDOW_SIZE) {
            outcomes.shift();
        }
        outcomesByTask.set(input.taskId, outcomes);

        const failureCount = outcomes.filter((outcome) => outcome === 'failure').length;
        if (failureCount < BASH_FRICTION_FAILURE_THRESHOLD) return;

        // 清空窗口以避免连续重复触发
        outcomesByTask.delete(input.taskId);
        output.result += `\n\n当前任务在 OpenHarmony 上执行，并已在最近 ${BASH_FRICTION_WINDOW_SIZE} 次 Bash/Zsh 执行中累计出现 ${BASH_FRICTION_FAILURE_THRESHOLD} 次失败。

HarmonyOS 下常见错误的症状可能与 Linux 相同，但安装、依赖、工具链和系统能力等解决方式可能不同。

继续尝试前，请查看 ${kbDir} 下的知识库文档：从 README.md 总索引开始，沿分类链接逐层定位最匹配的条目，不要一次读取全部文档。如果知识库未覆盖该问题，明确说明未命中。

- 这只是基于 Bash/Zsh 失败密度的提示，不是对错误原因的平台归因。如果当前问题明显属于项目代码、测试或业务逻辑，或者你已经查询过该知识库，可以忽略此提示并继续当前路线。

- 若问题来自 HarmonyOS PC 环境差异且多次尝试解决仍然失败，可切换到 Headless Node 的 Linux 环境执行。`;
    });

    context.hooks.on('permission.ask', (input, output) => {
        // 知识库目录内的 file:read 放行；混合其他请求时维持询问
        const allKbReads =
            input.requests.length > 0 &&
            input.requests.every(
                (request) =>
                    request.resourceType === 'file' &&
                    request.action === 'read' &&
                    isPathInside(kbDir, request.resourcePath)
            );
        if (allKbReads) {
            output.decision = 'allow';
        }
    });
}
