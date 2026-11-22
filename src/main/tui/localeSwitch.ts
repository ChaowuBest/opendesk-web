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

import { setLocale, setRuntimeLocale } from '../../locale/index.js';
import { isValidLocaleSetting } from '../../common/locale.js';

/**
 * 语言切换后需要按新语言重刷界面文案的宿主（TUI 实现 refreshLocalizedTexts）。
 * 用结构类型而非直接依赖 OpenDeskTUI，避免 commands / config 与 entry 形成运行时循环。
 */
export interface LocalizedTextsRefresher {
    refreshLocalizedTexts(): void;
}

/** applyLanguageSetting 的结果：区分「值非法」与「写盘失败」，调用方需要给出不同提示 */
export type ApplyLanguageResult = 'ok' | 'invalid' | 'save-failed';

/**
 * 应用界面语言设置：写设置 -> 清运行时覆盖 -> 重刷界面文案。
 *
 * 顺序不能颠倒：`--language` 写入的运行时覆盖优先级高于设置，必须先写设置。
 * 这样写盘失败（Setting.save 会抛错）时覆盖仍在，界面不会莫名回退到旧的设置值；
 * 写成功后再清覆盖，新设置才真正对 getLocale() 生效。
 *
 * 校验口径与 setLocale 一致（合法 BCP-47 tag 或 auto），语言是否已安装由调用方限定。
 * 写盘失败在此收口：语言切换不应该以未捕获异常的形式打断 TUI 主循环。
 */
export function applyLanguageSetting(host: LocalizedTextsRefresher, locale: string): ApplyLanguageResult {
    if (!isValidLocaleSetting(locale)) return 'invalid';
    try {
        setLocale(locale);
    } catch {
        // 设置未写入，内存配置与运行时覆盖都保持原样
        return 'save-failed';
    }
    setRuntimeLocale(null);
    host.refreshLocalizedTexts();
    return 'ok';
}
