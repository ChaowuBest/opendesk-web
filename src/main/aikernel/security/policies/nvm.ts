/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of the Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FITNESS FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * nvm（Node Version Manager）运行时策略（standard 模式，Linux/macOS）。
 *
 * nvm 用户工具链整体位于 ~/.nvm 下，读取频率高且全部为工具链本体：
 *   - ~/.nvm/nvm.sh（以及 bash_completion）：shell rc 每次加载都 source；
 *   - ~/.nvm/versions/node/<version>/{bin,lib,include,share}：当前版本
 *     node/npm/npx 的二进制与随附模块（bin 在 PATH 上，但 lib/node_modules
 *     是 bin 的兄弟目录——npm -g 安装包与 npm 自身的 package.json 都在这）；
 *   - ~/.nvm/.cache、~/.nvm/src：版本下载缓存与源码归档（nvm install 残留）。
 *
 * 这些路径不在系统前缀（/usr 等）内，PATH 展开只覆盖 bin 目录本身，standard
 * 模式的外读兜底 ask 会对它们逐个弹窗（npm run test 一次触发多次）。
 *
 * 凭据边界：nvm 目录内没有凭据形态的文件（node 版本树是公开发行物，npm 的
 * registry token 在 ~/.npmrc 由 node.ts ask 保护）。只放 read；写仍由引擎
 * 兜底 ask 管控（防工具链目录持久化/版本替换攻击）。
 *
 * Windows：nvm-windows 安装在 Program Files/nodejs（系统读放行覆盖），且
 * nvm4w 的符号链接布局不经 ~/.nvm，本清单对 Windows 不生成规则（目录不存在
 * 时规则闲置无害，仍按 {home} 模板声明以保持跨平台一致性）。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** nvm 工具链读放行：版本树、加载脚本与下载缓存（仅 read）。 */
const NVM_RUNTIME_READ_PATTERNS = ['{home}/.nvm/**'];

export function createNvmPolicyRules(homeDir?: string): PermissionRule[] {
    return homeRules(NVM_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir);
}
