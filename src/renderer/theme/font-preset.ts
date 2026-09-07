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
 * 字体预设（gui_config.font_preset）共享常量与纯函数。
 *
 * 预设值对应 styles/fonts.css 中 html[data-font-preset='<preset>'] 的 CSS 规则；
 * 主窗口、子应用窗口与任务浮窗都依赖同一预设值保持字体一致。
 */

/** 主进程向各窗口推送字体预设变更的 IPC 频道。 */
export const FONT_PRESET_CHANNEL = 'theme:fontPresetChanged';

/** 未设置或非法预设时的回退值（对应 fonts.css 中无覆盖规则，即默认字体栈）。 */
export const DEFAULT_FONT_PRESET = 'default';

/** 规范化字体预设：仅接受非空字符串，其余回退 default。 */
export function normalizeFontPreset(raw: unknown): string {
    return typeof raw === 'string' && raw ? raw : DEFAULT_FONT_PRESET;
}
