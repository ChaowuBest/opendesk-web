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
 * Go 运行时策略（go，standard 模式）。
 *
 * 三平台实测：GOPATH 默认 {home}/go（三平台一致）；GOCACHE 按平台惯例
 * （Linux {XDG_CACHE}/go-build、macOS ~/Library/Caches/go-build、Windows
 * {LOCALAPPDATA}/go-build）；OpenDesk Linux 沙箱已把 GOCACHE/GOPATH 重定向到
 * ~/.cache/opendesk-sandbox/（工具链缓存规则覆盖）。go 自身无凭据文件——私有
 * 模块鉴权走 .netrc（已有 ask 保护）或 git credential。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** Go 运行时读放行（GOPATH、构建缓存、OpenDesk 沙箱重定向区）。 */
const GO_RUNTIME_READ_PATTERNS = [
    '{home}/go/**',
    '{home}/.cache/go-build/**',
    '{home}/Library/Caches/go-build/**',
    '{home}/AppData/Local/go-build/**',
    '{home}/.cache/opendesk-sandbox/go/**',
    '{home}/.cache/opendesk-sandbox/gopath/**'
];

export function createGoPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(GO_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}
