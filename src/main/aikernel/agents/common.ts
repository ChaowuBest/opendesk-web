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

import type { PermissionRule } from '../security/permission.js';
import { t } from '../../../locale/index.js';
import type { ExecutionHost } from '../security/harness.js';

// ─── Mode 系统 ────────────────────────────────────────────────

/**
 * Mode 安全策略工厂：根据工作空间路径生成该 Mode 下使用的权限规则。
 */
export type ModePermissionFactory = (workspace: string) => PermissionRule[];

/**
 * ModeDecl —— Agent 运行模式的声明。
 *
 * 每个 Mode 描述了 Agent 在该模式下的行为差异：
 * - 安全策略（权限规则）
 * - 额外的 prompt 注入
 * - 可用工具集的过滤
 * - UI 表现（图标、颜色）
 */
export interface ModeDecl {
    /** 模式的唯一标识符 (如 'standard', 'plan', 'solo') */
    id: string;
    /** 模式的显示名称（作为未本地化时的兜底文案） */
    name: string;
    /** 模式显示名称的翻译键 */
    displayNameKey?: string;
    /** 模式的简要描述（作为未本地化时的兜底文案） */
    description: string;
    /** 模式描述的翻译键 */
    descriptionKey?: string;
    /** 图标字符串 (通常是 emoji) */
    icon: string;
    /** 颜色字符串 (如 '#1a2b3c') */
    color: string;
    /**
     * 安全策略工厂，返回该 Mode 下使用的权限规则列表。
     */
    permissionFactory: ModePermissionFactory;
    /**
     * 模式专属的 Sub-Prompt，会作为独立 Section 整合进 SystemPrompt。
     * 返回 null 表示无额外提示。
     * @param taskCtx 任务上下文（包含 workspace、taskId 等）
     */
    getSubPrompt?: (taskCtx: TaskContext) => string | null;
    /**
     * 工具白名单：非空时仅白名单内的工具可用，此时 disabledTools 被忽略。
     * 空数组或 undefined 表示不做白名单过滤。
     */
    allowedTools?: string[];
    /**
     * 工具集过滤器：返回在该 Mode 下需要排除的工具名列表。
     * 当 allowedTools 为空时生效。
     * 返回空数组或 undefined 表示不过滤。
     */
    disabledTools?: string[];
    /**
     * 进入该模式时的钩子函数。
     * 由框架在模式切换生效后调用，可用于初始化模式所需资源（如创建目录等）。
     */
    onEnterMode?: (workspace: string) => Promise<void> | void;
    /**
     * 退出该模式时的钩子函数。
     * 由框架在即将切换离开此模式时调用，可用于清理资源或保存状态。
     */
    onExitMode?: (workspace: string) => Promise<void> | void;
}

function translateWithFallback(key: string | undefined, fallback: string): string {
    if (!key) return fallback;
    const translated = t(key);
    return translated === key ? fallback : translated;
}

export function getModeDisplayName(mode: ModeDecl): string {
    return translateWithFallback(mode.displayNameKey, mode.name);
}

export function getModeDisplayDescription(mode: ModeDecl): string {
    return translateWithFallback(mode.descriptionKey, mode.description);
}

export function localizeModeDisplay(mode: ModeDecl): ModeDecl {
    return {
        ...mode,
        name: getModeDisplayName(mode),
        description: getModeDisplayDescription(mode)
    };
}

export function localizeModeDisplays(modes: ModeDecl[]): ModeDecl[] {
    return modes.map((mode) => localizeModeDisplay(mode));
}

// ─── AgentDecl ────────────────────────────────────────────────

export type AgentType = 'builtin' | 'custom';

export interface TaskSkillExposure {
    skillNames?: readonly string[];
    skillDirectories?: readonly string[];
}

/**
 * createSystemPrompt 所需的任务上下文。
 * 由 TaskState 实现，此处用接口定义以避免循环依赖。
 */
export interface TaskContext {
    readonly task_id: string;
    readonly task_name: string | null;
    readonly agentId?: string;
    readonly skillExposure?: TaskSkillExposure;
    getWorkspace(): string;
    getExecutionHost?(): ExecutionHost;
}

export abstract class AgentDecl {
    /** Agent 的唯一名称标识 */
    abstract readonly agentName: string;

    /**
     * Agent 的运行时唯一标识。内置 Agent 默认复用 agentName；
     * 外部加载的 Agent 应覆写为其稳定来源标识。
     */
    get agentId(): string {
        return this.agentName;
    }

    /** Agent 类型：builtin 为系统内置，custom 为通过 AGENT.md 等外部工具加载（预留） */
    abstract readonly agentType: AgentType;

    /** Agent 的使用场景描述，指示何时应该使用此 Agent */
    abstract readonly whenToUse: string;

    /**
     * 返回此 Agent 支持的所有模式。至少包含一个模式。
     */
    abstract supportedModes(): ModeDecl[];

    /**
     * 返回默认模式的 id
     */
    abstract defaultModeId(): string;

    abstract createSystemPrompt(activeMode: ModeDecl | undefined, taskCtx: TaskContext): Promise<string>;

    /**
     * 释放 agent 持有的资源。
     * 在 agent 被卸载或不再使用时调用。
     */
    async dispose(): Promise<void> {}
}
