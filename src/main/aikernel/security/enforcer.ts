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

/**
 * 基于 picomatch 的权限引擎实现。
 *
 * 外部模块不应直接引用本文件——请通过 permission.ts 中的 PermissionEnforcer 接口交互。
 *
 * 三态权限策略（通过三组独立的规则列表实现）：
 * - denyRules: 匹配到即 deny
 * - askRules: 匹配到即 ask（显式保护规则，覆盖 allow）
 * - allowRules: 匹配到即 allow
 * - 三者都不匹配则为隐式 ask（默认行为）
 *
 * 规则优先级：deny > ask(显式保护) > allow > ask(隐式回退)
 *
 * 使用 picomatch 进行 glob 匹配，配置 dot: true 以正确匹配 dotfiles。
 */

import picomatch from 'picomatch';
import path from 'path';
import type { PermissionEnforcer, PermissionRequest, PermissionCheckResult, PermissionRule } from './permission.js';
import { logger } from '../../utils/logger.js';
import { createSensitivePathRules } from '../../utils/permissionRules.js';

function normalizePath(p: string): string {
    if (!p) return '';
    return p.replace(/\\/g, '/');
}

interface CompiledRule {
    resourceType: string;
    action: string;
    pathPattern: string;
    matcher: (path: string) => boolean;
}

const PICO_OPTIONS: picomatch.PicomatchOptions = { dot: true };

function compileRule(rule: PermissionRule): CompiledRule {
    const patternNorm = normalizePath(rule.pathPattern);
    return {
        resourceType: rule.resourceType,
        action: rule.action,
        pathPattern: patternNorm,
        matcher: picomatch(patternNorm, PICO_OPTIONS)
    };
}

function matchesRule(compiled: CompiledRule, resourceType: string, objNorm: string, action: string): boolean {
    return compiled.resourceType === resourceType && compiled.action === action && compiled.matcher(objNorm);
}

function matchesAny(rules: CompiledRule[], resourceType: string, objNorm: string, action: string): boolean {
    for (const rule of rules) {
        if (matchesRule(rule, resourceType, objNorm, action)) return true;
    }
    return false;
}

/**
 * 全放通权限引擎：所有权限检查直接返回 allow，用于 --allow-everything 模式。
 */
export class AllowEverythingEnforcer implements PermissionEnforcer {
    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        return { effect: 'allow', request };
    }

    async checkAll(_requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        return null;
    }

    async checkAllDetailed(_requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        return [];
    }

    async addRule(_rule: PermissionRule): Promise<void> {}
    async removeRule(_rule: PermissionRule): Promise<void> {}
}

export class GlobPermissionEnforcer implements PermissionEnforcer {
    private allowRules: CompiledRule[] = [];
    private denyRules: CompiledRule[] = [];
    private askRules: CompiledRule[] = [];

    static async create(initialRules: PermissionRule[] = []): Promise<GlobPermissionEnforcer> {
        const instance = new GlobPermissionEnforcer();
        instance.initialize(initialRules);
        return instance;
    }

    private initialize(initialRules: PermissionRule[]): void {
        for (const rule of initialRules) {
            const compiled = compileRule(rule);
            if (rule.effect === 'allow') {
                this.allowRules.push(compiled);
            } else if (rule.effect === 'deny') {
                this.denyRules.push(compiled);
            } else {
                this.askRules.push(compiled);
            }
        }
    }

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        const objNorm = normalizePath(request.resourcePath);

        // deny 优先
        if (matchesAny(this.denyRules, request.resourceType, objNorm, request.action)) {
            return {
                effect: 'deny',
                reason: `权限被拒绝: ${request.action} ${request.resourcePath}`,
                request
            };
        }

        // 显式 ask（保护规则）优先于 allow
        if (matchesAny(this.askRules, request.resourceType, objNorm, request.action)) {
            return {
                effect: 'ask',
                reason: `敏感路径需要用户确认: ${request.action} ${request.resourcePath}`,
                request
            };
        }

        // 然后检查 allow
        if (matchesAny(this.allowRules, request.resourceType, objNorm, request.action)) {
            return {
                effect: 'allow',
                request
            };
        }

        // 都不匹配则为隐式 ask
        return {
            effect: 'ask',
            reason: `需要用户确认: ${request.action} ${request.resourcePath}`,
            request
        };
    }

    async checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') {
                return result;
            }
        }
        return null;
    }

    /**
     * 批量检查权限请求，返回所有非 allow 的结果列表。
     * 全部 allow 时返回空数组。
     */
    async checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        const results: PermissionCheckResult[] = [];
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') {
                results.push(result);
            }
        }
        return results;
    }

    async addRule(rule: PermissionRule): Promise<void> {
        const compiled = compileRule(rule);

        if (rule.effect === 'allow') {
            this.allowRules.push(compiled);
        } else if (rule.effect === 'deny') {
            this.denyRules.push(compiled);
        } else {
            this.askRules.push(compiled);
        }

        logger.info(
            `permission rule added: ${rule.effect} ${rule.resourceType}:${rule.action} ${compiled.pathPattern}`
        );
    }

    async removeRule(rule: PermissionRule): Promise<void> {
        const patternNorm = normalizePath(rule.pathPattern);

        const removeFrom = (list: CompiledRule[]): CompiledRule[] =>
            list.filter(
                (r) =>
                    !(r.resourceType === rule.resourceType && r.action === rule.action && r.pathPattern === patternNorm)
            );

        if (rule.effect === 'allow') {
            this.allowRules = removeFrom(this.allowRules);
        } else if (rule.effect === 'deny') {
            this.denyRules = removeFrom(this.denyRules);
        } else {
            this.askRules = removeFrom(this.askRules);
        }

        logger.info(`permission rule removed: ${rule.effect} ${rule.resourceType}:${rule.action} ${patternNorm}`);
    }
}

/**
 * 为指定的工作空间创建默认权限规则。
 *
 * 默认策略：
 * - 工作空间内的文件读写执行 → allow（包括 dotfiles，如 .gitignore、.eslintrc 等）
 * - 工作空间内的敏感路径（.ssh、.gnupg 等） → ask（显式保护，覆盖 allow）
 * - 工作空间外的文件读写执行 → ask（隐式回退）
 * - 网络访问 → ask（隐式回退）
 * - 技能读取 → allow（所有技能均可读取/加载）
 * - 技能写入 → ask（隐式回退，需用户确认）
 */
export function createDefaultPermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(workspace));

    return [
        // 工作空间内读写允许（dot: true 确保 .gitignore 等 dotfiles 也被匹配）
        { resourceType: 'file', action: 'read', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        // 所有技能读取允许（加载、查看等），写入/执行需用户确认（隐式 ask）
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' },
        // 敏感路径保护规则（即使在工作空间内也需要用户确认）
        ...createSensitivePathRules(workspace)
    ];
}
