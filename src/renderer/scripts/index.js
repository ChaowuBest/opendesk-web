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

import '../components/loading.js';
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
import '../components/memory_panel.ts';
import '../components/personal_center.ts';
import '../components/accountpanel.ts';
import '../components/logview.js';
import '../components/recommendation.ts';
import '../components/homepage.js';
import '../components/wizard.ts';
import '../components/schemaeditor.js';
import '../components/shortcutManager.ts';
import '../components/shortcutHelp.ts';
import '../components/agentgate-floating-window.js';
import '../components/trashFloatingWindow.ts';
import '../components/desktop/entry.ts';
import '../../main/applications/browser/renderer/entry.ts';
import { showConfirmModal, showCloseDialog } from '../components/confirmModal.ts';
import { initializeSidebarLayout } from '../sidebarLayout.ts';
import { showBlacklistPrompt } from '../components/blacklistPrompt.ts';
import { createRendererTranslator } from '../locale.ts';
import { routeTaskFileOpenRequest } from './taskFileRouting.ts';
import { installQuickCaptureInbox } from './quickcaptureInbox.ts';
import { NativeBridgeProxy } from '../../platforms/bridges/renderer.js';
import { handleTaskViewLinkClick } from '../utils/task-view-links.js';

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

// 暴露翻译器实例给 index.html 内联脚本使用
window.__odT = createRendererTranslator();
(async () => {
    try {
        const settings = await window.settingAPI.loadSettingObject();
        window.__odT = createRendererTranslator(settings);
    } catch {
        /* fallback to browser locale */
    }
})();
window.settingAPI?.onSettingChanged?.((settings) => {
    window.__odT = createRendererTranslator(settings);
    updateUpdateReadyButton(latestUpdateState);
});

// 启动时把持久化的快速截图开关同步给原生侧（原生侧不持久化，默认开启）
(async () => {
    try {
        if (window.systemInfo?.isOpenHarmony !== true && window.systemInfo?.isWindows !== true) return;
        const settings = await window.settingAPI.loadSettingObject();
        if (settings?.gui_config?.quick_capture_enabled === false) {
            await new NativeBridgeProxy().getQuickCaptureKit().then((kit) => kit.setEnabled(false));
        }
    } catch {
        /* 同步失败时保持原生默认开启 */
    }
})();

let latestUpdateState = null;
function updateUpdateReadyButton(state) {
    latestUpdateState = state;
    const updateReadyButton = document.getElementById('update-ready-btn');
    if (!updateReadyButton) return;
    updateReadyButton.hidden = state?.status !== 'installed';
    if (state?.status !== 'installed') return;
    const t = window.__odT || createRendererTranslator();
    const label = t('update.available.button', { version: state.version });
    const text = t('update.available.short');
    updateReadyButton.title = label;
    updateReadyButton.setAttribute('aria-label', label);
    const visibleLabel = updateReadyButton.querySelector('.update-ready-text');
    if (visibleLabel) visibleLabel.textContent = text;
}

const updateReadyButton = document.getElementById('update-ready-btn');
// 软件更新区块在通用设置里（第一个区块），点标题栏入口直接落到通用设置
updateReadyButton?.addEventListener('click', () => window.globalControlAPI?.openSettingEditor({ tab: 'general' }));
window.updateAPI?.onStateChanged(updateUpdateReadyButton);
window.updateAPI
    ?.getState()
    .then(updateUpdateReadyButton)
    .catch(() => {});
window.officeHostAPI?.onOpenOfficeTaskFile?.((request) => {
    const routed = routeTaskFileOpenRequest(document, request, (requestId) => {
        window.officeHostAPI?.reportOpenOfficeTaskFileResult?.(requestId, 'not_opened');
    });
    if (!routed) {
        window.officeHostAPI?.reportOpenOfficeTaskFileResult?.(request.requestId, 'failed');
    }
});

/**
 * 全局拦截 <a> 链接点击，在侧边栏内置浏览器中预览外部链接，
 * 避免主窗口导航到外部 URL 导致灰屏。
 *
 * 逻辑：找到链接所属的 <task-view>，调用其 openUrlInSidebar() 方法
 * 展开侧边栏 → 切换到浏览器 tab → 导航到目标 URL。
 */
