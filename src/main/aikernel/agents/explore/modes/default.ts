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
import type { ModeDecl } from '../../common.js';
import path from 'path';
import { createSensitivePathRules, createDeviceNodeRules } from '../../../../utils/permissionRules.js';

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

/**
 * Explore agent 专用权限规则。
 *
 * 核心设计：不设置 permissionPrompt，所有 ask 请求会因无 promptProvider 自动拒绝。
 * - 工作空间内：读取+执行 allow，写入 deny
 * - 工作空间外：不匹配任何 allow → implicit ask → 自动拒绝
 * - 敏感路径：继承 SensitivePathRules（ask→自动拒绝）
 * - Skill 读取：allow
 * - 设备节点：allow
 */
function createExplorePermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(workspace));

    return [
        ...createDeviceNodeRules(),
        // 工作空间根目录本身允许读取和执行（ls 等命令会声明 read <workspace>）
        { resourceType: 'file', action: 'read', pathPattern: workspaceNorm, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: workspaceNorm, effect: 'allow' },
        // 工作空间内只读 + 执行（不包含 write）
        { resourceType: 'file', action: 'read', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        // 工作空间根目录及内部写入显式拒绝
        { resourceType: 'file', action: 'write', pathPattern: workspaceNorm, effect: 'deny' },
        { resourceType: 'file', action: 'write', pathPattern: `${workspaceNorm}/**`, effect: 'deny' },
        // Skill 读取允许
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        // 敏感路径保护（ask，因无 promptProvider 自动拒绝）
        ...createSensitivePathRules(workspace)
    ];
}

export const EXPLORE_AGENT_DEFAULT_MODE: ModeDecl = {
    id: 'default',
    name: 'default',
    description: '只读探索模式，仅可搜索和阅读代码',
    icon: '🔍',
    color: '#4CAF50',
    permissionFactory: (workspace) => createExplorePermissionRules(workspace),
    disabledTools: ['editFile', 'writeFile', 'createSubTask']
};
