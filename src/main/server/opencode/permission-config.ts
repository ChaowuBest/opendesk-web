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
import picomatch from 'picomatch';
import { normalizePath } from '../../../utils/path.js';
import { splitBashCommands } from '../../applications/terminal/shellPermissions.js';
import type {
    PermissionCheckResult,
    PermissionEffect,
    PermissionRequest,
    PermissionToolCallContext
} from '../../aikernel/security/permission.js';

const SUPPORTED_PERMISSION_NAMES = new Set(['bash', 'read', 'external_directory']);
const IS_WINDOWS = process.platform === 'win32';
const EFFECT_PRIORITY: Record<PermissionEffect, number> = {
    allow: 0,
    ask: 1,
    deny: 2
};

interface CompiledConfigRule {
    pattern: string;
    effect: PermissionEffect;
    matcher: (value: string) => boolean;
}

export interface PermissionConfigIssue {
    path: string;
    message: string;
}

export type PermissionConfigParseResult =
    | { status: 'active'; policy: ConfigPermissionPolicy }
    | { status: 'missing' }
    | { status: 'invalid'; issues: PermissionConfigIssue[] };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPermissionEffect(value: unknown): value is PermissionEffect {
    return value === 'allow' || value === 'ask' || value === 'deny';
}

function normalizeMatchValue(permissionName: string, value: string): string {
    return permissionName === 'bash' ? value.trim() : normalizePath(value);
}

function compilePattern(permissionName: string, pattern: string): (value: string) => boolean {
    const normalizedPattern = normalizeMatchValue(permissionName, pattern);
    const isBashPattern = permissionName === 'bash';
    return picomatch(normalizedPattern, {
        bash: isBashPattern,
        dot: true,
        nocase: IS_WINDOWS,
        windows: isBashPattern ? false : IS_WINDOWS
    });
}

function strongestEffect(effects: PermissionEffect[]): PermissionEffect {
    return effects.reduce(
        (strongest, effect) => (EFFECT_PRIORITY[effect] > EFFECT_PRIORITY[strongest] ? effect : strongest),
        'allow'
    );
}

function isPathOutsideWorkspace(resourcePath: string, workspace: string): boolean {
    if (!workspace) return true;
    const resolvedWorkspace = path.resolve(workspace);
    const resolvedResource = path.resolve(resourcePath);
    const relative = path.relative(resolvedWorkspace, resolvedResource);
    return relative !== '' && (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative));
}

function isShellTool(toolName: string): boolean {
    const normalized = toolName.toLowerCase();
    return (
        normalized === 'executebash' ||
        normalized === 'executezsh' ||
        normalized === 'executepwsh' ||
        normalized === 'executepowershell'
    );
}

export class ConfigPermissionPolicy {
    constructor(
        private readonly defaultEffect: PermissionEffect,
        private readonly rules: ReadonlyMap<string, readonly CompiledConfigRule[]>
    ) {}

    private evaluateAlternatives(permissionName: string, candidates: string[]): PermissionEffect {
        const permissionRules = this.rules.get(permissionName) || [];
        let effect = this.defaultEffect;
        for (const rule of permissionRules) {
            for (const candidate of candidates) {
                const normalizedCandidate = normalizeMatchValue(permissionName, candidate);
                if (rule.matcher(normalizedCandidate)) {
                    effect = rule.effect;
                    break;
                }
            }
        }
        return effect;
    }

    check(request: PermissionRequest, workspace: string): PermissionCheckResult {
        const effects = [this.defaultEffect];
        if (request.resourceType === 'file' && request.action === 'read') {
            const readCandidates = [request.resourcePath];
            if (workspace) {
                readCandidates.push(path.relative(path.resolve(workspace), path.resolve(request.resourcePath)));
            }
            effects[0] = this.evaluateAlternatives('read', readCandidates);
        }
        if (request.resourceType === 'file' && isPathOutsideWorkspace(request.resourcePath, workspace)) {
            effects.push(this.evaluateAlternatives('external_directory', [request.resourcePath]));
        }
        return { effect: strongestEffect(effects), request };
    }

    checkToolCall(context: PermissionToolCallContext): PermissionCheckResult[] {
        if (!isShellTool(context.toolName)) return [];
        const command = context.args.command;
        if (typeof command !== 'string' || command.trim().length === 0) return [];

        const normalizedCommand = command.trim();
        const candidates = [normalizedCommand, ...splitBashCommands(normalizedCommand)];
        const effect = strongestEffect(
            Array.from(new Set(candidates)).map((candidate) => this.evaluateAlternatives('bash', [candidate]))
        );
        if (effect === 'allow') return [];
        return [
            {
                effect,
                request: {
                    resourceType: '*',
                    action: 'execute',
                    resourcePath: normalizedCommand
                }
            }
        ];
    }
}

export function parseConfigPermission(rawPermission: unknown): PermissionConfigParseResult {
    if (rawPermission === undefined || rawPermission === null) {
        return { status: 'missing' };
    }
    if (!isRecord(rawPermission)) {
        return {
            status: 'invalid',
            issues: [{ path: 'permission', message: 'must be an object' }]
        };
    }

    const issues: PermissionConfigIssue[] = [];
    const defaultEffect = rawPermission['*'];
    if (!isPermissionEffect(defaultEffect)) {
        issues.push({ path: 'permission.*', message: 'is required and must be allow, ask, or deny' });
    }

    const compiledRules = new Map<string, CompiledConfigRule[]>();
    for (const [permissionName, value] of Object.entries(rawPermission)) {
        if (permissionName === '*') continue;
        if (!SUPPORTED_PERMISSION_NAMES.has(permissionName)) {
            issues.push({ path: `permission.${permissionName}`, message: 'is not supported by this version' });
            continue;
        }

        const rawRules = isPermissionEffect(value) ? { '**': value } : value;
        if (!isRecord(rawRules)) {
            issues.push({
                path: `permission.${permissionName}`,
                message: 'must be allow, ask, deny, or an object of pattern rules'
            });
            continue;
        }

        const rules: CompiledConfigRule[] = [];
        for (const [pattern, effect] of Object.entries(rawRules)) {
            const issuePath = `permission.${permissionName}.${pattern}`;
            if (!pattern) {
                issues.push({ path: issuePath, message: 'pattern must not be empty' });
                continue;
            }
            if (!isPermissionEffect(effect)) {
                issues.push({ path: issuePath, message: 'must be allow, ask, or deny' });
                continue;
            }
            try {
                rules.push({
                    pattern,
                    effect,
                    matcher: compilePattern(permissionName, pattern)
                });
            } catch (error) {
                issues.push({
                    path: issuePath,
                    message: error instanceof Error ? error.message : 'invalid glob pattern'
                });
            }
        }
        compiledRules.set(permissionName, rules);
    }

    if (issues.length > 0 || !isPermissionEffect(defaultEffect)) {
        return { status: 'invalid', issues };
    }
    return {
        status: 'active',
        policy: new ConfigPermissionPolicy(defaultEffect, compiledRules)
    };
}
