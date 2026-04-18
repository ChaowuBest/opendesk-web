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

import type { PermissionRule } from '../../../security/permission.js';
import { createDeviceNodeRules } from '../../../../utils/permissionRules.js';
import type { ModeDecl } from '../../common.js';

/**
 * Unlimited Mode 权限规则：
 * - 所有文件、网络、技能全部允许（不限制任何权限）
 * - 敏感路径也允许（真正无限制）
 *
 * 这是最宽松的模式，等价于 --allow-everything。
 */
export function createUnlimitedModePermissionRules(): PermissionRule[] {
    return [
        // 设备节点始终允许
        ...createDeviceNodeRules(),
        // 所有文件可读可写可执行（包括敏感路径）
        { resourceType: 'file', action: 'read', pathPattern: '**', effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: '**', effect: 'allow' },
        // 网络访问允许
        { resourceType: 'network', action: 'access', pathPattern: '**', effect: 'allow' },
        // 技能可读可执行
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        { resourceType: 'skill', action: 'execute', pathPattern: '**', effect: 'allow' }
    ];
}

/**
 * unlimited mode：无限制模式，所有权限全部放通（不限制任何权限）。
 * 等价于 --allow-everything 参数。
 */
export const MAIN_AGENT_UNLIMITED_MODE: ModeDecl = {
    id: 'unlimited',
    name: 'unlimited',
    description: '无限制模式，所有权限全部放通',
    icon: '🔓',
    color: '#FF4081',
    permissionFactory: (_workspace) => createUnlimitedModePermissionRules(),
    disabledTools: ['askUser']
};
