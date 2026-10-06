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
 * App 专属策略聚合入口（standard 模式）。
 *
 * 每个 CLI 工具一个策略文件，此处统一聚合。由 createDefaultPermissionRules
 * 注入 standard 模式的权限引擎：
 *   - 读写文件等工具调用经引擎 check 直接生效；
 *   - 动态沙箱启动时经 enforcer.getRules() 导出为沙箱策略文本，同样生效。
 *
 * 新增 app 策略：在 policies/ 下新建 <tool>.ts 导出 create<Tool>PolicyRules()，
 * 并在 ALL_APP_POLICY_FACTORIES 中注册。规则必须满足 common.ts 头注释的设计
 * 约束（跨平台 {home} 模板、凭据 ask 保护、仅 read 放行）与 README.md 检查单。
 *
 * 收紧口径（统一审视用）：标【待收紧】的条目为当前从宽放行、后续评估收窄的
 * 审查类文件；凭据类文件（token/密钥/机器凭据/应用机密）一律 ask，不在从宽范围。
 */

import type { PermissionRule } from '../permission.js';
import { createGitPolicyRules } from './git.js';
import { createPythonPolicyRules } from './python.js';
import { createNodePolicyRules } from './node.js';
import { createNvmPolicyRules } from './nvm.js';
import { createUvPolicyRules } from './uv.js';
import { createSshPolicyRules } from './ssh.js';
import { createCargoPolicyRules } from './cargo.js';
import { createGoPolicyRules } from './go.js';
import { createJvmPolicyRules } from './jvm.js';
import { createDockerPolicyRules } from './docker.js';
import { createDotnetPolicyRules } from './dotnet.js';
import { createTransferPolicyRules } from './transfer.js';
import { createEditorPolicyRules } from './editor.js';
import { createRubyPolicyRules } from './ruby.js';
import { createAgentsPolicyRules } from './agents.js';

type AppPolicyFactory = (homeDir?: string) => PermissionRule[];

/** 全部 app 策略工厂（聚合顺序即声明顺序；引擎效果排序 deny > ask > allow）。 */
const ALL_APP_POLICY_FACTORIES: AppPolicyFactory[] = [
    createGitPolicyRules,
    createPythonPolicyRules,
    createNodePolicyRules,
    createNvmPolicyRules,
    createUvPolicyRules,
    createSshPolicyRules,
    createCargoPolicyRules,
    createGoPolicyRules,
    createJvmPolicyRules,
    createDockerPolicyRules,
    createDotnetPolicyRules,
    createTransferPolicyRules,
    createEditorPolicyRules,
    createRubyPolicyRules,
    createAgentsPolicyRules
];

/** 聚合所有 app 专属策略规则（standard 模式使用）。homeDir 供测试注入固定家目录，
 *  生产省略（各工厂取 os.homedir() 展开 {home} 模板）。 */
export function createAppPolicyRules(homeDir?: string): PermissionRule[] {
    return ALL_APP_POLICY_FACTORIES.flatMap((factory) => factory(homeDir));
}
