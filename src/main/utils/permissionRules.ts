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
 * 敏感路径保护规则定义。
 *
 * 当用户的工作空间范围较大（例如 $HOME）时，工作空间内的 allow 规则会覆盖
 * 大量本不应被无条件允许的路径（如 ~/.ssh、~/.gnupg 等）。本模块定义了一组
 * "保护规则"，即使路径处于工作空间内，也强制要求用户确认后才能访问。
 *
 * 保护规则的优先级高于 allow 规则但低于 deny 规则：deny > ask(保护) > allow > ask(隐式)
 *
 * 扩展方式：在 SENSITIVE_PATH_PATTERNS 中添加新的条目即可。
 */

import os from 'os';
import type { PermissionRule, PermissionAction, PermissionResourceType } from '../aikernel/security/permission.js';

export interface SensitivePathPattern {
    /** glob 风格的路径模式（使用正斜杠，不含平台特定前缀） */
    pattern: string;
    /** 受保护的操作类型，不指定则保护所有操作 */
    actions?: PermissionAction[];
    /** 受保护的资源类别，默认为 'file' */
    resourceType?: PermissionResourceType;
    /** 可读的规则说明 */
    description: string;
}

/**
 * 预定义的敏感路径模式。
 * pattern 中使用 `{home}` 占位符表示用户主目录（会在生成规则时替换为实际路径）。
 */
export const SENSITIVE_PATH_PATTERNS: SensitivePathPattern[] = [
    // SSH 密钥与配置
    {
        pattern: '{home}/.ssh/**',
        description: 'SSH 密钥与配置'
    },
    // GPG 密钥
    {
        pattern: '{home}/.gnupg/**',
        description: 'GPG 密钥与配置'
    },
    // AWS 凭证
    {
        pattern: '{home}/.aws/**',
        description: 'AWS 凭证与配置'
    },
    // Docker 凭证
    {
        pattern: '{home}/.docker/**',
        description: 'Docker 凭证与配置'
    },
    // Kubernetes 配置
    {
        pattern: '{home}/.kube/**',
        description: 'Kubernetes 配置'
    },
    // Git 凭证文件
    {
        pattern: '{home}/.git-credentials',
        description: 'Git 凭证存储'
    },
    // npm token
    {
        pattern: '{home}/.npmrc',
        description: 'npm 配置与 token'
    },
    // 通用 .env 文件（工作空间内的 .env 也需要保护）
    {
        pattern: '**/.env',
        description: '环境变量文件'
    },
    {
        pattern: '**/.env.*',
        description: '环境变量文件'
    }
];

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * 将敏感路径模式展开为具体的 PermissionRule 列表。
 *
 * 生成的规则 effect 为 'ask'，在权限引擎中作为保护规则使用：
 * 即使路径匹配了 allow 规则，只要同时匹配了 ask 保护规则，仍需用户确认。
 *
 * @param workspace 当前工作空间路径（已规范化为正斜杠）
 */
export function createSensitivePathRules(workspace: string): PermissionRule[] {
    const homeDir = normalizePath(os.homedir());
    const workspaceNorm = normalizePath(workspace);
    const rules: PermissionRule[] = [];

    const allFileActions: PermissionAction[] = ['read', 'write', 'execute'];

    for (const sp of SENSITIVE_PATH_PATTERNS) {
        const resolvedPattern = sp.pattern.replace(/\{home\}/g, homeDir);
        const resourceType = sp.resourceType ?? 'file';
        const actions = sp.actions ?? allFileActions;

        // 只有当敏感路径可能落在工作空间内时才需要保护规则。
        // 对于 ** 开头的通配模式（如 **/.env），始终生成规则。
        // 对于具体路径模式，检查其是否与工作空间有交集。
        if (!resolvedPattern.startsWith('**/') && !isPathPotentiallyUnder(resolvedPattern, workspaceNorm)) {
            continue;
        }

        for (const action of actions) {
            rules.push({
                resourceType,
                action,
                pathPattern: resolvedPattern,
                effect: 'ask'
            });
        }
    }

    return rules;
}

/**
 * 检查一个 glob 模式的路径是否可能落在 workspace 目录下。
 * 这是一个保守检查：当不确定时返回 true（宁可多保护，不可漏保护）。
 */
function isPathPotentiallyUnder(pattern: string, workspace: string): boolean {
    // 去掉 glob 后缀，取到最具体的前缀目录
    const concretePrefix = pattern.split('*')[0].replace(/\/+$/, '');
    if (!concretePrefix) return true;

    // 双向检查：模式可能是 workspace 的子路径，或 workspace 可能是模式的子路径
    return concretePrefix.startsWith(workspace) || workspace.startsWith(concretePrefix);
}
