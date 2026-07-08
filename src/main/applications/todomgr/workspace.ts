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

import fs from 'fs';
import path from 'path';
import type { TodoWorkspaceConfig } from './common.js';
import { Setting, getOpendeskDirectory } from '../../utils/setting.js';

export interface ResolveTodoWorkspaceOptions {
    appDirectory?: string;
    defaultWorkspace?: string;
    ensureDirectory?: boolean;
}

function ensureDirectory(directory: string): string {
    fs.mkdirSync(directory, { recursive: true });
    return directory;
}

function sanitizeWorkspaceSegment(value: string): string {
    const normalized = value
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '-')
        .replace(/-+/g, '-');
    return normalized || 'unknown';
}

export function getTodoIsolatedWorkspacePath(todoId: string, appDirectory = getOpendeskDirectory()): string {
    return path.join(appDirectory, 'workspaces', `job-${sanitizeWorkspaceSegment(todoId)}`);
}

export function resolveTodoWorkspace(
    todoId: string,
    config?: TodoWorkspaceConfig,
    options: ResolveTodoWorkspaceOptions = {}
): string {
    const workspaceConfig = config ?? { type: 'default' as const };
    if (workspaceConfig.type === 'path') {
        return path.resolve(workspaceConfig.path);
    }

    if (workspaceConfig.type === 'isolated') {
        const isolatedPath = getTodoIsolatedWorkspacePath(todoId, options.appDirectory);
        return options.ensureDirectory === false ? isolatedPath : ensureDirectory(isolatedPath);
    }

    return options.defaultWorkspace ?? Setting.getInstance().getEffectiveWorkspace();
}
