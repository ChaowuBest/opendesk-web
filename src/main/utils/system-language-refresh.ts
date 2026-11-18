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

import { createRequire } from 'module';
import {
    getLocale,
    getRuntimePreferredSystemLanguages,
    setRuntimePreferredSystemLanguages
} from '../../locale/index.js';

const require = createRequire(import.meta.url);

export interface SystemLanguageRefreshOutcome {
    /** 本次刷新取到的最新系统首选语言列表 */
    languages: string[];
    /** 本次刷新前后生效语言（getLocale() 返回值）是否发生变化；首次注入（无旧缓存）恒为 false */
    languageChanged: boolean;
    /** languageChanged 为 true：调用方应同步 Worker 并广播 locale 变更让各界面切换语言 */
    shouldBroadcast: boolean;
}

/**
 * 取一次最新系统首选语言：OpenHarmony bridge 优先（refreshOhosSystemLanguage
 * 顺带刷新 system-theme 的语言缓存），bridge 不可用（非 ohos 平台或调用失败）
 * 时退化 Electron app API。electron 与 system-theme 延迟 require：
 * 避免测试环境加载原生模块。
 */
export async function queryLatestPreferredSystemLanguages(): Promise<string[]> {
    try {
        const { refreshOhosSystemLanguage } = require('../../platforms/bridges/harmonyos/system-theme.js') as {
            refreshOhosSystemLanguage?: () => Promise<string>;
        };
        const bridgeLanguage = await refreshOhosSystemLanguage?.();
        if (bridgeLanguage) {
            return [bridgeLanguage];
        }
    } catch {
        // bridge 不可用：退化 Electron API
    }
    try {
        const electron = require('electron') as {
            app?: {
                getPreferredSystemLanguages?: () => string[];
            };
        };
        const languages = electron.app?.getPreferredSystemLanguages?.();
        return Array.isArray(languages) ? languages : [];
    } catch {
        return [];
    }
}

/**
 * 刷新主进程注入的系统首选语言缓存：app ready 时注入一次、主窗口 focus 时调用本函数刷新，
 * getLocale()/t() 的 auto 解析只读这份缓存，与 Worker 的注入机制保持一致，
 * 不再每次翻译都查询系统语言。
 *
 * 变更判定按生效语言比较（getLocale() 前后取值）：语言设置显式且可用时生效语言不随系统
 * 语言变化，天然不触发广播；语言设置为 auto 或为语言包卸载后的残留值（二者都按系统语言
 * 解析）时，解析结果变化即视为变更。列表形状变化（如 bridge tag 与 Electron 列表互转）
 * 但生效语言不变时不视为变更。
 */
export async function refreshRuntimePreferredSystemLanguages(
    fetchLanguages: () => Promise<string[]> = queryLatestPreferredSystemLanguages
): Promise<SystemLanguageRefreshOutcome> {
    const languages = await fetchLanguages();
    if (languages.length === 0) {
        // 查询失败/无结果：保留现有缓存不覆盖（避免一次瞬时失败清掉启动注入值），
        // 生效语言维持原状，不触发变更判定
        return { languages, languageChanged: false, shouldBroadcast: false };
    }
    const previous = getRuntimePreferredSystemLanguages();
    // 首次注入（previous 为 null）只预热缓存不做变更判定：此时 UI 展示的解析值本就来自
    // 同一系统语言回退链，且短路保证预热路径不触发 Setting 读取
    const previousLocale = previous ? getLocale() : null;
    setRuntimePreferredSystemLanguages(languages);
    const languageChanged = previousLocale !== null && previousLocale !== getLocale();
    return {
        languages,
        languageChanged,
        shouldBroadcast: languageChanged
    };
}
