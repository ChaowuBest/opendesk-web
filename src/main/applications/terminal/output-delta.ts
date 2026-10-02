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
