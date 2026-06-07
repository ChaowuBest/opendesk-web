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

import Alpine from 'alpinejs';

import '../components/agentinput.js';
import '../components/notification.js';
import '../components/permissionPrompt.ts';
import '../components/askUserPrompt.ts';
import '../components/exitPlanModePrompt.ts';
import '../components/splitter.js';
import '../components/toolbar.ts';
import '../components/taskview.js';
import '../components/sidebar.js';
import '../components/setting.js';
import '../components/settingpanel.js';
import '../components/logview.js';
import '../components/recommendation.ts';
import '../components/homepage.js';
import '../components/wizard.ts';
import '../components/schemaeditor.js';
import '../components/shortcutManager.ts';
import '../components/shortcutHelp.ts';
import './magicPointer.js';
import '../../main/applications/browser/renderer/entry.ts';
import { showConfirmModal } from '../components/confirmModal.ts';

// 本地化字符串映射
const LOCALE_STRINGS = {
    'zh-cn': {
        'setting.load.error.title': '设置加载失败',
        'setting.load.error.ok': '确定'
    },
    'en-us': {
        'setting.load.error.title': 'Settings Load Error',
        'setting.load.error.ok': 'OK'
    }
};

/**
 * 根据语言设置获取本地化字符串
 * @param {string} key - 翻译键
 * @param {string} locale - 语言设置（如 'zh-cn', 'en-us'）
 * @returns {string} - 本地化字符串
 */
function getLocalizedString(key, locale = 'en-us') {
    const strings = LOCALE_STRINGS[locale] || LOCALE_STRINGS['en-us'];
    return strings[key] || key;
}

window.Alpine = Alpine;
Alpine.start();

// 监听设置加载错误，显示自定义模态弹窗（使用本地化文本）
if (window.settingErrorAPI) {
    window.settingErrorAPI.onSettingLoadError(async (message) => {
        // 获取语言设置
        let locale = 'en-us';
        try {
            if (window.settingAPI) {
                const result = await window.settingAPI.loadSettingObject();
                if (result?.status === 'ok' && result?.data?.locale) {
                    locale = result.data.locale;
                }
            }
        } catch {
            // 获取失败时使用默认语言
        }

        await showConfirmModal({
            title: getLocalizedString('setting.load.error.title', locale),
            message: message,
            confirmText: getLocalizedString('setting.load.error.ok', locale),
            cancelText: null // 只显示确认按钮
        });
    });
}

requestAnimationFrame(() => {
    const appRoot = document.getElementById('app-root');
    if (appRoot) appRoot.style.opacity = '1';
});
