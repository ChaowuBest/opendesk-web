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

function installBrowserFocusDomainIsolation() {
    const browserScopeSelector = 'browser-entry-widget,[data-od-browser-focus-scope]';
    const focusableSelector = [
        'a[href]',
        'area[href]',
        'button',
        'input',
        'select',
        'textarea',
        'iframe',
        'webview',
        '[contenteditable="true"]',
        '[tabindex]'
    ].join(',');

    function isElement(el) {
        return !!el && el.nodeType === Node.ELEMENT_NODE;
    }

    function isVisible(el) {
        if (!isElement(el)) return false;
        if (el.closest('[hidden],[inert]')) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
        return el.getClientRects().length > 0;
    }

    function isFocusable(el) {
        if (!isElement(el) || !isVisible(el)) return false;
        const tag = String(el.tagName || '').toLowerCase();
        if (el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        if (tag === 'input' && String(el.type || '').toLowerCase() === 'hidden') return false;
        return el.tabIndex >= 0;
    }

    function collectFocusable(root, out) {
        const nodes = root.querySelectorAll ? root.querySelectorAll(focusableSelector) : [];
        for (let i = 0; i < nodes.length; i += 1) {
            const node = nodes[i];
            if (isFocusable(node)) out.push(node);
            if (node.shadowRoot) collectFocusable(node.shadowRoot, out);
        }
    }

    function orderedFocusableElements() {
        const out = [];
        collectFocusable(document.body || document.documentElement, out);
        return out
            .map((el, index) => ({ el, index, tabIndex: el.tabIndex || 0 }))
            .sort((a, b) => {
                const aPositive = a.tabIndex > 0;
                const bPositive = b.tabIndex > 0;
                if (aPositive && bPositive && a.tabIndex !== b.tabIndex) return a.tabIndex - b.tabIndex;
                if (aPositive !== bPositive) return aPositive ? -1 : 1;
                return a.index - b.index;
            })
            .map((item) => item.el);
    }

    function getBrowserScopes() {
        return Array.from(document.querySelectorAll(browserScopeSelector)).filter(isVisible);
    }

    function isInsideScope(el, scopes) {
        if (!el || !el.nodeType) return false;
        return scopes.some((scope) => scope === el || scope.contains(el));
    }

    function activeElementIndex(focusables, active) {
        if (!active) return -1;
        let index = focusables.indexOf(active);
        if (index >= 0) return index;
        index = focusables.findIndex((el) => el === active || el.contains(active));
        return index;
    }

    function wrapIndex(index, length) {
        if (length <= 0) return -1;
        if (index < 0) return length - 1;
        if (index >= length) return 0;
        return index;
    }

    function findNextOutsideScope(focusables, startIndex, reverse, scopes) {
        let index = wrapIndex(startIndex, focusables.length);
        for (let i = 0; i < focusables.length; i += 1) {
            const el = focusables[index];
            if (!isInsideScope(el, scopes)) return el;
            index = wrapIndex(index + (reverse ? -1 : 1), focusables.length);
        }
        return null;
    }

    function focusElement(el) {
        try {
            el.focus({ preventScroll: true });
        } catch {
            el.focus();
        }
    }

    document.addEventListener(
        'keydown',
        (event) => {
            if (event.defaultPrevented || event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) {
                return;
            }

            const scopes = getBrowserScopes();
            if (scopes.length === 0) return;

            const target = event.composedPath?.()[0] || event.target;
            const active = document.activeElement;
            if (isInsideScope(target, scopes) || isInsideScope(active, scopes)) return;

            const focusables = orderedFocusableElements();
            if (focusables.length === 0) return;

            const activeIndex = activeElementIndex(focusables, active);
            if (activeIndex < 0) return;

            const direction = event.shiftKey ? -1 : 1;
            const nextIndex = wrapIndex(activeIndex + direction, focusables.length);
            const next = focusables[nextIndex];
            if (!isInsideScope(next, scopes)) return;

            const replacement = findNextOutsideScope(focusables, nextIndex + direction, event.shiftKey, scopes);
            event.preventDefault();
            event.stopPropagation();
            if (replacement) focusElement(replacement);
        },
        true
    );
}

installBrowserFocusDomainIsolation();

// 窗口可见性标志：组件可据此跳过非必要渲染以省电
window.__isWindowVisible = true;
window.addEventListener('openDesk:visibilityChanged', (e) => {
    window.__isWindowVisible = !!e.detail;
});

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
