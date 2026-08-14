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

import type { PermissionRule, PermissionAction } from '../../../security/permission.js';
import { createDeviceNodeRules, SENSITIVE_PATH_PATTERNS } from '../../../../utils/permissionRules.js';
import os from 'os';
import type { ModeDecl } from '../../common.js';

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
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
 * solo mode：全权限无人值守模式，工作空间内外均可读写，敏感路径直接 deny
 */
export const MAIN_AGENT_SOLO_MODE: ModeDecl = {
    id: 'solo',
    name: 'Solo',
    displayNameKey: 'mode.solo.name',
    description: 'High-permission unattended mode: everything is automatically allowed except a few sensitive paths',
    descriptionKey: 'mode.solo.description',
    icon: '🎮',
    color: '#00E676',
    permissionFactory: (_workspace) => createSoloModePermissionRules(),
    interactive: false
};
