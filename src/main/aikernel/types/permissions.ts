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

/** Permission policy decision. */
export type PermissionEffect = 'allow' | 'deny' | 'ask';

/** Permission resource category. `*` matches every resource type. */
export type PermissionResourceType = 'file' | 'network' | 'skill' | '*';

/** Permission action. `*` matches every action. */
export type PermissionAction = 'read' | 'write' | 'execute' | 'access' | '*';

/**
 * Describes a concrete operation on a protected resource.
 *
 * Examples:
 * - `{ resourceType: 'file', action: 'read', resourcePath: '/home/user/docs/readme.md' }`
 * - `{ resourceType: 'network', action: 'access', resourcePath: 'https://api.example.com' }`
 * - `{ resourceType: 'skill', action: 'write', resourcePath: 'my-skill-name' }`
 */
export interface PermissionRequest {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    resourcePath: string;
}

/**
 * A permission rule used to initialize or update a permission policy.
 * `pathPattern` accepts glob patterns such as `/workspace/**`, `/tmp/*`, and `*`.
 */
export interface PermissionRule {
    resourceType: PermissionResourceType;
    action: PermissionAction;
    pathPattern: string;
    effect: PermissionEffect;
}
