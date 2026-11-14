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
 * Web 模式开关：设置 OPENDESK_WEB_PORT 后桌面主进程不再显示窗口，
 * 改为在该端口提供 Web UI，renderer 的 IPC 经 WebSocket 转发到同一套 ipcMain 处理器。
 *
 *   OPENDESK_WEB_PORT   监听端口（必填，开启 web 模式）
 *   OPENDESK_WEB_HOST   监听地址，默认 0.0.0.0（容器内需对外暴露）
 *   OPENDESK_WEB_TOKEN  访问令牌；设置后所有请求需携带（?token= / Cookie / Bearer）
 */

export interface WebModeConfig {
    port: number;
    host: string;
    token: string | null;
}

let cached: WebModeConfig | null | undefined;

export function getWebModeConfig(): WebModeConfig | null {
    if (cached !== undefined) return cached;
    const rawPort = process.env.OPENDESK_WEB_PORT?.trim();
    if (!rawPort) {
        cached = null;
        return cached;
    }
    const port = Number(rawPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`OPENDESK_WEB_PORT must be a valid port, got "${rawPort}"`);
    }
    cached = {
        port,
        host: process.env.OPENDESK_WEB_HOST?.trim() || '0.0.0.0',
        token: process.env.OPENDESK_WEB_TOKEN?.trim() || null
    };
    return cached;
}

export function isWebMode(): boolean {
    return getWebModeConfig() !== null;
}
