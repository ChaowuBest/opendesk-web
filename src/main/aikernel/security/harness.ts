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
 * HarnessContext —— 除了聊天信息 (chatContext) 之外，由外部工程框架提供给 agent 的
 * 信息与约束的集合。
 *
 * 设计原则：
 * - harnessContext 不会被落盘（不参与 toJSON / 导入导出），因为其中的 environ 等字段
 *   可能包含用户的敏感数据（如 API key）
 * - 每次任务启动时由宿主环境（TUI / Electron）构建并注入
 */

import type { PermissionEnforcer, PermissionPromptProvider, PermissionRule } from './permission.js';
import { GlobPermissionEnforcer, createDefaultPermissionRules, ReadableDirectoryRegistry } from './enforcer.js';
import type { ModeDecl } from '../agents/common.js';
import { normalizePath } from '../../../utils/path.js';
import path from 'path';

export function createTaskArtifactPermissionRules(artifactDirectory: string): PermissionRule[] {
    const dirNorm = normalizePath(path.resolve(artifactDirectory));
    const pattern = `${dirNorm}{,/**}`;
    return [
        { resourceType: 'file', action: 'read', pathPattern: pattern, effect: 'allow' },
        { resourceType: 'file', action: 'write', pathPattern: pattern, effect: 'allow' }
    ];
}

export type NodeExecutionCapabilities = {
    nodeId: string;
    displayName?: string;
    platform?: string;
    workspace?: string;
    commands: string[];
    shells: string[];
    defaultShell?: string;
};

export type ExecutionNodeSummary = NodeExecutionCapabilities & {
    connected: true;
    caps: string[];
    deviceFamily?: string;
    modelIdentifier?: string;
    version?: string;
    remoteIp?: string;
    connectedAtMs: number;
};

let _executionNodeListProvider: (() => ExecutionNodeSummary[]) | null = null;

/**
 * 注册可用节点列表的提供者。由 applications/devicemgr 层调用，
 * 避免 aikernel 直接依赖 applications 层。
 */
export function registerExecutionNodeListProvider(provider: () => ExecutionNodeSummary[]): void {
    _executionNodeListProvider = provider;
}

/**
 * 获取当前可用的执行节点列表。
 */
export function listExecutionNodes(): ExecutionNodeSummary[] {
    return _executionNodeListProvider?.() ?? [];
}

export type ExecutionHost =
    | { type: 'local' }
    | {
          type: 'node';
          nodeId: string;
          nodeLabel?: string;
          capabilities: NodeExecutionCapabilities;
      };

export class HarnessContext {
    /**
     * 环境变量上下文：skill 的 .env 会合并到此处，终端类工具执行时注入到子进程
     * 按优先级合并：系统 env < skill .env（后加载的覆盖先加载的）
     */
    environ: Record<string, string> = {};

    /**
     * 权限引擎实例，用于检查工具调用的权限
     */
    permission: PermissionEnforcer | null = null;

    /**
     * 权限确认 UI 提供者（TUI / Electron 各自实现）
     * 当权限检查结果为 'ask' 时通过此接口向用户请求确认
     */
    permissionPrompt: PermissionPromptProvider | null = null;

    /**
     * 当前任务的工作空间路径
     */
    workspace?: string;

    /**
     * 当前任务选择的执行宿主。Local 使用 OpenDesk 本机工具；选择 node 后，
     * 由 devicemgr 暴露的 node 工具访问远端 shell/file 能力。
     */
    executionHost: ExecutionHost = { type: 'local' };

    /**
     * 创建带有默认权限的 HarnessContext
     * @param workspace 当前工作空间路径
     */
    static async createWithDefaults(workspace: string): Promise<HarnessContext> {
        const ctx = new HarnessContext();
        ctx.workspace = workspace;

        const rules = createDefaultPermissionRules(workspace);
        ctx.permission = await GlobPermissionEnforcer.create(rules);

        // 追加外部注册的可读目录规则（如 skill 目录）
        for (const rule of ReadableDirectoryRegistry.getInstance().getReadRules()) {
            await ctx.permission.addRule(rule);
        }

        return ctx;
    }

    /**
     * 根据 ModeDecl 创建 HarnessContext。
     * 使用 Mode 的 permissionFactory 返回的规则创建 GlobPermissionEnforcer。
     *
     * 注意：模式特有的资源初始化（如 Plan Mode 的 .plan 目录创建）
     * 已移至 ModeDecl.onEnterMode 钩子中，由框架在模式切换时调用。
     */
    static async createForMode(workspace: string, mode: ModeDecl): Promise<HarnessContext> {
        const ctx = new HarnessContext();
        ctx.workspace = workspace;

        const rules = mode.permissionFactory(workspace);
        ctx.permission = await GlobPermissionEnforcer.create(rules);

        // 追加外部注册的可读目录规则（如 skill 目录）
        for (const rule of ReadableDirectoryRegistry.getInstance().getReadRules()) {
            await ctx.permission.addRule(rule);
        }

        return ctx;
    }

    /**
     * 为指定任务的 artifacts 目录追加完整读写权限。
     * 每个任务应当对自己的 artifacts/<taskId>/ 目录拥有不受限的文件读写权限，
     * 以支持 compaction 产物落盘、session memory 写入等内部操作。
     */
    async grantTaskArtifactAccess(artifactDirectory: string): Promise<void> {
        if (!this.permission) return;

        for (const rule of createTaskArtifactPermissionRules(artifactDirectory)) {
            await this.permission.addRule(rule);
        }
    }

    /**
     * 创建不带权限引擎的空 HarnessContext（用于向后兼容或测试）
     */
    static createEmpty(): HarnessContext {
        return new HarnessContext();
    }
}
