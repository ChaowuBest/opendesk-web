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
 * uv 运行时策略（uv/uvx，standard 模式）。
 *
 * 三平台实测读路径画像（OHOS uv 0.11.18 aarch64-ohos / macOS uv 0.9.29
 * Homebrew / Linux 惯例路径）：
 *   - 缓存：uv cache dir 实测 Linux/OHOS ~/.cache/uv（XDG）、macOS
 *     ~/Library/Caches/uv（实测 0.9.29 输出 ~/.cache/uv——uv 在 macOS 也默认
 *     XDG 位置，仍保留 Library/Caches 模板兜底自定义布局）。
 *   - 工具安装区（uvx 运行的 ephemeral 环境与 uv tool install 落点）：
 *     ~/.local/share/uv（XDG data）；uvx shim 落 ~/.local/bin（OHOS 实测）。
 *   - python 工具链管理区（uv python install 落点）：~/.local/share/uv/python。
 *
 * uv 无独立凭据文件（认证走 keyring/env），无需凭据规则。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** uv 运行时读放行（缓存 + 工具区 + shim bin）。 */
const UV_RUNTIME_READ_PATTERNS = [
    '{home}/.cache/uv/**',
    '{home}/Library/Caches/uv/**',
    '{home}/AppData/Local/uv/cache/**',
    '{home}/.local/share/uv/**',
    '{home}/Library/Application Support/uv/**',
    '{home}/AppData/Roaming/uv/**',
    '{home}/.local/bin/**'
];

export function createUvPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(UV_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}
