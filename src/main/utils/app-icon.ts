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

import { nativeImage, screen } from 'electron';
import appIcon from '../../../resources/main/images/icon_round.png?asset';
import appIconDebug from '../../../resources/main/images/icon_round_blue.png?asset';
import { isOpendeskDebugMode } from './setting.js';

/**
 * 应用图标资源路径（托盘、窗口图标共用）：调试实例使用蓝色版本。
 */
export const getAppIconPath = (): string => {
    return isOpendeskDebugMode() ? appIconDebug : appIcon;
};

/**
 * 桌面任务栏/窗口切换器使用的窗口图标。
 *
 * 把 512px 原图直接交给 Electron 时，窗口图标属性（如 X11 的 _NET_WM_ICON）中只有
 * 单一超大尺寸，任务栏需自行做 10 倍以上低质量降采样，圆形边缘出现明显锯齿；而托盘
 * 图标柔和，是因为 Electron 已先用高质量算法缩放后才交给系统。这里复用同样思路：
 * 先用 Electron 高质量算法缩到略大于任务栏显示尺寸，再交给系统，使系统侧只剩轻微缩放。
 *
 * 不能用 addRepresentation 塞入多档尺寸：Electron 在 Linux 下只写入主 representation，
 * 实测多档图标会退化成最小档（16px）再被任务栏放大，反而彻底糊掉。
 *
 * 每个 BrowserWindow 都必须带上该图标：Linux 桌面（如 Cinnamon）会把同一 WM_CLASS
 * 的所有窗口聚合成一个应用条目，条目图标取自窗口的 _NET_WM_ICON；任一窗口缺图标都会
 * 让整个条目退化成系统的 application-x-executable 占位图标。
 */
export const getWindowIcon = (): Electron.NativeImage => {
    // 任务栏图标一般 24~64 逻辑像素。X11 下一个窗口只有一份图标数据（_NET_WM_ICON），
    // 无法按不同缩放的显示器切换，因此按所有显示器中的最大缩放系数取值，并留出余量
    // （取 64 逻辑像素），保证窗口出现在任何屏幕上图标都只被轻微缩小，绝不放大。
    const scaleFactor = Math.max(1, ...screen.getAllDisplays().map((display) => display.scaleFactor || 1));
    const size = Math.round(64 * scaleFactor);
    return nativeImage.createFromPath(getAppIconPath()).resize({ width: size, height: size });
};
