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
 * Rust 运行时策略（cargo/rustc/rustup，standard 模式）。
 *
 * 三平台布局一致（~/.cargo、~/.rustup；CARGO_HOME/RUSTUP_HOME 可整体重定向，
 * OpenDesk Linux 沙箱已把 CARGO_HOME 重定向到 ~/.cache/opendesk-sandbox/cargo，
 * 由工具链缓存规则覆盖）。cargo build/run 必读 registry 缓存与工具链。
 *
 * 凭据边界：~/.cargo/credentials.toml（crates.io/私有 registry token 明文）
 * ask 保护——registry 子树放行不含它（精确文件 ask 优先于前缀 allow）。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** cargo 凭据：读 ask 保护。 */
const CARGO_CREDENTIAL_ASK_PATTERNS = ['{home}/.cargo/credentials.toml'];

/** Rust 运行时读放行（registry 缓存、工具链、cargo home 配置）。 */
const CARGO_RUNTIME_READ_PATTERNS = [
    '{home}/.cargo/registry/**',
    '{home}/.cargo/git/**',
    '{home}/.cargo/config',
    '{home}/.cargo/config.toml',
    '{home}/.cargo/bin/**',
    '{home}/.rustup/**',
    // OpenDesk Linux 沙箱工具链缓存重定向（CARGO_HOME 指向）
    '{home}/.cache/opendesk-sandbox/cargo/**'
];

export function createCargoPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(CARGO_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        ...homeRules(CARGO_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir)
    ];
}
