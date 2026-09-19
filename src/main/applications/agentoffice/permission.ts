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
import { GlobPermissionEnforcer } from '../../aikernel/security/enforcer.js';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionRequest,
    PermissionRule
} from '../../aikernel/security/permission.js';
import { normalizePath } from '../../../utils/path.js';
import { t } from './locale/index.js';
import type { StaffPermission } from './common.js';

class DenyByDefaultPermissionEnforcer implements PermissionEnforcer {
    constructor(private readonly delegate: GlobPermissionEnforcer) {}

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        const canonicalRequest =
            request.resourceType === 'file'
                ? { ...request, resourcePath: resolveThroughSymlinks(request.resourcePath) }
                : request;
        const result = await this.delegate.check(canonicalRequest);
        if (result.effect === 'allow') return { ...result, request };
        if (result.effect !== 'ask') return result;
        return {
            effect: 'deny',
            reason: t('agentoffice.error.resourceDenied', { path: request.resourcePath }),
            request
        };
    }

    async checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') return result;
        }
        return null;
    }

    async checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        const results = await Promise.all(requests.map((request) => this.check(request)));
        return results.filter((result) => result.effect !== 'allow');
    }

    async addRule(rule: PermissionRule): Promise<void> {
        await this.delegate.addRule(rule);
    }

    async removeRule(rule: PermissionRule): Promise<void> {
        await this.delegate.removeRule(rule);
    }
}

function directoryPattern(directory: string): string {
    return `${normalizePath(resolveThroughSymlinks(directory))}{,/**}`;
}

function resolveThroughSymlinks(filePath: string): string {
    let existingPath = path.resolve(filePath);
    const missingSegments: string[] = [];
    while (!fs.existsSync(existingPath)) {
        const parent = path.dirname(existingPath);
        if (parent === existingPath) return path.resolve(filePath);
        missingSegments.unshift(path.basename(existingPath));
        existingPath = parent;
    }
    return path.join(fs.realpathSync.native(existingPath), ...missingSegments);
}

export async function createStaffPermissionEnforcer(options: {
    workspace: string;
    resourcesDirectory: string;
    protectedDirectory: string;
    permission: StaffPermission;
}): Promise<PermissionEnforcer> {
    const rules: PermissionRule[] = [
        {
            resourceType: 'file',
            action: '*',
            pathPattern: directoryPattern(options.protectedDirectory),
            effect: 'deny'
        },
        {
            resourceType: 'file',
            action: 'read',
            pathPattern: directoryPattern(options.workspace),
            effect: 'allow'
        },
        {
            resourceType: 'file',
            action: 'write',
            pathPattern: directoryPattern(options.workspace),
            effect: 'allow'
        },
        {
            resourceType: 'file',
            action: 'execute',
            pathPattern: directoryPattern(options.workspace),
            effect: 'allow'
        },
        {
            resourceType: 'file',
            action: 'read',
            pathPattern: directoryPattern(options.resourcesDirectory),
            effect: 'allow'
        },
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        {
            resourceType: 'network',
            action: 'access',
            pathPattern: '**',
            effect: options.permission.network_access ? 'allow' : 'deny'
        }
    ];
    for (const directory of options.permission.directories) {
        rules.push({
            resourceType: 'file',
            action: 'read',
            pathPattern: directoryPattern(directory.path),
            effect: 'allow'
        });
        if (directory.access === 'readwrite') {
            rules.push({
                resourceType: 'file',
                action: 'write',
                pathPattern: directoryPattern(directory.path),
                effect: 'allow'
            });
        }
    }
    return new DenyByDefaultPermissionEnforcer(await GlobPermissionEnforcer.create(rules));
}
