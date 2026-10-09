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
 * git 运行时策略（standard 模式）。
 *
 * 每条 git 命令必读全局配置链（三平台实测 strace/配置解析确认）：
 *   - 系统级：Git for Windows 读 <Git 安装目录>/etc/gitconfig；Linux/macOS 读
 *     /etc/gitconfig（macOS Apple Git 同）。系统目录读已由 PATH/运行时豁免或
 *     系统盘读放行覆盖，无需在此重复声明（Windows 的 C:/Program Files/Git 在
 *     Program Files/** read allow 内）。
 *   - 用户级：~/.gitconfig 与 ~/.config/git/{config,ignore}——XDG 与传统路径
 *     三平台一致（Windows Git 同样读 ~/.config/git/）。
 *
 * 凭据硬边界：~/.git-credentials（credential helper store 明文凭据）与
 * ~/.netrc（curl/git 机器凭据）read ask 保护——绝不放行。引擎的 ask 优先于
 * 同长 allow；沙箱导出（most-specific 同长 deny > ask > allow）同样保序。
 * .gitconfig 的 [include] 引用的任意文件是真实文件读，不经本清单、正常管控。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** git 凭据文件：读一律 ask（凭据保护，永不放行）。 */
const GIT_CREDENTIAL_ASK_PATTERNS = ['{home}/.git-credentials', '{home}/.netrc'];

/** git 运行时读放行：全局配置与全局 ignore/attributes（低敏高频）。 */
const GIT_RUNTIME_READ_PATTERNS = [
    '{home}/.gitconfig',
    '{home}/.config/git/config',
    '{home}/.config/git/ignore',
    // XDG 全局 attributes：attributes 查找链的一环，路径常不存在（与 config/ignore
    // 同属 git 全局配置链；沙箱 git status 每次探测，缺规则会落隐式 read ask）
    '{home}/.config/git/attributes',
    // 系统级配置：Linux/macOS /etc/gitconfig（Windows 的 <Git>/etc/gitconfig 在
    // Program Files 系统读放行内，沙箱虚拟路径 /C/Program Files/** 已覆盖）
    '/etc/gitconfig'
];

export function createGitPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        // 凭据 ask 保护先声明（语义清晰；引擎 deny > ask > allow 的效果排序保证
        // ask 优先于同长 allow，与声明顺序无关，但先声明便于阅读）
        ...homeRules(GIT_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        // git 全局配置/ignore 读放行
        ...homeRules(GIT_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir)
    ];
}
