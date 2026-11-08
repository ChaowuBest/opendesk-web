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
 * 归一化换行符：将 \r\n 和 \r 统一为 \n。
 *
 * 文件内容与工具调用参数的比较必须先在 LF 口径下进行：editFile 在 CRLF 文件上写回时会把结果
 * 还原成 CRLF，而工具调用参数（oldString/newString/content）永远是 LF，两侧不归一化就匹配不到。
 * 归一化只替换换行符、不改变行数，因此基于它算出的行号与原文件一致。
 */
export function normalizeLineEndings(text: string): string {
    return text.replace(/\r\n|\r/g, '\n');
}

/**
 * 计算两个字符串的编辑距离（Levenshtein distance）。
 * 仅用于工具名近拼写容错，字符串很短，直接做完整 DP 即可。
 */
export function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    // 保证 a 为较短字符串，减少内存占用
    if (a.length > b.length) {
        [a, b] = [b, a];
    }

    let prev: number[] = [];
    for (let j = 0; j <= b.length; j++) {
        prev[j] = j;
    }
    for (let i = 1; i <= a.length; i++) {
        const cur: number[] = [i];
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(
                prev[j] + 1, // 删除
                cur[j - 1] + 1, // 插入
                prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // 替换
            );
        }
        prev = cur;
    }
    return prev[b.length];
}
