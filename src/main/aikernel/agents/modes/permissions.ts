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
 * Mode-specific 权限规则工厂函数。
 *
 * 每种 Mode 对应不同的安全策略：
 * - Standard: 工作空间可读写，外部 ask（默认行为）
 * - Plan: 工作空间只读 + .plan 目录可写
 * - Solo: 全部放通，但敏感路径直接 deny（无人值守，不弹确认）
 */

import path from 'path';
import type { PermissionRule } from '../../security/permission.js';
import {
    createSensitivePathRules,
    SENSITIVE_PATH_PATTERNS,
    createDeviceNodeRules
} from '../../../utils/permissionRules.js';
import type { PermissionAction } from '../../security/permission.js';
import os from 'os';

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Plan Mode 权限规则：
 * - 工作空间内文件可读但不可写（只读模式）
 * - .plan 目录可读可写（计划文件输出目录）
 * - 工作空间内可执行（允许 shell 只读命令）
 * - 工作空间外隐式 ask
 * - 技能可读
 * - 敏感路径保护
 */
export function createPlanModePermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(workspace));
    const planDirNorm = `${workspaceNorm}/.plan`;

    return [
        // 设备节点始终允许（/dev/stdin, /dev/null 等）
        ...createDeviceNodeRules(),
        // .plan 目录可读可写可执行（优先级高于工作空间只读规则）
        { resourceType: 'file', action: 'read', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${planDirNorm}/**`, effect: 'allow' },
        // 工作空间内只读
        { resourceType: 'file', action: 'read', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        // 工作空间内写入直接拒绝（.plan 之外不可写）
        { resourceType: 'file', action: 'write', pathPattern: `${workspaceNorm}/**`, effect: 'deny' },
        // 工作空间内执行允许（shell 只读命令等）
        { resourceType: 'file', action: 'execute', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        // 技能可读
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        // 敏感路径保护
        ...createSensitivePathRules(workspace)
    ];
}

/**
 * Solo Mode 权限规则：
 * - 所有文件可读可写可执行
 * - 敏感路径（.ssh、.gnupg 等）直接 deny（Solo 是无人值守模式，不能弹 ask）
 * - 技能可读
 *
 * 返回完整规则列表，使用 GlobPermissionEnforcer 处理。
 */
export function createSoloModePermissionRules(): PermissionRule[] {
    return [
        // 设备节点始终允许（/dev/stdin, /dev/null 等，优先级高于敏感路径 deny）
        ...createDeviceNodeRules(),
        // 敏感路径直接 deny（必须在 allow ** 之前，deny 优先级最高）
        ...createSensitivePathDenyRules(),
        // 所有文件可读可写可执行
        { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: '**', effect: 'allow' },
        // 网络访问允许
        { resourceType: 'network', action: 'access', pathPattern: '**', effect: 'allow' },
        // 技能可读
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' }
    ];
}

/**
 * 将 SENSITIVE_PATH_PATTERNS 转换为 deny 规则（而非 ask）。
 * Solo 模式下无人值守，敏感路径不能弹确认框，必须直接拒绝。
 */
function createSensitivePathDenyRules(): PermissionRule[] {
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
                effect: 'deny'
            });
        }
    }

    return rules;
}
