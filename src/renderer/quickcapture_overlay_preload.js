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

import { contextBridge, ipcRenderer } from 'electron';

/**
 * 快速截图遮罩窗口的 preload：只暴露受控的 IPC 通道，
 * 遮罩页面本身运行在 contextIsolation 下、没有 Node 能力。
 */
contextBridge.exposeInMainWorld('quickCaptureOverlayAPI', {
    ready: () => ipcRenderer.invoke('quickcapture-overlay:ready'),
    commit: (rect) => ipcRenderer.invoke('quickcapture-overlay:commit', rect),
    copy: (rect) => ipcRenderer.invoke('quickcapture-overlay:copy', rect),
    close: () => ipcRenderer.invoke('quickcapture-overlay:close')
});
