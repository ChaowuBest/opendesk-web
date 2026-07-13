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
            if (tv && tv.hasAttribute('data-background')) {
                el.style.display = '';
                el.style.width = '1280px';
                if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady();
            } else {
                if (tv && typeof tv._ensureRightSidebarOpen === 'function') tv._ensureRightSidebarOpen();
                if (typeof el.ensureBrowserReady === 'function') el.ensureBrowserReady(true);
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
