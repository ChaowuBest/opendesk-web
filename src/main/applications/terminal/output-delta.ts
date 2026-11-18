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

import stripAnsi from 'strip-ansi';

// Live snapshots may stop before a CSI/OSC control sequence is complete.
// Keep that suffix pending so its completion never leaks into a later delta.
// 各分支的字符集必须排除 ESC：扫描长度靠「下一个 ESC」截断，放进 ESC 会退化成平方级回溯。
const INCOMPLETE_ANSI_SUFFIX = /\x1b(?:\[[0-?]*[ -/]*|\][^\x07\x1b\x9c]*(?:\x1b)?|[ -/]*)$/;

/**
 * 终端 live 输出的增量计算。
 *
 * BoundedOutputBuffer 未截断时输出只做尾部追加，快照天然以旧快照为前缀，
 * 可以只传输新增尾部；一旦发生截断（head+marker+tail 结构）或命令重跑，
 * 前缀关系被破坏，必须整体重写。渲染端以 outputReset 区分这两种情况。
 */
export interface TerminalOutputDelta {
    /** true 时 delta 携带全量文本，渲染端需整体重写输出区。 */
    reset: boolean;
    /** 本次新增的文本（reset 时为全量文本）。 */
    delta: string;
}

export function computeTerminalOutputDelta(lastSentOutput: string, currentOutput: string): TerminalOutputDelta {
    if (currentOutput === lastSentOutput) {
        return { reset: false, delta: '' };
    }
    if (!currentOutput.startsWith(lastSentOutput)) {
        return { reset: true, delta: currentOutput };
    }
    return { reset: false, delta: currentOutput.slice(lastSentOutput.length) };
}

/**
 * 计算一帧 live tick 的输出增量帧。
 *
 * 关键点：先剥离 ANSI，再在剥离后的文本上求增量。渲染端整份渲染用的是
 * stripAnsi(toolcall.result)，若增量在原始文本上切分、再逐段剥离，转义序列恰好
 * 跨 tick 边界时两头都会残留半个序列，增量拼接结果与全量渲染不一致（要等终态
 * 全量渲染才自愈）。在剥离后的文本上求增量可保证两条路径逐字一致。
 *
 * @param lastSentStripped 上一次放行的快照（已剥离 ANSI）
 * @param currentOutput    本次快照的原始文本
 */
export function computeTerminalLiveOutputFrame(
    lastSentStripped: string,
    currentOutput: string
): TerminalOutputDelta & { stripped: string } {
    // Some strip-ansi versions consume the introducer of an unfinished OSC.
    // Remove pending suffixes first, while their escape markers are still intact.
    const stripped = stripAnsi(currentOutput.replace(INCOMPLETE_ANSI_SUFFIX, ''));
    return { stripped, ...computeTerminalOutputDelta(lastSentStripped, stripped) };
}
