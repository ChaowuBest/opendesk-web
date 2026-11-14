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

import { app } from 'electron';
import { isWebMode } from '../web/config.js';
import { installIpcRecorder } from '../web/ipc-bridge.js';

// Web 模式（OPENDESK_WEB_PORT）：必须在 main.js 及其依赖注册任何 ipcMain 处理器之前接管注册，
// 浏览器连接才能调用到全部处理器；服务器/容器环境没有可用 GPU，直接走软件渲染。
if (isWebMode()) {
    app.disableHardwareAcceleration();
    installIpcRecorder();
}

// OpenDesk 单进程启动入口。
// Electron 64 位主进程的默认 V8 堆上限（heap_size_limit）即为 4096MB，
// 无需再通过「带 --js-flags 重启子进程」的方式注入堆上限 —— 那会额外
// 常驻一层什么也不干的 bootstrap 空壳进程（约 40~50MB 私有内存）。
await import('../main.js');

// 顶层 await 入口：声明为模块以启用 ESM 顶层 await 语义
export {};
