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
 * - 所有资源类型、所有操作全部允许（不限制任何权限）
 * - 敏感路径也允许（真正无限制）
 *
 * 这是最宽松的模式，等价于 --allow-everything。
 * 使用 resourceType='*' + action='*' 通配，新增资源类型时无需修改此文件。
 */
export function createUnlimitedModePermissionRules(): PermissionRule[] {
    return [
        // 设备节点始终允许
        ...createDeviceNodeRules(),
        // 所有资源、所有操作全部放通
        { resourceType: '*', action: '*', pathPattern: '**', effect: 'allow' }
    ];
}

/**
 * unlimited mode：无限制模式，所有权限全部放通（不限制任何权限）。
 * 等价于 --allow-everything 参数。
 */
export const MAIN_AGENT_UNLIMITED_MODE: ModeDecl = {
    id: 'unlimited',
    name: 'Unlimited',
    displayNameKey: 'mode.unlimited.name',
    description: 'Unlimited mode: all permissions are allowed without restriction',
    descriptionKey: 'mode.unlimited.description',
    icon: '🔓',
    color: '#FF4081',
    permissionFactory: (_workspace) => createUnlimitedModePermissionRules(),
    bypassPermissionChecks: true,
    disabledTools: ['askUser', 'exitPlanMode']
};
