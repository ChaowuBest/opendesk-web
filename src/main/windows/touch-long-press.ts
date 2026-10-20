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
import { injectScriptIntoFrames } from '../utils/webview-frame-inject.js';
import { TOUCH_LONG_PRESS_SCRIPT } from '../../renderer/touchLongPressScript.js';

/**
 * 触摸屏长按 → 右键点击。
 *
 * Chromium 桌面版在普通元素上没有"长按 = 右键"手势，长按只用于选词/滚动，
 * Windows 系统级 press-and-hold 合成右键对 Chromium 窗口也不生效，需应用自行补偿。
 *
 * 注入脚本负责全部手势与菜单逻辑：长按进度环、在命中元素上派发合成 contextmenu
 * （局部坐标天然精确，自绘菜单与页面菜单位置不经过任何合成输入事件或原生菜单
 * API 的坐标换算），编辑区的剪切/复制/粘贴菜单也在脚本内自绘（剪贴板经
 * preload 隔离世界桥读写），真实鼠标右键同样由该自绘菜单接管。主进程只负责
 * 把脚本送进所有窗口与 frame。
 */
export function installTouchLongPress(contents: WebContents): void {
    const inject = (): void => {
        injectScriptIntoFrames(contents, TOUCH_LONG_PRESS_SCRIPT);
    };
    contents.on('dom-ready', inject);
    contents.on('did-frame-navigate', inject);
}
