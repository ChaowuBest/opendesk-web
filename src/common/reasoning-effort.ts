/**
 * 推理深度 (reasoning_effort) 的可选值与中文文案。
 * 存储层使用空字符串表示「模型默认」；TUI `/reason effort` 子命令用 `default` 作为别名。
 */

/** 写入设置/API 的值（空字符串 = 模型默认） */
export const REASONING_EFFORT_STORAGE_VALUES = ['', 'none', 'low', 'medium', 'high'] as const;

export type ReasoningEffortStorageValue = (typeof REASONING_EFFORT_STORAGE_VALUES)[number];

/** 存储值 -> 展示文案（配置表单、状态栏、命令输出等） */
export const REASONING_EFFORT_LABELS: Record<string, string> = {
    '': '默认',
    none: '无推理',
    low: '简洁推理',
    medium: '推理适中',
    high: '推理深入'
};

/** Select / 表单 options 用的值列表，顺序与 UI 一致 */
export const REASONING_EFFORT_SELECT_VALUES: string[] = [...REASONING_EFFORT_STORAGE_VALUES];

/** 渲染层下拉等：{ value, label } */
export const REASONING_EFFORT_UI_OPTIONS: { value: string; label: string }[] = REASONING_EFFORT_STORAGE_VALUES.map(
    (value) => ({
        value,
        label: REASONING_EFFORT_LABELS[value] ?? value
    })
);

/** `/reason effort` 使用的 token（与存储值对应，default → ''） */
export const REASONING_EFFORT_CLI_TOKENS = ['default', 'none', 'low', 'medium', 'high'] as const;

export const REASONING_EFFORT_CLI_TO_STORAGE: Record<string, string> = {
    default: '',
    none: 'none',
    low: 'low',
    medium: 'medium',
    high: 'high'
};

export function labelForStoredReasoningEffort(stored: string): string {
    return REASONING_EFFORT_LABELS[stored] ?? stored;
}
