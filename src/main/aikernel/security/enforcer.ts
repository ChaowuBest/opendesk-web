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
 * 基于 casbin 的权限引擎封装。
 *
 * 外部模块不应直接引用本文件——请通过 permission.ts 中的 PermissionEnforcer 接口交互。
 * 本文件是 PermissionEnforcer 的唯一实现，负责将 casbin 的细节完全隐藏在封装层内。
 *
 * 三态权限策略：
 * casbin 原生仅支持 allow/deny 两态。我们通过维护两个 enforcer 来实现三态：
 * - allowEnforcer: 只包含 allow 规则，匹配到即 allow
 * - denyEnforcer: 只包含 deny 规则，匹配到即 deny
 * - 两者都不匹配则为 ask（默认行为）
 *
 * 规则优先级：deny > allow > ask
 */

import { newModelFromString, Enforcer as CasbinEnforcer, StringAdapter } from 'casbin';
import path from 'path';
import type {
    PermissionEnforcer,
    PermissionRequest,
    PermissionCheckResult,
    PermissionRule,
    PermissionEffect
} from './permission.js';
import { logger } from '../../utils/logger.js';

/**
 * casbin 模型定义（简单 ACL）
 * request: 资源类型(res_type), 资源路径(obj), 操作(act)
 * policy:  资源类型(res_type), 路径模式(obj), 操作(act)
 * matcher: globMatch 进行路径匹配
 */
const CASBIN_MODEL = `
[request_definition]
r = res_type, obj, act

[policy_definition]
p = res_type, obj, act

[policy_effect]
e = some(where (p_eft == allow))

[matchers]
m = r.res_type == p.res_type && globMatch(r.obj, p.obj) && r.act == p.act
`.trim();

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/');
}

async function createCasbinEnforcer(policyLines: string): Promise<CasbinEnforcer> {
    const model = newModelFromString(CASBIN_MODEL);
    // StringAdapter 不接受空字符串，用一个不会被匹配的占位规则
    const effectivePolicy = policyLines.trim() || 'p, __noop__, __noop__, __noop__';
    const adapter = new StringAdapter(effectivePolicy);
    const enforcer = new CasbinEnforcer();
    await enforcer.initWithModelAndAdapter(model, adapter);
    await enforcer.loadPolicy();
    return enforcer;
}

export class CasbinPermissionEnforcer implements PermissionEnforcer {
    private allowEnforcer!: CasbinEnforcer;
    private denyEnforcer!: CasbinEnforcer;
    private askRules: PermissionRule[] = [];
    private initialized = false;

    static async create(initialRules: PermissionRule[] = []): Promise<CasbinPermissionEnforcer> {
        const instance = new CasbinPermissionEnforcer();
        await instance.initialize(initialRules);
        return instance;
    }

    private async initialize(initialRules: PermissionRule[]): Promise<void> {
        const allowLines: string[] = [];
        const denyLines: string[] = [];

        for (const rule of initialRules) {
            const patternNorm = normalizePath(rule.pathPattern);
            const line = `p, ${rule.resourceType}, ${patternNorm}, ${rule.action}`;
            if (rule.effect === 'allow') {
                allowLines.push(line);
            } else if (rule.effect === 'deny') {
                denyLines.push(line);
            } else {
                this.askRules.push(rule);
            }
        }

        this.allowEnforcer = await createCasbinEnforcer(allowLines.join('\n'));
        this.denyEnforcer = await createCasbinEnforcer(denyLines.join('\n'));
        this.initialized = true;
    }

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        if (!this.initialized) {
            throw new Error('PermissionEnforcer not initialized');
        }

        const objNorm = normalizePath(request.resourcePath);

        // deny 优先
        const denied = await this.denyEnforcer.enforce(request.resourceType, objNorm, request.action);
        if (denied) {
            return {
                effect: 'deny',
                reason: `权限被拒绝: ${request.action} ${request.resourcePath}`,
                request
            };
        }

        // 然后检查 allow
        const allowed = await this.allowEnforcer.enforce(request.resourceType, objNorm, request.action);
        if (allowed) {
            return {
                effect: 'allow',
                request
            };
        }

        // 都不匹配则为 ask
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
        if (!this.initialized) {
            throw new Error('PermissionEnforcer not initialized');
        }

        const patternNorm = normalizePath(rule.pathPattern);

        if (rule.effect === 'allow') {
            await this.allowEnforcer.addPolicy(rule.resourceType, patternNorm, rule.action);
        } else if (rule.effect === 'deny') {
            await this.denyEnforcer.addPolicy(rule.resourceType, patternNorm, rule.action);
        } else {
            this.askRules.push(rule);
        }

        logger.info(`permission rule added: ${rule.effect} ${rule.resourceType}:${rule.action} ${patternNorm}`);
    }

    async removeRule(rule: PermissionRule): Promise<void> {
        if (!this.initialized) {
            throw new Error('PermissionEnforcer not initialized');
        }

        const patternNorm = normalizePath(rule.pathPattern);

        if (rule.effect === 'allow') {
            await this.allowEnforcer.removePolicy(rule.resourceType, patternNorm, rule.action);
        } else if (rule.effect === 'deny') {
            await this.denyEnforcer.removePolicy(rule.resourceType, patternNorm, rule.action);
        } else {
            this.askRules = this.askRules.filter(
                (r) =>
                    !(
                        r.resourceType === rule.resourceType &&
                        r.action === rule.action &&
                        normalizePath(r.pathPattern) === patternNorm
                    )
            );
        }

        logger.info(`permission rule removed: ${rule.effect} ${rule.resourceType}:${rule.action} ${patternNorm}`);
    }
}

/**
 * 为指定的工作空间创建默认权限规则。
 *
 * 默认策略：
 * - 工作空间内的文件读写执行 → allow
 * - 工作空间外的文件读写执行 → ask（隐式回退）
 * - 网络访问 → ask（隐式回退）
 * - 技能读取 → allow（所有技能均可读取/加载）
 * - 技能写入 → ask（隐式回退，需用户确认）
 */
export function createDefaultPermissionRules(workspace: string): PermissionRule[] {
    const workspaceNorm = normalizePath(path.resolve(workspace));

    return [
        // 工作空间内读写允许
        { resourceType: 'file', action: 'read', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        { resourceType: 'file', action: 'execute', pathPattern: `${workspaceNorm}/**`, effect: 'allow' },
        // 所有技能读取允许（加载、查看等），写入/执行需用户确认（隐式 ask）
        { resourceType: 'skill', action: 'read', pathPattern: '**', effect: 'allow' }
    ];
}
