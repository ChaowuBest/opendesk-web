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
 * 推理深度 (reasoning_effort) 的可选值与文案。
 * 存储层使用空字符串表示「模型默认」；TUI `/reason effort` 子命令用 `default` 作为别名。
 *
 * 注意：此文件被 renderer（浏览器）和 main（Node.js）同时引用，
 * 不能在此引入依赖 Node.js API 的模块（如 locale/index.js）。
 * TUI 侧的本地化通过 REASONING_EFFORT_LABEL_KEYS + t() 在消费端实现。
 */

/** 写入设置/API 的值（空字符串 = 模型默认） */
export const REASONING_EFFORT_STORAGE_VALUES = ['', 'none', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningEffortStorageValue = (typeof REASONING_EFFORT_STORAGE_VALUES)[number];

/** 非默认（''）档位值，用于 model-context 等场景描述「模型支持的推理档位」 */
export const REASONING_EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'max'] as const;

export type ReasoningEffortLevel = (typeof REASONING_EFFORT_LEVELS)[number];

/** storage value → locale key，供 TUI 侧 t() 查找 */
export const REASONING_EFFORT_LABEL_KEYS: Record<string, string> = {
    '': 'reasoning.effort.default',
    none: 'reasoning.effort.none',
    low: 'reasoning.effort.low',
    medium: 'reasoning.effort.medium',
    high: 'reasoning.effort.high',
    max: 'reasoning.effort.max'
};

/** 默认中文标签（renderer 等无 i18n 环境使用） */
const REASONING_EFFORT_DEFAULT_LABELS: Record<string, string> = {
    '': '默认',
    none: '无推理',
    low: '简洁推理',
    medium: '推理适中',
    high: '推理深入',
    max: '推理最大化'
};

/** Select / 表单 options 用的值列表，顺序与 UI 一致 */
export const REASONING_EFFORT_SELECT_VALUES: string[] = [...REASONING_EFFORT_STORAGE_VALUES];

/**
 * 根据模型支持的档位列表构建 UI 值列表（始终以 '' 默认项开头）。
 * - 未提供 levels 时返回系统全部档位；
 * - 提供的档位必须是系统档位的子集，非法值会被忽略。
 */
export function buildSupportedEffortValues(levels: readonly string[] | undefined): string[] {
    const result: string[] = [''];
    for (const level of REASONING_EFFORT_LEVELS) {
        if (!levels || levels.includes(level)) {
            result.push(level);
        }
    }
    return result;
}

/** 渲染层下拉等：{ value, label }（不带 i18n，renderer 使用） */
export const REASONING_EFFORT_UI_OPTIONS: { value: string; label: string }[] = REASONING_EFFORT_STORAGE_VALUES.map(
    (value) => ({
        value,
        label: REASONING_EFFORT_DEFAULT_LABELS[value] ?? value
    })
);

/** `/reason effort` 使用的 token（与存储值对应，default → ''） */
export const REASONING_EFFORT_CLI_TOKENS = ['default', 'none', 'low', 'medium', 'high', 'max'] as const;

export const REASONING_EFFORT_CLI_TO_STORAGE: Record<string, string> = {
    default: '',
    none: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high',
    max: 'max'
};

/**
 * 获取本地化的 reasoning effort 标签（需要传入 t 函数）。
 * TUI / main process 侧使用。
 */
export function getReasoningEffortLabels(translator: (key: string) => string): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const [storageVal, localeKey] of Object.entries(REASONING_EFFORT_LABEL_KEYS)) {
        labels[storageVal] = translator(localeKey);
    }
    return labels;
}

/**
 * 获取存储值对应的本地化标签文案。
 * @param stored - 存储的 reasoning_effort 值
 * @param translator - 可选的 t() 翻译函数；未提供时使用默认中文标签
 */
export function labelForStoredReasoningEffort(stored: string, translator?: (key: string) => string): string {
    if (translator) {
        const key = REASONING_EFFORT_LABEL_KEYS[stored];
        return key ? translator(key) : stored;
    }
    return REASONING_EFFORT_DEFAULT_LABELS[stored] ?? stored;
}
