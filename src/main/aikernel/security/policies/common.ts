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
 * App 专属策略（standard 模式）公共基础设施。
 *
 * 每个常用 CLI 工具（git/python/node/uv 等）在 `policies/` 目录下有一个策略文件，
 * 导出 `create<App>PolicyRules(): PermissionRule[]`。这些规则注入 standard 模式的
 * 权限引擎（createDefaultPermissionRules），因此：
 *   - 读写文件等工具调用经引擎 check 时直接生效；
 *   - 动态沙箱启动时经 enforcer.getRules() 导出为沙箱策略文本，同样生效。
 * 一处定义、两端应用，沙箱实现层不再维护 app 专属路径清单。
 *
 * 设计约束：
 *   - 仅 standard 模式注入（solo/unlimited 全放行、readonly 全拒绝，无需 app 策略）；
 *   - 跨平台通用：路径用 `{home}` 占位符（os.homedir() 展开），glob 用正斜杠；
 *   - 凭据类文件一律 ask 保护，不读取凭据文件内容来决定是否放行；
 *   - 放行仅限 read：运行时目录的写仍由引擎兜底 ask 管控（防持久化攻击）。
 */

import os from 'os';
import type { PermissionRule } from '../permission.js';

/** 展开路径模板中的 `{home}` 占位符（正斜杠规范形）。 */
export function expandHomePath(pattern: string, homeDir?: string): string {
    const home = (homeDir ?? os.homedir()).replace(/\\/g, '/').replace(/\/+$/, '');
    return pattern.replace(/\{home\}/g, home);
}

/** 批量展开 `{home}` 模板为 PermissionRule（resourceType 固定 file）。 */
export function homeRules(
    patterns: string[],
    action: PermissionRule['action'],
    effect: PermissionRule['effect'],
    homeDir?: string
): PermissionRule[] {
    return patterns.map((pattern) => ({
        resourceType: 'file' as const,
        action,
        pathPattern: expandHomePath(pattern, homeDir),
        effect
    }));
}

/** homeDir 参数形态：测试注入固定家目录；生产省略（取 os.homedir()）。 */
export type HomeDirOverride = string | undefined;
