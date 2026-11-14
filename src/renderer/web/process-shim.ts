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
 * web preload 包内的 `process` 替身（esbuild inject，只作用于打包产物内部，不挂到 window）。
 * 对应 Electron 沙箱 preload 里可用的那部分 process：platform / argv / env。
 * platform 取服务端（agent 实际运行的系统），路径适配等逻辑据此选择分隔符。
 */

const boot = (globalThis as { __OPENDESK_WEB__?: { platform?: string; homePath?: string } }).__OPENDESK_WEB__ ?? {};

export const process = {
    platform: boot.platform ?? 'linux',
    argv: [] as string[],
    env: { HOME: boot.homePath ?? '' } as Record<string, string | undefined>,
    versions: {} as Record<string, string>,
    type: 'renderer'
};
