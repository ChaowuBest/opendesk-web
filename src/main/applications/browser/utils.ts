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
 * OpenDesk 浏览器工具函数。
 *
 * 包含与 OpenDesk UI 设计（task-view、侧边栏等）强绑定的逻辑。
 * embedBrowserUse 公共库通过 BrowserScriptGenerators 接口注入使用。
 */

import type { BrowserScriptGenerators } from '../../../common/embedBrowserUse/main.js';

/**
 * 生成用于在 renderer 中确保 task-view / 侧边栏已准备好的 JS 代码片段。
 */
export function makeEnsureSidebarScript(taskId: string): string {
    const safeId = taskId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `
        if (window.globalControlAPI && typeof window.globalControlAPI.ensureTaskViewExists === 'function') {
            window.globalControlAPI.ensureTaskViewExists('${safeId}');
        }
        var el = document.getElementById('task-${safeId}-artifacts');
        if (el) {
            var tv = el.closest('task-view');
            var taskViewIsHidden = tv && (tv.hasAttribute('data-background') || tv.style.display === 'none');
            var initialBrowserUse = typeof el.consumeInitialBrowserAutoReveal === 'function'
                ? el.consumeInitialBrowserAutoReveal()
                : false;
            var shouldAutoReveal = !taskViewIsHidden && initialBrowserUse;
            if (tv && initialBrowserUse && taskViewIsHidden && typeof el.markPendingBrowserAutoReveal === 'function') {
                // 后台首次 Browser Use：仅按任务记录大屏预览期望，待用户切回任务时生效，
                // 不打断当前前台布局（与 consume 的一次性机会一一对应，不重复记录）。
                el.markPendingBrowserAutoReveal();
            }
            var renderRoot = tv && tv.closest('#nonAppSlot');
            function resetOversizedArtifact() {
                if (el.style.minWidth === '1280px') el.style.minWidth = '';
                if (el.style.width === '1280px') {
                    var sidebarWidth = tv && tv.constructor && tv.constructor.rightSidebarWidth;
                    el.style.width = (sidebarWidth || 380) + 'px';
                }
                if (el.style.height === '800px') el.style.height = '';
                if (el.style.minHeight === '800px') el.style.minHeight = '';
            }
            function setBrowserBox(panel) {
                if (!panel) return;
                panel.style.display = '';
                panel.style.width = '100%';
                panel.style.height = '100%';
                panel.style.minHeight = '800px';
                panel.style.overflow = 'hidden';
                var browserRoot = panel.querySelector('.bw');
                if (browserRoot) {
                    browserRoot.style.width = '100%';
                    browserRoot.style.height = '100%';
                    browserRoot.style.minHeight = '800px';
                }
                var webviewContainer = panel.querySelector('.bw-webview-container');
                if (webviewContainer) {
                    webviewContainer.style.minHeight = '764px';
                }
                panel.querySelectorAll('.bw-webview-wrap').forEach(function (wrap) {
                    wrap.style.width = '1280px';
                    wrap.style.height = '800px';
                });
                panel.querySelectorAll('webview').forEach(function (webview) {
                    webview.style.width = '100%';
                    webview.style.height = '100%';
                    webview.style.minHeight = '800px';
                });
            }
            function prepareBrowser(autoSwitch) {
                el._suppressBrowserAutoSwitch = !autoSwitch;
                if (!autoSwitch && typeof el.ensureBrowserReady === 'function') {
                    el.ensureBrowserReady(false);
                    return;
                }
                if (typeof el.forceBrowserActive === 'function') {
                    el.forceBrowserActive();
                } else if (typeof el.ensureBrowserReady === 'function') {
                    el.ensureBrowserReady(true);
                }
            }
            if (tv && taskViewIsHidden) {
                // 后台任务：将 task-view 置为 offscreen 可见状态，保持 webview 渲染活跃。
                // 不切换任务到前台，避免打断用户当前界面。
                // task-artifacts 保持 1280px 与 task-view 的 offscreen 模式一致，
                // 不调用 resetOversizedArtifact，避免宿主与内部 webview-wrap 尺寸错位。
                tv.setAttribute('data-background', '1');
                tv.style.display = '';
                // 使用 fixed 脱离 rightPanel 的滚动范围；absolute 的 1280px 宽度会扩大
                // 共享宿主的 scrollWidth，导致前台任务横向偏移并出现底部滚动条。
                tv.style.position = 'fixed';
                tv.style.left = '0';
                tv.style.top = '0';
                tv.style.width = '1280px';
                tv.style.height = '800px';
                tv.style.opacity = '0';
                tv.style.pointerEvents = 'none';
                tv.style.zIndex = '-1';
                // app iframe 在前台时 nonAppSlot 可能为 display:none。让承载根节点继续参与布局，
                // 前台 app-frames-container 仍位于其上方，不会切换或遮挡用户当前界面。
                if (renderRoot && window.getComputedStyle(renderRoot).display === 'none') {
                    renderRoot.style.display = '';
                }
                el.style.display = '';
                el.style.width = '1280px';
                el.style.height = '800px';
            } else {
                // 前台任务：重置此前可能由后台 offscreen 模式设置的 1280px 尺寸，
                // 恢复为侧边栏正常宽度。
                resetOversizedArtifact();
            }
            // 每个任务在本次会话内仅第一次 Browser Use 可以自动展示浏览器聚焦布局。
            // 前台首次使用立即生效；后台首次使用标记为待应用，待用户切回任务时展示。
            if (tv && shouldAutoReveal && typeof tv._ensureRightSidebarOpen === 'function') {
                tv._ensureRightSidebarOpen();
            }
            prepareBrowser(shouldAutoReveal);
            if (!shouldAutoReveal && typeof el.keepBrowserPanelRenderable === 'function') {
                el.keepBrowserPanelRenderable();
            }
            if (tv && taskViewIsHidden) {
                // prepareBrowser 首次调用会在这里才创建 .bw 和 webview，必须在挂载后
                // 再应用一次尺寸，并保持 browser panel 可渲染。
                setBrowserBox(el.shadowRoot && el.shadowRoot.querySelector('.tab-content[data-tab="browser"]'));
            }
        }
    `;
}

/**
 * OpenDesk 专用的脚本生成器。
 * 注入到 embedBrowserUse 的 BrowserManager/BrowserController 中。
 * beforeCallRenderer 列表中的 hook 会在每次调用 renderer 桥接前执行。
 */
export const openDeskScriptGenerators: BrowserScriptGenerators = {
    beforeCallRenderer: [makeEnsureSidebarScript]
};
