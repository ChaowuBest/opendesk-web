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
 * CJK 字符的 token 权重：跨主流 tokenizer 的折中估计
 * （DeepSeek 官方口径 ≈0.6 token/字，GPT cl100k ≈1.0 token/字）。
 * 以 7/10 整数分子形式参与计算，避免 0.7 浮点累加导致 ceil 多出 1。
 */
const CJK_TOKEN_WEIGHT_NUMERATOR = 7;
const CJK_TOKEN_WEIGHT_DENOMINATOR = 10;
/** 非 CJK 字符的 token 权重：约 4 字符 1 token（2 的幂，整数乘法后精确）。 */
const OTHER_TOKEN_WEIGHT = 0.25;

/** CJK 相关 Unicode 区段：符号标点、假名、统一表意文字及扩展 A、谚文、兼容表意、全角形式。 */
const CJK_CODE_POINT_RANGES: ReadonlyArray<readonly [number, number]> = [
    [0x3000, 0x303f],
    [0x3040, 0x30ff],
    [0x3400, 0x4dbf],
    [0x4e00, 0x9fff],
    [0xac00, 0xd7af],
    [0xf900, 0xfaff],
    [0xff00, 0xffef]
];

function isCjkCharCode(code: number): boolean {
    for (const [start, end] of CJK_CODE_POINT_RANGES) {
        if (code >= start && code <= end) return true;
        if (code < start) break;
    }
    return false;
}

export function estimateTextTokens(text: string | undefined): number {
    if (!text) {
        return 0;
    }
    // 扩展 B 之后的罕见表意字以代理对形式出现，两个代理项均落入 ASCII 权重，
    // 单字误差 <1 token，不值得为此引入 codePointAt 的索引步进复杂度
    let cjkCount = 0;
    let otherCount = 0;
    for (let i = 0; i < text.length; i++) {
        if (isCjkCharCode(text.charCodeAt(i))) cjkCount++;
        else otherCount++;
    }
    return Math.ceil(
        (cjkCount * CJK_TOKEN_WEIGHT_NUMERATOR) / CJK_TOKEN_WEIGHT_DENOMINATOR + otherCount * OTHER_TOKEN_WEIGHT
    );
}