document.addEventListener('click', handleTaskViewLinkClick, true);
document.addEventListener('auxclick', handleTaskViewLinkClick, true);

// Alt+Space 快速截图发送后，主窗口获得焦点时把截图投递到新任务输入框。
installQuickCaptureInbox();

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
initializeSidebarLayout();

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

// 监听恶意技能黑名单提示
if (window.skillBlacklistAPI) {
    window.skillBlacklistAPI.onBlacklistPrompt((data) => {
        showBlacklistPrompt(data);
    });
}

// 监听 AgentGate 存储超限提醒：主进程低频轮询检测到本地记录超阈值时，弹确认框提示清理。
// 确认后删除全部 tool_calls + 清空拦截记录（实际删除走 worker 进程）。
if (window.agentgateStorageAPI) {
    window.agentgateStorageAPI.onStorageOversize(async (data) => {
        if (!data) return;
        const t = window.__odT || ((k) => k);
        const thresholdMB = Number(data.thresholdMB ?? 100);
        const totalMB = Number(data.totalMB ?? 0);
        const toolCalls = Number(data.toolCalls ?? 0);
        const confirmed = await showConfirmModal({
            icon: 'fa-database',
            iconBg: '#FFF7ED',
            iconColor: '#EA580C',
            title: t('agentgate.storageOversize.title'),
            message: t('agentgate.storageOversize.message')
                .replace('{threshold}', String(thresholdMB))
                .replace('{total}', String(totalMB))
                .replace('{count}', String(toolCalls)),
            confirmText: t('agentgate.storageOversize.cleanup'),
            cancelText: t('agentgate.storageOversize.later'),
            danger: true
        });
        if (!confirmed) return;
        try {
            await window.agentgateStorageAPI.cleanupAll();
        } catch (err) {
            console.error('[StorageOversize] cleanup failed:', err);
        }
    });
}

// 转发「等待用户输入」状态到主进程，供任务状态悬浮窗显示「需要操作」提示。
document.addEventListener('task-waiting-state', (event) => {
    const { taskId, waiting } = event.detail || {};
    if (taskId) {
        window.taskStatusWidgetAPI?.notifyWaitingForInput(taskId, !!waiting);
    }
});

// 监听主窗口关闭确认请求，显示自定义模态弹窗
if (window.closeWindowAPI) {
    window.closeWindowAPI.onCloseWindowRequest(async (requestId) => {
        const settings = await window.settingAPI.loadSettingObject();
        const t = createRendererTranslator(settings);
        const result = await showCloseDialog({
            title: t('main.closeDialog.title'),
            message: t('main.closeDialog.message'),
            cancelText: t('main.closeDialog.cancel'),
            minimizeText: t('main.closeDialog.minimize'),
            quitText: t('main.closeDialog.quit'),
            dontAskText: t('main.closeDialog.dontAsk'),
            dontAskHint: t('main.closeDialog.dontAskHint')
        });
        window.closeWindowAPI.respondCloseWindow(requestId, result);
    });
}

function waitForInitialHomeContent() {
    const homePage = document.getElementById('home-page');
    if (!homePage || homePage.firstElementChild) return Promise.resolve();

    return new Promise((resolve) => {
        const observer = new MutationObserver(() => {
            if (!homePage.firstElementChild) return;
            observer.disconnect();
            resolve();
        });
        observer.observe(homePage, { childList: true });
    });
}

async function revealStartupShell() {
    await Promise.all([
        customElements.whenDefined('splitter-widget'),
        customElements.whenDefined('main-sidebar'),
        customElements.whenDefined('home-page')
    ]);
    await waitForInitialHomeContent();

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            const appRoot = document.getElementById('app-root');
            if (!appRoot) return;

            const startupShell = document.getElementById('startup-shell');
            appRoot.removeAttribute('inert');
            appRoot.removeAttribute('aria-hidden');
            appRoot.style.opacity = '1';

            if (!startupShell) return;
            const removeStartupShell = () => startupShell.remove();
            startupShell.addEventListener('transitionend', removeStartupShell, { once: true });
            startupShell.classList.add('startup-shell-hidden');
            window.setTimeout(removeStartupShell, 250);
        });
    });
}

void revealStartupShell();
