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

import { escapeRegExp } from '../../common/utils/escape.js';

/** 任务名最大长度（按 Unicode 码点计），超过则截断并追加省略号 */
export const TASK_NAME_MAX_LENGTH = 30;

/** 需要保留的格式字符：ZWJ/ZWNJ，用于 emoji 组合序列与 Persian/Arabic 连字 */
const PRESERVED_FORMAT_CHARS = new Set(['\u200C', '\u200D']);

/** 截断点可能残留在末尾的字符：空白与 emoji 组合符（ZWJ/ZWNJ/变体选择符） */
const TRAILING_COMBINING_CHARS = new Set([' ', '\u200C', '\u200D', '\uFE0E', '\uFE0F']);

/**
 * 清洗任务名文本：折叠空白、剔除控制字符（`\p{Cc}`）与格式字符（`\p{Cf}`，含零宽空白与
 * 双向控制符）、裁剪首尾。
 *
 * 这些不可见字符会被侧栏、TUI、导出 HTML 原样渲染（双向控制符甚至能让文本显示顺序颠倒）；
 * ZWJ/ZWNJ 例外保留，见 {@link PRESERVED_FORMAT_CHARS}。
 */
function sanitizeTaskNameText(text: string): string {
    return text
        .replace(/\s+/g, ' ')
        .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (PRESERVED_FORMAT_CHARS.has(ch) ? ch : ''))
        .trim();
}

/**
 * 将候选任务名清洗并截断到统一长度。
 *
 * - 连续空白折叠为单个空格，首尾裁剪，避免任务名在列表中折行显示
 * - 按 Unicode 码点截断，避免把 emoji 等代理对截半产生乱码
 * - 发生截断时追加 "..." 省略号；截断点落在空白或组合符上时先裁掉尾部残片
 */
export function truncateTaskName(text: string): string {
    const compact = sanitizeTaskNameText(text);
    const chars = Array.from(compact);
    if (chars.length <= TASK_NAME_MAX_LENGTH) {
        return compact;
    }
    const truncated = chars.slice(0, TASK_NAME_MAX_LENGTH);
    // 截断点可能落在空白或 emoji 组合序列内部，裁掉这些尾部残片再补省略号，否则会显示成乱码
    while (truncated.length > 0 && TRAILING_COMBINING_CHARS.has(truncated[truncated.length - 1])) {
        truncated.pop();
    }
    // 全是组合符（如连续 ZWJ）时裁完只剩省略号，因此返回空串表示"没有可用名称"
    return truncated.length > 0 ? `${truncated.join('')}...` : '';
}

/**
 * 生成任务名 prompt 里的格式占位文本。
 *
 * 小模型偶尔会把这段占位文字原样照抄成任务名，因此 prompt 与可用性判定必须共用同一常量，
 * 后续改 prompt 措辞时判定规则会自动跟随。
 */
export const TASK_NAME_PROMPT_PLACEHOLDER = '任务名称';

/** 占位符字面量比较键：只保留字母与数字，抹平引号/括号/markdown 强调、下划线与连字符等包裹差异 */
function placeholderKey(text: string): string {
    return text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
}

/**
 * prompt / 工具 schema 里给任务名占位的标签称呼。
 *
 * 模型常把它们当成标题前缀复读（`任务名称：修复登录`、`子任务标题 - 重构解析器`），
 * 只按整体等值比较拦不住，因此这里额外按"标签 + 分隔符"剥掉前导部分。
 */
const TASK_NAME_LABEL_PREFIXES = [TASK_NAME_PROMPT_PLACEHOLDER, '子任务标题'];

/**
 * 模型只写占位文字时可能原样输出的字面量（按 {@link placeholderKey} 归一化后比较）：
 * 上述标签本身，及其常见的英文/下划线转写。
 */
const PLACEHOLDER_TASK_NAMES = new Set([
    'generatedtaskname',
    'taskname',
    ...TASK_NAME_LABEL_PREFIXES.map((label) => placeholderKey(label))
]);

/** 前导标签前缀：标签 + 分隔符（冒号/横线，全角与半角；允许重复如"——"） */
const TASK_NAME_LABEL_PREFIX_PATTERN = new RegExp(
    `^(?:${TASK_NAME_LABEL_PREFIXES.map((label) => escapeRegExp(label)).join('|')})\\s*[:：\\-—–－]+\\s*`
);

/**
 * 规范化大模型生成的任务名，不可用时返回 null。
 *
 * 快模型/小模型偶尔会把 prompt 里的格式占位符照抄回来（`{generated_task_name}`、`"任务名称"` 之类），
 * 把占位标签当标题前缀带上（`任务名称：修复登录`），或者只输出省略号、标签残片。
 * 这类内容一旦落库就不会再自愈，因此统一判定为不可用，
 * 由调用方决定回退策略（用户消息截断名或"未命名"占位名）。
 *
 * 返回值已按 {@link truncateTaskName} 的约定清洗并截断，非空，可直接写入 task_name。
 */
export function normalizeGeneratedTaskName(name: string | null | undefined): string | null {
    let candidate = name ? sanitizeTaskNameText(name) : '';
    if (!candidate) {
        return null;
    }
    // 模型把占位标签当标题前缀复读时（"任务名称：修复登录"），剥掉前导标签留下的才是真名；
    // 循环处理连续复读，剥完为空（"任务名称："）说明模型只写了标签。
    // 循环体自带终止条件：匹配到相同文本即退出，避免正则出现零宽匹配时死循环
    for (;;) {
        const stripped = candidate.replace(TASK_NAME_LABEL_PREFIX_PATTERN, '');
        if (stripped === candidate) {
            break;
        }
        candidate = stripped;
    }
    if (!candidate) {
        return null;
    }
    // 整体是一个花括号（含全角）包裹的单段模板占位符，如 {generated_task_name}；
    // 内部含空格的不算（如 "{ctx} 与 {env}"），那是真实名称而非占位符。
    // 放在剥前缀之后判定，避免 "任务名称：{子任务标题}" 这类组合漏网
    if (/^[{｛][^{}｛｝\s]{1,40}[}｝]$/.test(candidate)) {
        return null;
    }
    // 占位符字面量本身，如 generated_task_name、任务名称（含被引号/括号包裹的转写）
    if (PLACEHOLDER_TASK_NAMES.has(placeholderKey(candidate))) {
        return null;
    }
    // 纯符号/省略号/纯 emoji（"..."、"…"、"---"、"🎉"）：没有任何字母、数字或汉字
    if (!/[\p{L}\p{N}]/u.test(candidate)) {
        return null;
    }
    // 标签残片：模型把 <taskname> 标签本身写进了标签内部
    if (/<\/?taskname>/i.test(candidate)) {
        return null;
    }
    // 与用户输入回退路径共用同一长度约定，避免模型给出长句时把任务名撑爆；
    // 截断后可能只剩空串（前面全是组合符），这种情况下同样按不可用处理
    return truncateTaskName(candidate) || null;
}
