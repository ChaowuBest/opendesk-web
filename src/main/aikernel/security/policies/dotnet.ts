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
 * .NET 运行时策略（dotnet，standard 模式）。
 *
 * 官方文档验证的布局：NuGet.Config 在 Windows {APPDATA}/NuGet/、Linux/macOS
 * {home}/.nuget/NuGet/；全局包文件夹 {home}/.nuget/packages 三平台一致。
 *
 * 凭据边界：
 * - dotnet user-secrets（.microsoft/usersecrets 下各 secrets.json 与
 *   AppData/Roaming/Microsoft/UserSecrets 下的 secrets.json）是应用机密本体，
 *   ask 保护；
 * - NuGet.Config 含 packageSourceCredentials（私有源凭据）——【待收紧】
 *   dotnet restore 高频读它，当前从宽放行 NuGet.Config 本体，统一审视时评估；
 * - .nuget/packages 为纯下载产物，放行。
 */

import type { PermissionRule } from '../permission.js';
import { homeRules } from './common.js';

/** dotnet user-secrets：读 ask 保护（应用机密本体）。 */
const DOTNET_CREDENTIAL_ASK_PATTERNS = [
    '{home}/.microsoft/usersecrets/**/secrets.json',
    '{home}/AppData/Roaming/Microsoft/UserSecrets/**/secrets.json'
];

/** .NET 运行时读放行（NuGet 全局包、CLI 状态、NuGet.Config）。 */
const DOTNET_RUNTIME_READ_PATTERNS = [
    '{home}/.nuget/packages/**',
    '{home}/.nuget/NuGet/NuGet.Config',
    '{home}/.dotnet/**',
    '{home}/AppData/Roaming/NuGet/NuGet.Config'
];

export function createDotnetPolicyRules(homeDir?: string): PermissionRule[] {
    return [
        ...homeRules(DOTNET_CREDENTIAL_ASK_PATTERNS, 'read', 'ask', homeDir),
        ...homeRules(DOTNET_RUNTIME_READ_PATTERNS, 'read', 'allow', homeDir)
    ];
}
