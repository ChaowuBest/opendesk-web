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
import type { Context } from 'hono';
import { getPlatform } from '../../platforms/base.js';

function decodePath(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

export function getServerDefaultWorkspace(): string {
    try {
        return getPlatform().getEffectiveWorkspace();
    } catch {
        return process.cwd();
    }
}

export function normalizeWorkspace(value: string): string {
    return path.resolve(decodePath(value));
}

export function getRequestWorkspace(c: Context): string {
    const directory = c.req.query('directory') || c.req.header('x-opencode-directory');
    if (directory) {
        return normalizeWorkspace(directory);
    }
    return getServerDefaultWorkspace();
}

export function getTaskWorkspace(
    task: { workspace?: string; harnessContext?: { workspace?: string } } | undefined
): string {
    return task?.workspace || task?.harnessContext?.workspace || getServerDefaultWorkspace();
}

export function getRequestOrTaskWorkspace(
    c: Context,
    task: { workspace?: string; harnessContext?: { workspace?: string } } | undefined
): string {
    const directory = c.req.query('directory') || c.req.header('x-opencode-directory');
    if (directory) {
        return normalizeWorkspace(directory);
    }
    return getTaskWorkspace(task);
}

export function getRequestWorkspaceID(c: Context): string | undefined {
    return c.req.query('workspace') || c.req.header('x-opencode-workspace') || undefined;
}
