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

import type { PermissionAction, PermissionResourceType, PermissionRule } from '../security/permission.js';
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
     * 完全跳过权限判定。宿主必须使用无条件放行的权限执行器，不能仅依赖 allow glob 规则。
     */
    bypassPermissionChecks?: boolean;
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
     * 该模式是否允许阻塞式用户交互工具（askUser / exitPlanMode）。
     * 无人值守模式（solo / unlimited）设为 false；默认 true。
     */
    interactive?: boolean;
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
    readonly parent_id?: string | null;
    readonly agentId?: string;
    readonly skillExposure?: TaskSkillExposure;
    getWorkspace(): string;
    getExecutionHost?(): ExecutionHost;
}

// ─── Agent task runtime ──────────────────────────────────────

export type AgentRuntimeToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface AgentRuntimeToolLocation {
    path: string;
    line?: number;
}

export type AgentRuntimeUpdate =
    | { type: 'message_delta'; text: string }
    | { type: 'thought_delta'; text: string }
    | {
          type: 'tool_call';
          toolCallId: string;
          title: string;
          status: AgentRuntimeToolStatus;
          rawInput?: unknown;
          rawOutput?: unknown;
          locations?: AgentRuntimeToolLocation[];
      }
    | {
          type: 'plan';
          entries: Array<{
              content: string;
              status: 'pending' | 'in_progress' | 'completed';
              priority?: 'low' | 'medium' | 'high';
          }>;
      }
    | { type: 'metadata'; data: Record<string, unknown> }
    | { type: 'error'; title: string; message: string };

export interface AgentRuntimePermissionOption {
    id: string;
    label: string;
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

export interface AgentRuntimePermissionRequest {
    toolCallId: string;
    title: string;
    rawInput?: Record<string, unknown>;
    locations?: AgentRuntimeToolLocation[];
    resourceType?: PermissionResourceType;
    action?: PermissionAction;
    options: AgentRuntimePermissionOption[];
}

export interface AgentRuntimePermissionResponse {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
}

export interface AgentTaskRuntimeTurnRequest {
    taskId: string;
    prompt: string;
    imageDataUris?: string[];
    workspace: string;
    persistedState?: Record<string, unknown>;
    signal: AbortSignal;
    onUpdate(update: AgentRuntimeUpdate): Promise<void>;
    checkpoint(state: Record<string, unknown>): Promise<void>;
    requestPermission(request: AgentRuntimePermissionRequest): Promise<AgentRuntimePermissionResponse>;
}

export interface AgentTaskRuntimeTurnResult {
    stopReason: 'completed' | 'cancelled' | 'max_tokens' | 'refusal' | 'error';
    state?: Record<string, unknown>;
}

export interface PersistedAgentRuntimeState {
    kind: string;
    state: Record<string, unknown>;
    lastTurnStopReason?: AgentTaskRuntimeTurnResult['stopReason'];
}

/**
 * Protocol-neutral execution backend for an AgentDecl.
 * TaskState remains responsible for the durable local task and projects runtime
 * updates into the normal OpenDesk chat model.
 */
export interface AgentTaskRuntime {
    readonly kind: string;
    runTurn(request: AgentTaskRuntimeTurnRequest): Promise<AgentTaskRuntimeTurnResult>;
    cancel(reason: 'user' | 'system'): Promise<void> | void;
    dispose?(): Promise<void> | void;
}

export abstract class AgentDecl {
    /**
     * 仅应用 Agent 需要显式作用域，内置 Agent 不绑定应用作用域。
     */
    private agentScope?: string;

    protected constructor(agentScope?: string) {
        this.agentScope = agentScope;
    }

    /** Agent 的唯一名称标识 */
    abstract readonly agentName: string;

    /** Agent 面向用户的显示名称，默认与唯一名称标识一致。 */
    get displayName(): string {
        return this.agentName;
    }

    /**
     * Agent 的运行时唯一标识。agentName 仅在所属作用域内唯一。
     */
    get agentId(): string {
        return this.agentScope ? `${this.agentScope}:${this.agentName}` : this.agentName;
    }

    /** 是否可由主 Agent 作为子任务执行者调度 */
    abstract readonly dispatchable: boolean;

    /** Agent 类型：builtin 为系统内置，custom 为通过 AGENT.md 等外部工具加载（预留） */
    abstract readonly agentType: AgentType;

    /** Agent 的使用场景描述，指示何时应该使用此 Agent */
    abstract readonly whenToUse: string;

    /**
     * 返回此 Agent 支持的所有模式。至少包含一个模式。
     */
    abstract supportedModes(): ModeDecl[];

    /**
     * 返回默认模式的 id。
     * 业务代码应使用 getDefaultMode() 获取默认模式。
     */
    protected abstract defaultModeId(): string;

    /**
     * 返回此 Agent 的默认模式。
     */
    getDefaultMode(): ModeDecl {
        const modes = this.supportedModes();
        const mode = modes.find((candidate) => candidate.id === this.defaultModeId()) ?? modes[0];
        if (!mode) {
            throw new Error(`Agent "${this.agentId}" does not provide any modes`);
        }
        return mode;
    }

    abstract createSystemPrompt(activeMode: ModeDecl | undefined, taskCtx: TaskContext): Promise<string>;

    /**
     * Optionally provide a non-native task runtime. Returning undefined keeps
     * the existing OpenDesk LLM/tool execution path.
     */
    createTaskRuntime(_taskCtx: TaskContext): AgentTaskRuntime | undefined {
        return undefined;
    }

    /**
     * 将应用提供的 Agent 绑定到应用作用域。
     * 仅由 AgentRegistry 在注册应用 Agent 时调用。
     */
    bindApplicationScope(bundleName: string): void {
        this.agentScope = bundleName;
    }

    /**
     * 释放 agent 持有的资源。
     * 在 agent 被卸载或不再使用时调用。
     */
    async dispose(): Promise<void> {}
}
