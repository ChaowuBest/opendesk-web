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

import picomatch from 'picomatch';
import { logger } from '../../utils/logger.js';
import type {
    PermissionCheckResult,
    PermissionEnforcer,
    PermissionRequest,
    PermissionRule,
    PermissionToolCallContext
} from '../../aikernel/security/permission.js';
import { ConfigPermissionPolicy, parseConfigPermission, type PermissionConfigIssue } from './permission-config.js';

export type ConfigPermissionReloadResult =
    | { status: 'active' }
    | { status: 'missing' }
    | { status: 'invalid'; issues: PermissionConfigIssue[] }
    | { status: 'disabled' };

interface RuntimeSnapshot {
    generation: number;
    policy: ConfigPermissionPolicy | null;
}

interface SessionRule {
    rule: PermissionRule;
    matcher: (value: string) => boolean;
}

export class ConfigPermissionRuntime {
    private generation = 0;
    private policy: ConfigPermissionPolicy | null = null;

    constructor(
        readonly enabled: boolean,
        initialPermission?: unknown
    ) {
        this.reload(initialPermission);
    }

    reload(rawPermission: unknown): ConfigPermissionReloadResult {
        if (!this.enabled) {
            return { status: 'disabled' };
        }

        const parsed = parseConfigPermission(rawPermission);
        this.generation++;
        if (parsed.status === 'active') {
            this.policy = parsed.policy;
            return { status: 'active' };
        }

        this.policy = null;
        if (parsed.status === 'invalid') {
            const issueSummary = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ');
            logger.warn(`configured permissions are invalid; falling back to mode permissions: ${issueSummary}`);
            return parsed;
        }
        return parsed;
    }

    getSnapshot(): RuntimeSnapshot {
        return { generation: this.generation, policy: this.policy };
    }

    wrapEnforcer(workspace: string, fallback: PermissionEnforcer): PermissionEnforcer {
        if (!this.enabled) {
            return fallback;
        }
        if (fallback instanceof DynamicConfigPermissionEnforcer && fallback.runtime === this) {
            fallback.setWorkspace(workspace);
            return fallback;
        }
        return new DynamicConfigPermissionEnforcer(this, workspace, fallback);
    }

    wrapTask(task: {
        harnessContext?: { permission?: PermissionEnforcer | null; workspace?: string };
        getWorkspace?: () => string;
        workspace?: string;
    }): void {
        if (!this.enabled) return;
        const fallback = task.harnessContext?.permission;
        if (!fallback || !task.harnessContext) return;
        const workspace = task.harnessContext.workspace || task.getWorkspace?.() || task.workspace || '';
        task.harnessContext.permission = this.wrapEnforcer(workspace, fallback);
    }
}

export class DynamicConfigPermissionEnforcer implements PermissionEnforcer {
    private fallback: PermissionEnforcer;
    private workspace: string;
    private observedGeneration = -1;
    private sessionRules: SessionRule[] = [];

    constructor(
        readonly runtime: ConfigPermissionRuntime,
        workspace: string,
        fallback: PermissionEnforcer
    ) {
        this.workspace = workspace;
        this.fallback = fallback;
    }

    setWorkspace(workspace: string): void {
        this.workspace = workspace;
    }

    setFallbackEnforcer(enforcer: PermissionEnforcer): void {
        this.fallback = enforcer;
    }

    private snapshot(): RuntimeSnapshot {
        const snapshot = this.runtime.getSnapshot();
        if (snapshot.generation !== this.observedGeneration) {
            this.observedGeneration = snapshot.generation;
            this.sessionRules = [];
        }
        return snapshot;
    }

    private getSessionResult(request: PermissionRequest): PermissionCheckResult | null {
        let matchedRule: PermissionRule | undefined;
        for (const item of this.sessionRules) {
            const typeMatches = item.rule.resourceType === '*' || item.rule.resourceType === request.resourceType;
            const actionMatches = item.rule.action === '*' || item.rule.action === request.action;
            if (typeMatches && actionMatches && item.matcher(request.resourcePath)) {
                matchedRule = item.rule;
            }
        }
        return matchedRule ? { effect: matchedRule.effect, request } : null;
    }

    async check(request: PermissionRequest): Promise<PermissionCheckResult> {
        const snapshot = this.snapshot();
        if (!snapshot.policy) {
            return this.fallback.check(request);
        }
        return this.getSessionResult(request) || snapshot.policy.check(request, this.workspace);
    }

    async checkAll(requests: PermissionRequest[]): Promise<PermissionCheckResult | null> {
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') return result;
        }
        return null;
    }

    async checkAllDetailed(requests: PermissionRequest[]): Promise<PermissionCheckResult[]> {
        const results: PermissionCheckResult[] = [];
        for (const request of requests) {
            const result = await this.check(request);
            if (result.effect !== 'allow') results.push(result);
        }
        return results;
    }

    async checkToolCall(context: PermissionToolCallContext): Promise<PermissionCheckResult[]> {
        const snapshot = this.snapshot();
        if (!snapshot.policy) {
            return this.fallback.checkToolCall?.(context) || [];
        }

        const configuredResults = snapshot.policy.checkToolCall(context);
        if (configuredResults.length === 0) return [];
        const sessionResult = this.getSessionResult(configuredResults[0].request);
        return sessionResult?.effect === 'allow' ? [] : sessionResult ? [sessionResult] : configuredResults;
    }

    async addRule(rule: PermissionRule): Promise<void> {
        const snapshot = this.snapshot();
        if (!snapshot.policy) {
            await this.fallback.addRule(rule);
            return;
        }
        this.sessionRules.push({
            rule,
            matcher: picomatch(rule.pathPattern, {
                dot: true,
                nocase: process.platform === 'win32'
            })
        });
    }

    async removeRule(rule: PermissionRule): Promise<void> {
        const snapshot = this.snapshot();
        if (!snapshot.policy) {
            await this.fallback.removeRule(rule);
            return;
        }
        this.sessionRules = this.sessionRules.filter(
            (item) =>
                item.rule.resourceType !== rule.resourceType ||
                item.rule.action !== rule.action ||
                item.rule.pathPattern !== rule.pathPattern ||
                item.rule.effect !== rule.effect
        );
    }
}
