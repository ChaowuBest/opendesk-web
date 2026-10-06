/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Ruby 运行时策略（ruby/gem/bundle，standard 模式）。
 *
 * 实测画像（Windows Ruby 4.0，457 次 ask 回归）：Ruby for Windows 的 PATH 只含
 * <install>/bin（C:/Ruby40-x64/bin），标准库在上级 lib/ruby/** 不被 PATH 展开的
 * 读放行覆盖——每次 ruby 启动对标准库弹大量 ask。Linux/macOS 上 ruby 装在
 * /usr/lib/ruby（系统读放行）或 ~/.rbenv/~/.rvm（用户目录），后者在此放行。
 * 用户 gem 目录 {home}/.local/share/gem（Ruby 4 默认，实测 Gem.path 确认）。
 *
 * 凭据边界：~/.gem/credentials（gem push API key）ask 保护；bundle config 的
 * 凭据在 BUNDLE_HOME 配置内，{home}/.bundle/config 【待收紧】（可含仓库 token）。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** RubyGems push 凭据：读 ask 保护。 */
const RUBY_CREDENTIAL_ASK_PATTERNS = ['{home}/.gem/credentials'];

/** Ruby 运行时读放行。 */
const RUBY_RUNTIME_READ_PATTERNS = [
    // 用户 gem 目录（Ruby 4 默认 user_dir 实测）与 bundle 配置
    '{home}/.local/share/gem/**',
    '{home}/.gem/**',
    '{home}/.bundle/config',
    // 版本管理器布局（Linux/macOS）
    '{home}/.rbenv/**',
    '{home}/.rvm/**',
    // Windows 盘根安装形态（实测 C:/Ruby40-x64；版本号随升级变化用通配）
    '/Ruby*/**',
    '/Ruby*/lib/ruby/**',
    '/tools/ruby*/**'
];

export function createRubyPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(RUBY_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        // {home} 模板规则（用户 gem/bundle/版本管理器）
        ...homeRules(
            RUBY_RUNTIME_READ_PATTERNS.filter((p) => p.startsWith('{home}')),
            'read',
            'allow',
            homeDir
        ),
        // Windows 盘根安装树规则（/Ruby*/** 字面 glob，不走 {home} 模板；
        // Windows 沙箱导出时按字面模式交给原生层匹配）
        ...RUBY_RUNTIME_READ_PATTERNS.filter((p) => p.startsWith('/')).map((p) => ({
            resourceType: 'file' as const,
            action: 'read' as const,
            pathPattern: p,
            effect: 'allow' as const
        }))
    ];
}
