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

import type { WebContents } from 'electron';

/**
 * Linux(X11) 下阻止无边框窗口弹 WM 系统菜单。
 *
 * frameless 窗口且未设置应用菜单时，Chromium 对右键的默认处理是通过
 * `_NET_WM_MENU` 协议请求窗口管理器弹出系统窗口菜单（Cinnamon/Muffin 的
 * 最小化/移动/调整大小/关闭菜单）。该菜单：
 * - 弹于窗口左上角而非鼠标位置（Muffin 收到请求后的定位 bug）；
 * - 弹出后 WM 对输入做 grab，菜单项点击无效、菜单无法关闭；
 * - grab 期间标题栏按钮（含最小化）也点不动，连带右下角悬浮窗联动失效。
 *
 * 在 `context-menu` 事件中 preventDefault 即可阻止 Chromium 走该默认流程；
 * 仅针对非编辑区域，编辑区域的剪切/复制/粘贴菜单由各窗口 handler 按需弹出。
 * 其他平台（Windows/macOS 无此 WM 行为）直接返回。
 */
export function suppressWmSystemMenuOnLinux(contents: WebContents): void {
    if (process.platform !== 'linux') {
        return;
    }
    contents.on('context-menu', (event, params) => {
        if (!params.isEditable) {
            event.preventDefault();
        }
    });
}
