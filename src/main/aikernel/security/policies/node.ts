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
 * Node.js 运行时策略（node/npm/npx，standard 模式）。
 *
 * 三平台实测读路径画像（WSL strace / OHOS / macOS Homebrew node 24 + npm 11）：
 *   - npm 全局前缀：Linux/OHOS ~/(.local|usr)/ 或 ~/.harmonybrew（OHOS 实测
 *     npm prefix -g 落 ~/.harmonybrew）；macOS Homebrew /opt/homebrew（系统树，
 *     已由 PATH/系统读放行覆盖）；Windows %APPDATA%/npm。
 *   - npm 缓存：~/.npm（_cacache/_npx/_logs，Linux/macOS/OHOS 实测确认；
 *     Windows ~/AppData/Local/npm-cache）。
 *   - node 全局模块解析：~/.node_modules、~/.node_libraries（三平台一致，
 *     module.globalPaths 实测确认）。
 *
 * 凭据硬边界：~/.npmrc 含 registry _authToken（明文 token），读 ask 保护——
 * npm/npx 每次启动都读它，这是已知的唯一 ask 残留，属有意的凭据保护（standard
 * 模式确认一次后 rememberScope 可放行）。Windows 的用户级 .npmrc 同路径（家目录）。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** npm registry token（明文）：读 ask 保护。 */
const NODE_CREDENTIAL_ASK_PATTERNS = ['{home}/.npmrc'];

/**
 * npm 调试日志目录写放行（common.ts"仅 read 放行"约束的显式例外）：
 * npm/npx 每次执行都写 _logs/<时间戳>-debug-0.log（诊断产物，无持久化面），
 * 不放行则 standard 沙箱每次 npm 执行都对该日志触发写 ask（实测 npx jest
 * 一次即弹）。只放 _logs 子目录，npm 缓存主体（_cacache/_npx）的写仍由
 * 引擎兜底 ask 管控（防缓存投毒诱导重装恶意包）。
 */
const NODE_LOG_WRITE_PATTERNS = ['{home}/.npm/_logs/**', '{home}/AppData/Local/npm-cache/_logs/**'];

/** node/npm 运行时读放行。 */
const NODE_RUNTIME_READ_PATTERNS = [
    // npm 缓存（_cacache/_npx/_logs/_prebuilds）
    '{home}/.npm/**',
    '{home}/AppData/Local/npm-cache/**',
    // node 全局模块解析路径（module.globalPaths）
    '{home}/.node_modules',
    '{home}/.node_modules/**',
    '{home}/.node_libraries/**',
    // npm 全局前缀（OHOS 实测 ~/.harmonybrew、Linux 常见 ~/.npm-global，
    // Windows %APPDATA%/npm；全局 bin/模块的读取）
    '{home}/.npm-global/**',
    '{home}/.harmonybrew/**',
    '{home}/AppData/Roaming/npm/**',
    // npx 缓存（~/.npm/_npx 已由 ~/.npm/** 覆盖；显式留注释说明）
    // OpenDesk 工具链缓存重定向（沙箱 env npm_config_cache 指向）
    '{home}/.cache/opendesk-sandbox/**'
];

export function createNodePolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(NODE_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        ...homeRules(NODE_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir),
        // npm 调试日志写放行（诊断产物例外，见 NODE_LOG_WRITE_PATTERNS 注释）
        ...homeRules(NODE_LOG_WRITE_PATTERNS, 'write', 'allow', homeDir)
    ];
}
