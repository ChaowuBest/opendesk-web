/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * AI Agent CLI 运行时策略（codex/claude 等命令行 AI 工具，standard 模式）。
 *
 * 实测画像（Windows）：codex 每次启动对 ~/.codex/tmp/ 下的会话临时目录发起
 * 8 次 write ask（.lock 与 apply_patch 批处理文件）；claude --version 零 ask
 * （读安装树，PATH 覆盖）。
 *
 * 凭据边界：AI CLI 的 API key 存各家配置文件（~/.codex/auth.json、
 * ~/.claude/.credentials.json 等）——【待收紧】这些文件是明文凭据，但临时区
 * （tmp/、cache/、projects/ 会话历史）与凭据文件同目录混放。当前从宽放行
 * 整个用户目录（tmp 高频写是主要痛点），凭据文件依赖兜底 ask；统一审视时
 * 建议按子目录拆分：tmp/cache/projects 放行，auth/credentials 类 ask。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** AI Agent CLI 运行时读写放行（会话临时区/缓存/历史；从宽，见头注释收紧口径）。 */
const AGENTS_RUNTIME_PATTERNS = [
    '{home}/.codex/**',
    '{home}/.claude/**',
    '{home}/.config/claude/**',
    '{home}/.cache/claude/**'
];

export function createAgentsPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(AGENTS_RUNTIME_PATTERNS, 'read', 'allow', homeDir).concat(
        homeRules(AGENTS_RUNTIME_PATTERNS, 'write', 'allow', homeDir)
    );
}
