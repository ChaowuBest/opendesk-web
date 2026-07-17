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

import path from 'path';
import type { PermissionRule } from '../../../security/permission.js';
import { createDeviceNodeRules } from '../../../../utils/permissionRules.js';
import type { ModeDecl, TaskContext } from '../../common.js';
import { fromMsysPath, normalizePath } from '../../../../../utils/path.js';

/**
 * Readonly Mode 权限规则：
 * - 工作空间内文件读取 allow
 * - 所有文件写入 deny
 * - 所有文件执行 deny
 * - 工作空间外读取保持隐式 ask
 * - 技能可读
 */
export function createReadonlyModePermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(fromMsysPath(workspace)));
    const wsPattern = `${workspaceNorm}{,/**}`;

    return [
        ...createDeviceNodeRules(),
        { resourceType: 'file', action: 'read', pathPattern: wsPattern, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: '**', effect: 'deny' },
        { resourceType: 'file', action: 'execute', pathPattern: '**', effect: 'deny' },
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' }
    ];
}

export function getReadonlyModeSubPrompt(taskCtx: TaskContext): string {
    const workspace = taskCtx.getWorkspace();
    return `# 当前模式：Readonly Mode (只读模式)

你当前处于只读模式。该模式用于安全地检查和理解工作区内容，不进行任何会修改本地状态的操作。

## 约束

- 可以读取工作空间内的文件：\`${workspace}\`
- 读取工作空间外的文件需要用户确认
- 禁止写入、创建、修改或删除任何文件
- 禁止执行任何 shell 命令
- 如果用户要求修改代码、运行命令或执行会写入文件的操作，请说明当前处于只读模式，并请用户切换到 Standard、Solo 或 Unlimited 模式`;
}

/**
 * readonly mode：只读检查模式，禁止 shell 与文件写入。
 */
export const MAIN_AGENT_READONLY_MODE: ModeDecl = {
    id: 'readonly',
    name: 'Readonly',
    displayNameKey: 'mode.readonly.name',
    description:
        'Read-only mode: workspace reads are allowed; shell commands and file writes are blocked; outside reads ask for confirmation',
    descriptionKey: 'mode.readonly.description',
    icon: '🔒',
    color: '#60A5FA',
    permissionFactory: (workspace) => createReadonlyModePermissionRules(workspace),
    getSubPrompt: (taskCtx) => getReadonlyModeSubPrompt(taskCtx),
    disabledTools: [
        'executePowerShell',
        'executeBash',
        'executeZsh',
        'checkShellStatus',
        'writeFile',
        'editFile',
        'searchReplace',
        'applyPatch',
        'createSubTask',
        'attachToSubTask',
        'waitSubTask',
        'exitPlanMode',
        'addMemory',
        'removeMemory',
        'updateUserPortrait',
        'addSkillFromDirectory',
        'addSkillFromUrl',
        'addSkillFromRegistry',
        'deleteSkills',
        'refreshSkills',
        'createNote',
        'editNote',
        'deleteNotes',
        'createSoul',
        'updateSoul',
        'deleteSoul',
        'resetDefaultSoul'
    ]
};
