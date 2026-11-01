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
 * GUI 缩放快捷键（Ctrl+{+,-,0}）。
 *
 * 主窗口与独立应用窗口共用同一份定义：缩放偏好是全局设置（gui_config.scale_factor），
 * 两处各写一份容易出现快捷键漂移，也容易漏掉新窗口类型。
 */

import { guiShortcutManager, type GUIShortcutEntry } from '../components/shortcutManager.ts';

/** preload 暴露的 displayAPI 中本模块消费的部分。 */
interface DisplayZoomAPI {
    setScaleFactor: (factor: number) => Promise<number>;
    adjustScaleFactor: (delta: number) => Promise<number>;
}

/**
 * 执行一次缩放操作。快捷键回调不能返回 Promise：主进程写配置失败时该 Promise 会
 * 拒绝，没人接管就变成未处理的拒绝（应用窗口没有 devtools，只能静默报错）。
 * 失败时保持当前缩放即可，不打断用户操作。
 */
function applyZoom(action: (api: DisplayZoomAPI) => Promise<number>): void {
    const api = (window as unknown as { displayAPI?: DisplayZoomAPI }).displayAPI;
    if (!api) return;
    void action(api).catch(() => undefined);
}

const DISPLAY_ZOOM_SHORTCUTS: GUIShortcutEntry[] = [
    {
        id: 'display:zoom-in',
        label: '放大界面',
        category: '显示',
        keys: ['Ctrl++ / ='],
        match: (e) => (e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+'),
        handler: () => applyZoom((api) => api.adjustScaleFactor(0.1))
    },
    {
        id: 'display:zoom-out',
        label: '缩小界面',
        category: '显示',
        keys: ['Ctrl+-'],
        match: (e) => (e.ctrlKey || e.metaKey) && e.key === '-',
        handler: () => applyZoom((api) => api.adjustScaleFactor(-0.1))
    },
    {
        id: 'display:zoom-reset',
        label: '重置缩放',
        category: '显示',
        keys: ['Ctrl+0'],
        match: (e) => (e.ctrlKey || e.metaKey) && e.key === '0',
        handler: () => applyZoom((api) => api.setScaleFactor(1))
    }
];

/** 注册缩放快捷键（调用方负责 attach 快捷键管理器）。 */
export function registerDisplayZoomShortcuts(): void {
    for (const entry of DISPLAY_ZOOM_SHORTCUTS) {
        guiShortcutManager.register(entry);
    }
}
