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

export interface AgentEnvironment {
    workspace: string;
}

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
    /** 模式的显示名称 */
    name: string;
    /** 模式的简要描述 */
    description: string;
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
     */
    getSubPrompt?: (workspace: string) => string | null;
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
}

// ─── AgentDecl ────────────────────────────────────────────────

export type AgentType = 'builtin' | 'custom';

export abstract class AgentDecl {
    /** Agent 的唯一名称标识 */
    abstract readonly agentName: string;

    /** Agent 类型：builtin 为系统内置，custom 为通过 AGENT.md 等外部工具加载（预留） */
    abstract readonly agentType: AgentType;

    /** Agent 的使用场景描述，指示何时应该使用此 Agent */
    abstract readonly whenToUse: string;

    protected environment: AgentEnvironment;

    constructor(environment: AgentEnvironment) {
        this.environment = environment;
    }

    /**
     * 返回此 Agent 支持的所有模式。至少包含一个模式。
     */
    abstract supportedModes(): ModeDecl[];

    /**
     * 返回默认模式的 id
     */
    abstract defaultModeId(): string;

    abstract createSystemPrompt(activeMode?: ModeDecl, workspace?: string): Promise<string>;
}
