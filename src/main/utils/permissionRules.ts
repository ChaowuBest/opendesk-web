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
import path from 'path';
import type { PermissionRule, PermissionAction, PermissionResourceType } from '../aikernel/security/permission.js';
import { normalizePath } from '../../utils/path.js';
import { getOpendeskDirectory } from './setting.js';

export interface SensitivePathPattern {
    /** glob 风格的路径模式（使用正斜杠，不含平台特定前缀） */
    pattern: string;
    /** 受保护的操作类型，不指定则保护所有操作 */
    actions?: PermissionAction[];
    /** 受保护的资源类别，默认为 'file' */
    resourceType?: PermissionResourceType;
    /** 可读的规则说明 */
    description: string;
    /** 是否将递归文件名模式限定到当前工作区；关键路径规则仍保留全局模式。 */
    workspaceScoped?: boolean;
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
    // 项目级 npm 配置可能包含 registry token，必须覆盖工作区默认 allow。
    // 用户级 ~/.npmrc 由 policies/node.ts 统一生成固定的读写 ask 规则。
    {
        pattern: '**/.npmrc',
        actions: ['read', 'write'],
        description: '项目 npm 配置与 token',
        workspaceScoped: true
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
        if (sp.workspaceScoped) {
            const relativePattern = sp.pattern.replace(/^\*\*\//, '');
            for (const resolvedPattern of [
                `${workspaceNorm}/${relativePattern}`,
                `${workspaceNorm}/**/${relativePattern}`
            ]) {
                for (const action of sp.actions ?? allFileActions) {
                    rules.push({
                        resourceType: sp.resourceType ?? 'file',
                        action,
                        pathPattern: resolvedPattern,
                        effect: 'ask'
                    });
                }
            }
            continue;
        }

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
 * 创建始终生效的关键路径保护规则（不受工作空间限制）。
 * 用于 Solo 模式，确保 ~/.ssh 等路径在任何工作空间下都需要被拒绝。
 */
export function createCriticalPathRules(): PermissionRule[] {
    const homeDir = normalizePath(os.homedir());
    const rules: PermissionRule[] = [];
    const allFileActions: PermissionAction[] = ['read', 'write', 'execute'];

    for (const sp of SENSITIVE_PATH_PATTERNS) {
        const resolvedPattern = sp.pattern.replace(/\{home\}/g, homeDir);
        const resourceType = sp.resourceType ?? 'file';
        const actions = sp.actions ?? allFileActions;

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
 * interpreters 目录（应用数据目录下）的读写放行规则。
 *
 * pip-global、npm-global、uv、cmd-pkgs 等 OpenDesk 自带运行时的包安装位置
 * 都位于该目录，由 OpenDesk 自身管理。Standard / Solo 模式下直接放行其中的
 * 读写操作，避免沙箱内安装包时反复触发授权弹窗。
 */
export function createInterpretersPermissionRules(): PermissionRule[] {
    const dirNorm = normalizePath(path.resolve(getOpendeskDirectory(), 'interpreters'));
    const pattern = `${dirNorm}{,/**}`;
    return [
        { resourceType: 'file', action: 'read', pathPattern: pattern, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: pattern, effect: 'allow' }
    ];
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

/**
 * 设备节点的 allow 规则。
 *
 * /dev/stdin, /dev/stdout, /dev/stderr, /dev/null, /dev/zero, /dev/urandom 等
 * 是工具链（如 shell 命令、进程管道）的基本依赖，所有模式都应无条件允许访问。
 * Windows 上这些路径不存在，但规则添加了也无副作用。
 */
const DEVICE_NODE_PATTERNS = [
    '/dev/stdin',
    '/dev/stdout',
    '/dev/stderr',
    '/dev/null',
    '/dev/zero',
    '/dev/random',
    '/dev/urandom',
    '/dev/tty',
    '/dev/fd/**',
    '/proc/self/fd/**'
];

export function createDeviceNodeRules(): PermissionRule[] {
    const rules: PermissionRule[] = [];
    const actions: PermissionAction[] = ['read', 'write', 'execute'];

    for (const pattern of DEVICE_NODE_PATTERNS) {
        for (const action of actions) {
            rules.push({
                resourceType: 'file',
                action,
                pathPattern: pattern,
                effect: 'allow'
            });
        }
    }

    return rules;
}
