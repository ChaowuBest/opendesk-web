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

import type { TaskState } from './states/tasks.js';
import type { ToolCall, AssistantMessage, ChatContext } from './messages.js';
import type { LLMRequestOptions } from './llm.js';
import type { ModelInstance } from '../utils/setting.js';
import { composeTailcardRegion, finalizeTailcardSections } from './context/tailcard.js';

import type { BaseToolset } from './tool.js';

import { logger } from '../utils/logger.js';
import type { PermissionRequest } from './types/index.js';
import { ActiveContextView } from './compaction/types.js';

/******************************************************************************
 * Hooks 系统总体设计
 * ------------------------
 * 1. Hooks 是 AI 内核向外部模块开放的可插拔扩展点：在任务执行的关键节点（任务
 *    开始/审查/回退、turn 开始/结束、流式解析、工具调用前后、请求构造、权限
 *    询问、技能加载、请求尾部注入等）允许注册回调，以注入自定义行为。
 * 2. 按回调形态分为三类：
 *   - check 类：回调返回一个反馈（allow/deny、finish/reject、accept/reject），
 *     调度时在第一次拒绝处短路返回，适合安全拦截、合规校验、循环检测等；
 *   - notice 类：回调无返回值（或返回值仅作聚合），调度时始终全部执行，适合
 *     日志、观测、状态清理等；
 *   - apply/transform 类：回调通过修改传入的 output 对象改写请求（请求头、
 *     请求参数、消息文本、消息上下文、工具定义等），逐级传递。
 * 3. 调度模型：Hooks 实例支持多级继承，通过 parent 链形成父子关系。调度时先按
 *    priority 升序执行本层全部钩子，再递交给 parent 继续执行；priority 越小越
 *    先执行，相同 priority 按注册顺序执行（见下方"通用基础设施"的 HookOptions）。
 * 4. 实例关系：系统中存在一个全局实例 GlobalHooks，每个任务通过
 *    GlobalHooks.createChildHooks() 创建任务级钩子实例，其 parent 指向 GlobalHooks，
 *    从而实现"全局规则 + 任务定制"的叠加。
 * 5. 命名约定：注册方法直接使用钩子名（如 beforeFinishTurn、beforeSkillLoad）；
 *    调度方法命名为 checkXxx（check 类，短路判定）/ noticeXxx（notice 类，纯通知）/
 *    applyXxx（apply 类，就地改写）/ buildXxx（生成类，TailCard）。唯一的
 *    register 前缀特例是辅助方法 registerToolHook（按工具名注册组合钩子）。
 * 6. 文件组织：下文每个钩子按"注释头 → 钩子需要的数据结构 → 函数实现
 *    （Hooks 类内对应方法）"的顺序组织；通用基础设施与 Hooks 类实现放在最后。
 ******************************************************************************/

/******************************************************************************
 * 通用基础设施
 * ------------------------
 * 钩子注册选项、钩子条目与排序工具，所有钩子共用。
 ******************************************************************************/

/** 钩子注册选项；priority 范围 [0, 65535]，缺省为 0；priority 越小越先执行 */
export interface HookOptions {
    priority?: number;
    onError?: 'continue' | 'throw';
}

/** 钩子条目：包含 callback 与解析后的 options */
export interface Hook<CallbackTy> {
    callback: CallbackTy;
    options: Required<HookOptions>;
}

export const MAX_HOOK_PRIORITY = 65535;

/** 解析 HookOptions，做范围校验；越界时截断到 [0, 65535] 并记录警告 */
function resolveHookOptions(options?: HookOptions): Required<HookOptions> {
    let priority = options?.priority ?? 0;
    if (!Number.isInteger(priority) || priority < 0 || priority > MAX_HOOK_PRIORITY) {
        logger.warn(`Hook priority ${priority} is out of range [0, ${MAX_HOOK_PRIORITY}], clamping to valid range`);
        if (!Number.isFinite(priority)) {
            priority = 0;
        } else {
            priority = Math.trunc(priority);
            priority = Math.max(0, Math.min(MAX_HOOK_PRIORITY, priority));
        }
    }
    return { priority, onError: options?.onError ?? 'continue' };
}

/** 将钩子数组按 priority 升序排序（稳定排序：相同 priority 保持注册顺序） */
function sortHooks<T>(hooks: Hook<T>[]): Hook<T>[] {
    return [...hooks].sort((a, b) => a.options.priority - b.options.priority);
}

/******************************************************************************
 * Finish Turn Callbacks
 * ------------------------
 * 1. 所谓一个 turn，指的是从发给 agent 一次消息，然后 agent 循环执行工具，反馈结果，直到
 *    这次消息的完整回复过程完成的完整循环；
 * 2. 在很多场景下，对于 turn 结束我们有一定的要求。比如：
 *   - 如果还有未完成的待办事项，应当继续处理直到完成
 *   - 有的情况下系统会要求任务以特定的工具结束
 *   - ......
 * 3. 所以我们允许在任务中挂在 beforeFinishTurn 和 afterFinishTurn 两种钩子，前者主要
 *    用于对 turn 结束的操作进行阻断，强行继续等有状态操作，后者主要用于观测等操作
 ******************************************************************************/

/** beforeFinishTurn 钩子的动作反馈：finish 允许结束 turn，reject 阻止结束并带原因 */
export type BeforeFinishTurnAction = { operation: 'finish' } | { operation: 'reject'; message: string };

/** beforeFinishTurn 钩子上下文 */
export interface BeforeFinishTurnContext {
    task: TaskState;
    /** 当前 turn 的模型请求选项（含 usage telemetry 包装），供钩子发起旁路请求时复用 */
    modelRequestOptions?: LLMRequestOptions;
}

type BeforeFinishTurnCallback = (ctx: BeforeFinishTurnContext) => Promise<BeforeFinishTurnAction>;

/** afterFinishTurn 钩子上下文 */
export interface AfterFinishTurnContext {
    task: TaskState;
}

type AfterFinishTurnCallback = (ctx: AfterFinishTurnContext) => void | Promise<void>;

/******************************************************************************
 * Task Lifecycle Callbacks
 * ------------------------
 * 1. 所谓任务（task），指的是从用户提交一条消息开始，到任务进入空闲或被主动终止为止的
 *    完整会话生命周期；一个任务内通常包含多个 turn；
 * 2. 任务生命周期内有三个可挂载钩子的关键节点：
 *   - beforeTaskStart：任务即将首次开始执行时（system prompt 已设置、用户消息提交之前）
 *     触发，用于在任务开始前注入额外的系统消息或进行初始化配置；
 *   - onTaskReview：任务达到空闲回顾阈值或用户手动触发"审查任务"操作时触发（纯通知），
 *     可用于提供自动审查 / 代码审查能力（如将任务排入审查队列）；
 *   - onTaskRevert：任务发生状态回退时（GUI"回退到这里"/"从这里继续"或 CLI /undo 操作）
 *     触发，在回退完成后回调，此时 task 已回退到目标用户消息处，用于清理回退相关的
 *     临时状态、记录审计日志。
 * 3. 三者均为任务级钩子，通常在任务级 Hooks 实例（createChildHooks）上注册。
 ******************************************************************************/

/** beforeTaskStart 钩子上下文 */
export interface BeforeTaskStartContext {
    task: TaskState;
}

/** onTaskReview 钩子上下文 */
export interface OnTaskReviewContext {
    task: TaskState;
    /** 本次审查的起始消息索引 */
    startMessageIndex: number;
}

/** onTaskRevert 钩子上下文 */
export interface OnTaskRevertContext {
    task: TaskState;
}

type BeforeTaskStartCallback = (ctx: BeforeTaskStartContext) => void | Promise<void>;

type OnTaskReviewCallback = (ctx: OnTaskReviewContext) => void | Promise<void>;

type OnTaskRevertCallback = (ctx: OnTaskRevertContext) => void | Promise<void>;

/******************************************************************************
 * Parse Tool Call Callbacks
 * ------------------------
 * 1. 在模型流式输出过程中，每当一个工具调用的参数解析完成（下一个工具调用到达、
 *    流结束、或检测到 partial object），立即调用 afterToolcallParse 钩子；
 * 2. 钩子返回 reject 时，Agent Loop会丢弃该工具调用并立即终止当前流式解析，
 *    返回 finish 时：保留该工具调用，继续正常流程。
 * 3. 即使有工具调用被 reject，已经成功解析的前置工具调用仍会正常执行。
 ******************************************************************************/

/** afterToolcallParse 钩子的动作反馈：finish 保留该工具调用，reject 丢弃并终止流式解析 */
export type AfterToolcallParseAction = { operation: 'finish' } | { operation: 'reject'; message: string };

/** afterToolcallParse 钩子上下文 */
export interface AfterToolcallParseContext {
    task: TaskState;
    /** 刚完成参数解析的工具调用 */
    toolCall: ToolCall;
}

type AfterToolcallParseCallback = (ctx: AfterToolcallParseContext) => Promise<AfterToolcallParseAction>;

/******************************************************************************
 * Before Toolcall Chunk Merge Callbacks
 * ----------------------------------
 * 1. 在模型流式输出过程中，每次 chunk 到达后在 mergeChunk 之前触发
 *    （此时新工具调用尚未追加到 assistant message）；
 * 2. 钩子返回 accept 时：继续正常流式解析并合并当前 chunk；
 *    返回 reject 时：不合并当前 chunk，跳出流式解析循环，
 *    进入工具调用执行阶段。
 * 3. 典型用途：工具调用数量限制、重复工具调用检测（模型死循环检测）等。
 ******************************************************************************/

/** beforeToolcallChunkMerge 钩子的动作反馈：accept 继续合并 chunk，reject 终止流式解析并进入执行阶段 */
export type BeforeToolcallChunkMergeAction = { operation: 'accept' } | { operation: 'reject'; message: string };

/** beforeToolcallChunkMerge 钩子上下文 */
export interface BeforeToolcallChunkMergeContext {
    task: TaskState;
    /** 正在流式合并的 assistant 消息（新工具调用尚未追加） */
    assistantMessage: AssistantMessage;
    /** 当前 chunk 是否包含新的工具调用 */
    chunkHasNewToolCall: boolean;
    /** 本次 processCompletion 中已合并的工具调用 */
    requestToolCalls: readonly ToolCall[];
}

type BeforeToolcallChunkMergeCallback = (
    ctx: BeforeToolcallChunkMergeContext
) => Promise<BeforeToolcallChunkMergeAction>;

/******************************************************************************
 * Tool Call Callbacks
 * ------------------------
 * 1. 所谓一次工具调用，指的是从发起对某工具的调用，到真正执行工具、将结果写回
 *    tool_call.result 的完整过程；
 * 2. 在很多场景下，对工具调用前后我们有一定的要求。比如：
 *   - 执行前：参数校验、审计、安全拦截等（beforeToolCall）
 *   - 执行后：将超长结果落盘并替换为摘要、观测等（afterToolCall，可改写 tool_call.result）
 * 3. 所以我们允许在全局或任务中挂载 beforeToolCall 和 afterToolCall 两种钩子
 * 4. beforeToolCall 返回 deny 时：阻止该工具执行，将 message 写回 tool_call.result；
 *    返回 allow 时：继续正常执行。
 ******************************************************************************/

/** beforeToolCall 钩子的动作反馈：allow 继续执行，deny 阻止执行并带原因 */
export type BeforeToolCallExecAction = { operation: 'allow' } | { operation: 'deny'; message: string };

/** beforeToolCall 钩子上下文 */
export interface BeforeToolCallExecContext {
    task: TaskState;
    toolCall: ToolCall;
}

/** afterToolCall 钩子上下文 */
export interface AfterToolCallExecContext {
    task: TaskState;
    toolCall: ToolCall;
}

type BeforeToolCallExecCallback = (
    ctx: BeforeToolCallExecContext
) => BeforeToolCallExecAction | Promise<BeforeToolCallExecAction>;

type AfterToolCallExecCallback = (ctx: AfterToolCallExecContext) => void | Promise<void>;

/******************************************************************************
 * Turn Lifecycle Callbacks
 * ------------------------
 * beforeTurnStart：每个新 turn 的最开始，在 processCompletion() 第一次调用之前触发，
 * 同一个 turn 内只会触发一次，适合在此处重置 per-turn 状态（计数器、熔断器状态、
 * 性能计时器等）。纯通知钩子（无返回值），始终全部执行。
 ******************************************************************************/

/** beforeTurnStart 钩子上下文 */
export interface BeforeTurnStartContext {
    task: TaskState;
}

type BeforeTurnStartCallback = (ctx: BeforeTurnStartContext) => void | Promise<void>;

/******************************************************************************
 * Before Chat Model Request Callbacks
 * ------------------------
 * 1. 每次向 LLM 发起请求（chat completion）之前触发，允许各模块直接改写本次请求：
 *    HTTP headers（ctx.options.extraHeaders）、请求参数（ctx.options.reasoningEffort /
 *    ctx.options.maxCompletionTokens）等，改动直接体现为最终请求；
 * 2. 模块通过 beforeChatModelRequest 注册回调，回调收到
 *    { chat, model, options, task? }，直接修改 ctx.options 即可生效；
 * 3. ctx.task 由 ctx.options.task 提供（任务相关请求在提交时透传 task），
 *    旁路请求无 task 时为 undefined；
 * 4. 调度时按 priority 升序执行并逐级传递到 parent，所有回调都会被执行。
 ******************************************************************************/

/** beforeChatModelRequest 钩子上下文 */
export interface BeforeChatModelRequestContext {
    /** 本次请求的对话上下文 */
    chat: ChatContext;
    /** 本次请求使用的模型实例 */
    model: ModelInstance;
    /** 本次请求的可变选项，钩子直接修改它 */
    options: LLMRequestOptions;
    /** 请求关联的任务（由 options.task 提供，旁路请求可能为 undefined） */
    task?: TaskState;
}

type BeforeChatModelRequestCallback = (ctx: BeforeChatModelRequestContext) => void | Promise<void>;

/******************************************************************************
 * Before Tool Call Validate Callbacks
 * ------------------------
 * 1. 在工具参数解析后、参数校验与权限检查之前触发，允许各模块对本次调用做参数层
 *    审查：既可以拒绝该调用，也可以就地调整参数——回调直接修改 ctx.toolCall 的
 *    args_object / args_string 即可生效，无需返回值中转，修改后的参数随后进入
 *    校验与执行阶段；
 * 2. 模块通过 beforeToolCallValidate 注册回调，回调收到 { task, toolCall }，
 *    返回 { operation: 'allow' | 'deny', message? }：
 *   - 返回 deny：立即终止检查链并阻止执行，message 会写回 tool_call.result；
 *   - 返回 allow：继续执行后续检查（随后进行参数校验、权限检查）。
 * 3. 与 beforeToolCall 的区别：本钩子面向参数层（位于参数校验与权限检查之前），
 *    beforeToolCall 面向整个工具调用做策略判定（位于权限检查之后、执行之前）；
 *    若本钩子或校验/权限环节已拒绝执行，则不会进入 beforeToolCall/afterToolCall
 *    所代表的执行阶段。
 ******************************************************************************/

/** beforeToolCallValidate 钩子动作反馈：allow 继续执行，deny 阻止执行并带原因 */
export type BeforeToolCallValidateAction = { operation: 'allow' } | { operation: 'deny'; message: string };

/** beforeToolCallValidate 钩子上下文 */
export interface BeforeToolCallValidateContext {
    task: TaskState;
    toolCall: ToolCall;
}

type BeforeToolCallValidateCallback = (
    ctx: BeforeToolCallValidateContext
) => BeforeToolCallValidateAction | Promise<BeforeToolCallValidateAction>;

/******************************************************************************
 * After Toolset Build Callbacks
 * ------------------------
 * 1. 在任务/请求的工具集（toolsets）构建完成后、向 LLM 下发前触发，允许各模块
 *    向工具集写入或调整定义，如注入插件提供的工具、修改工具描述等；
 * 2. 模块通过 afterToolsetBuild 注册回调，回调收到 { toolsets, chat, task? }，
 *    直接修改 ctx.toolsets 数组内容即可生效；
 * 3. ctx.chat 为本次请求的对话上下文；ctx.task 仅在工具集对应具体任务时存在
 *    （旁路请求等场景可能没有任务）。
 ******************************************************************************/

/** afterToolsetBuild 钩子上下文 */
export interface AfterToolsetBuildContext {
    /** 本次构建出的工具集列表，回调直接修改数组内容即可生效 */
    toolsets: BaseToolset[];
    /** 本次请求的对话上下文 */
    chat: ChatContext;
    /** 工具集对应的任务（旁路请求等场景可能不存在） */
    task?: TaskState;
}

type AfterToolsetBuildCallback = (ctx: AfterToolsetBuildContext) => void | Promise<void>;

/******************************************************************************
 * Before Permission Ask Callbacks
 * ------------------------
 * 1. 当工具调用涉及敏感操作、需要权限确认时，允许各模块参与决策：直接给出
 *    allow / deny，或维持 ask 交由用户确认；
 * 2. 模块通过 beforePermissionAsk 注册回调，回调收到 { task, toolCall,
 *    permissions, action }，改写 ctx.action.decision 即生效；
 * 3. 决策以最后一次修改为准，调度时按 priority 升序执行并逐级传递到 parent。
 ******************************************************************************/

/** beforePermissionAsk 钩子上下文 */
export interface BeforePermissionAskContext {
    task: TaskState;
    /** 本次请求的工具调用（工具名、调用 id 均可从 toolCall 获取） */
    toolCall: ToolCall;
    /** 本次权限请求列表 */
    permissions: PermissionRequest[];
    /** 决策输出，回调改写 action.decision 即生效 */
    action: BeforePermissionAskAction;
}

/** beforePermissionAsk 动作反馈：ask 交由用户确认，allow/deny 直接决策 */
export type BeforePermissionAskAction = { decision: 'ask' | 'allow' | 'deny' };

type BeforePermissionAskCallback = (ctx: BeforePermissionAskContext) => void | Promise<void>;

/******************************************************************************
 * Skill Load Callbacks
 * ------------------------
 * 1. 技能（Skill）加载前后各有一个可挂载钩子的节点：
 *   - beforeSkillLoad：技能加载前触发，返回 deny 时阻止该技能加载，message 与
 *     metadata 可用于说明原因；返回 allow 时继续正常加载；
 *   - afterSkillLoad：技能加载完成后触发（纯通知），用于加载后的初始化、统计等；
 * 2. 模块通过 beforeSkillLoad / afterSkillLoad 注册回调。
 ******************************************************************************/

export interface SkillLoadContext {
    bundleName: string;
    skillName: string;
    skillDirectory?: string;
    source?: 'installed' | 'config' | 'mounted' | 'builtin' | 'plugin';
    frontmatter: Record<string, unknown>;
}

/** beforeSkillLoad 钩子动作反馈：allow 继续加载，deny 阻止加载并带原因 */
export type BeforeSkillLoadAction = { operation: 'allow' } | { operation: 'deny'; message?: string };

type BeforeSkillLoadCallback = (ctx: SkillLoadContext) => BeforeSkillLoadAction | Promise<BeforeSkillLoadAction>;

type AfterSkillLoadCallback = (ctx: SkillLoadContext) => void | Promise<void>;

/******************************************************************************
 * TailCard / onTailcardGenerate
 * ------------------------
 * 1. 在每次向 LLM 发起请求之前，允许不同模块在请求末尾插入一段内容（TailCard），
 *    用于向模型提供本次请求的运行时上下文（如 EvidenceCard 的 ledger、其它模块
 *    的运行态等）；上一轮插入的 TailCard 不会留存到下一轮请求；
 * 2. 模块通过 onTailcardGenerate 注册回调，回调返回一个 TailCard（包含 id、content
 *    与拼接元数据 priority/maxChars），调度时按 priority 升序（相同按注册顺序）拼接，
 *    最终包装成完整的 TailCards 区域插入到 LLM 请求中；
 * 3. 回调签名会收到压缩后的 ActiveContextView，便于依赖真实上下文视图生成内容。
 ******************************************************************************/

/** 单个模块生成的 TailCard：id 唯一标识、priority/maxChars 为拼接元数据 */
export interface TailCard {
    /** 唯一标识（重复 id 保留首次返回的卡片） */
    id: string;
    /** 卡片内容（会按 maxChars 截断） */
    content: string;
    /** 拼接优先级，越小越靠前（默认 0） */
    priority?: number;
    /** 单条内容长度上限（超出截断加省略号） */
    maxChars?: number;
}

/** onTailcardGenerate 回调上下文 */
export interface TailcardGenerationContext {
    /** 当前任务（TailCard 由任务级请求触发） */
    task: TaskState;
    activeContext?: ActiveContextView;
    chatContext: Pick<ChatContext, 'messages'>;
    model?: string;
    requestType: 'streamComplete';
}

/** onTailcardGenerate 回调签名：返回 TailCard 参与拼接，返回 undefined 表示本次不插入 */
export type OnTailcardGenerationCallback = (
    ctx: TailcardGenerationContext
) => TailCard | undefined | Promise<TailCard | undefined>;

/**
 * 钩子容器：支持多级继承关系。
 *
 * - 调度时先按 priority 升序执行本层全部钩子，再递交给 parent 继续执行。
 * - priority 越小越先执行，相同 priority 按注册顺序执行。
 * - check 类钩子在第一次拒绝时短路返回；notice 类钩子始终全部执行。
 *
 * 全局唯一实例 GlobalHooks 通过 Hooks.createGlobal() 创建；
 * 任务级钩子通过 GlobalHooks.createChildHooks() 创建，其 parent 指向 GlobalHooks。
 */
export class Hooks {
    private readonly parent: Hooks | undefined;

    // 以下字段与下方方法分组一一对应：
    // Finish Turn / Task Lifecycle / Parse Toolcall / Before Toolcall Chunk Merge /
    // Tool Call / Turn Lifecycle / Before Chat Model Request / Before Tool Call Validate /
    // After Toolset Build / Before Permission Ask / Skill Load / TailCard
    beforeFinishTurnHooks: Hook<BeforeFinishTurnCallback>[] = [];
    afterFinishTurnHooks: Hook<AfterFinishTurnCallback>[] = [];
    beforeTaskStartHooks: Hook<BeforeTaskStartCallback>[] = [];
    onTaskReviewHooks: Hook<OnTaskReviewCallback>[] = [];
    onTaskRevertHooks: Hook<OnTaskRevertCallback>[] = [];
    afterToolcallParseHooks: Hook<AfterToolcallParseCallback>[] = [];
    beforeToolcallChunkMergeHooks: Hook<BeforeToolcallChunkMergeCallback>[] = [];
    beforeToolCallHooks: Hook<BeforeToolCallExecCallback>[] = [];
    afterToolCallHooks: Hook<AfterToolCallExecCallback>[] = [];
    beforeTurnStartHooks: Hook<BeforeTurnStartCallback>[] = [];
    beforeChatModelRequestHooks: Hook<BeforeChatModelRequestCallback>[] = [];
    beforeToolCallValidateHooks: Hook<BeforeToolCallValidateCallback>[] = [];
    afterToolsetBuildHooks: Hook<AfterToolsetBuildCallback>[] = [];
    beforePermissionAskHooks: Hook<BeforePermissionAskCallback>[] = [];
    beforeSkillLoadHooks: Hook<BeforeSkillLoadCallback>[] = [];
    afterSkillLoadHooks: Hook<AfterSkillLoadCallback>[] = [];
    tailcardHooks: Hook<OnTailcardGenerationCallback>[] = [];

    private constructor(parent?: Hooks) {
        this.parent = parent;
    }

    /** 创建全局 Hooks 实例（无 parent） */
    static createGlobal(): Hooks {
        return new Hooks(undefined);
    }

    /** 创建一个子 Hooks 实例，其 parent 指向当前实例 */
    createChildHooks(): Hooks {
        return new Hooks(this);
    }

    /* ------------------------------------------------------------------
     * Finish Turn
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeFinishTurn` 钩子。
     *
     * 触发时机：一个 turn 的所有工具调用执行完毕后，系统准备结束该 turn 时触发。
     * 回调签名：`(ctx: BeforeFinishTurnContext) => Promise<BeforeFinishTurnAction>`
     * `ctx.task` 为当前任务；`ctx.modelRequestOptions` 为当前 turn 的模型
     * 请求选项（可能未提供），供钩子发起旁路模型请求时复用。
     * - 返回 `{ operation: 'finish' }`：允许 turn 正常结束。
     * - 返回 `{ operation: 'reject', message }`：阻止 turn 结束，系统会用 `message`
     *   作为新的用户消息重新发起一轮模型调用。
     *
     * 典型用途：确保任务以特定工具结尾（如 attemptCompletion），或检测未完成的待办事项强制继续。
     */
    beforeFinishTurn(callback: BeforeFinishTurnCallback, options?: HookOptions): void {
        this.beforeFinishTurnHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async checkBeforeFinishTurn(ctx: BeforeFinishTurnContext): Promise<BeforeFinishTurnAction> {
        for (const hook of sortHooks(this.beforeFinishTurnHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeFinishTurn: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeFinishTurn(ctx);
        }
        return { operation: 'finish' };
    }

    /**
     * 注册 `afterFinishTurn` 钩子（纯通知，无返回值）。
     *
     * 触发时机：turn 已经确定结束之后，在清理 / 状态切换之前触发。
     * 回调签名：`(ctx: AfterFinishTurnContext) => void | Promise<void>`
     * `ctx.task` 为当前任务。
     *
     * 典型用途：记录日志、统计、触发后续异步任务（如会话记忆提取）。
     */
    afterFinishTurn(callback: AfterFinishTurnCallback, options?: HookOptions): void {
        this.afterFinishTurnHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async noticeAfterFinishTurn(ctx: AfterFinishTurnContext): Promise<void> {
        for (const hook of sortHooks(this.afterFinishTurnHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeAfterFinishTurn: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeAfterFinishTurn(ctx);
        }
    }

    /* ------------------------------------------------------------------
     * Task Lifecycle
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeTaskStart` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务即将首次开始执行时（system prompt 已设置，用户消息提交之前）。
     * 回调签名：`(ctx: BeforeTaskStartContext) => void | Promise<void>`
     * `ctx.task` 为当前任务。
     *
     * 典型用途：在任务开始前注入额外的系统消息或进行初始化配置。
     */
    beforeTaskStart(callback: BeforeTaskStartCallback, options?: HookOptions): void {
        this.beforeTaskStartHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async noticeBeforeTaskStart(ctx: BeforeTaskStartContext): Promise<void> {
        for (const hook of sortHooks(this.beforeTaskStartHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeBeforeTaskStart: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeBeforeTaskStart(ctx);
        }
    }

    /**
     * 注册 `onTaskReview` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务达到空闲回顾阈值，或用户手动触发"审查任务"操作时。
     * 回调签名：`(ctx: OnTaskReviewContext) => void | Promise<void>`
     * 多个钩子都会被调用，不会短路；是否受理审查由各模块自行处理。
     *
     * 典型用途：为任务提供自动审查 / 代码审查能力（如将任务排入审查队列）。
     */
    onTaskReview(callback: OnTaskReviewCallback, options?: HookOptions): void {
        this.onTaskReviewHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async noticeOnTaskReview(ctx: OnTaskReviewContext): Promise<void> {
        for (const hook of sortHooks(this.onTaskReviewHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeOnTaskReview: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeOnTaskReview(ctx);
        }
    }

    /**
     * 注册 `onTaskRevert` 钩子（纯通知，无返回值）。
     *
     * 触发时机：任务发生回退时（用户通过 GUI "回退到这里" / "从这里继续" 或 CLI /undo 操作）。
     * 回调签名：`(ctx: OnTaskRevertContext) => void | Promise<void>`
     * 钩子在回退完成后触发，此时 task 已回退到目标用户消息处。
     *
     * 典型用途：清理回退相关的临时状态、记录审计日志。
     */
    onTaskRevert(callback: OnTaskRevertCallback, options?: HookOptions): void {
        this.onTaskRevertHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async noticeOnTaskRevert(ctx: OnTaskRevertContext): Promise<void> {
        for (const hook of sortHooks(this.onTaskRevertHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeOnTaskRevert: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeOnTaskRevert(ctx);
        }
    }

    /* ------------------------------------------------------------------
     * Parse Toolcall
     * ------------------------------------------------------------------ */

    /**
     * 注册 `afterToolcallParse` 钩子。
     *
     * 触发时机：模型流式输出中，每当一个工具调用的参数 JSON 解析完成时触发
     * （下一个工具调用到达、流结束、或检测到 partial object 时）。
     * 回调签名：`(ctx: AfterToolcallParseContext) => Promise<AfterToolcallParseAction>`
     * `ctx.task` 为当前任务；`ctx.toolCall` 为刚完成解析的工具调用。
     * - 返回 `{ operation: 'finish' }`：保留该工具调用，继续正常流程。
     * - 返回 `{ operation: 'reject', message }`：丢弃该工具调用并终止当前流式解析。
     *
     * 注意：即使有工具调用被 reject，已经成功解析的前置工具调用仍会正常执行。
     *
     * 典型用途：安全审查、参数合规性校验、在解析阶段提前拦截高风险工具调用。
     */
    afterToolcallParse(callback: AfterToolcallParseCallback, options?: HookOptions): void {
        this.afterToolcallParseHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async checkAfterToolcallParse(ctx: AfterToolcallParseContext): Promise<AfterToolcallParseAction> {
        // afterToolcallParse 在流式解析期间每个 tool call 参数完成时触发，
        // 不创建 span 以避免噪声
        for (const hook of sortHooks(this.afterToolcallParseHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkAfterToolcallParse: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkAfterToolcallParse(ctx);
        }
        return { operation: 'finish' };
    }

    /* ------------------------------------------------------------------
     * Before Toolcall Chunk Merge
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeToolcallChunkMerge` 钩子。
     *
     * 触发时机：模型流式输出中，每次 chunk 到达后在 mergeChunk 之前触发
     * （新工具调用尚未追加到 assistant message）。
     * 回调签名：`(ctx: BeforeToolcallChunkMergeContext) => Promise<BeforeToolcallChunkMergeAction>`
     * `ctx.requestToolCalls` 仅包含本次 `processCompletion` 中已合并的工具调用。
     * - 返回 `{ operation: 'accept' }`：继续正常流式解析并合并当前 chunk。
     * - 返回 `{ operation: 'reject', message }`：不合并当前 chunk，跳出流式解析循环，
     *   进入工具调用执行阶段。
     *
     * 典型用途：工具调用数量限制、重复工具调用检测（模型死循环）。
     */
    beforeToolcallChunkMerge(callback: BeforeToolcallChunkMergeCallback, options?: HookOptions): void {
        this.beforeToolcallChunkMergeHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async checkBeforeToolcallChunkMerge(ctx: BeforeToolcallChunkMergeContext): Promise<BeforeToolcallChunkMergeAction> {
        // beforeToolcallChunkMerge 在流式输出中每个 chunk 都会触发一次，不创建 span 以避免噪声
        for (const hook of sortHooks(this.beforeToolcallChunkMergeHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'reject') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeToolcallChunkMerge: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeToolcallChunkMerge(ctx);
        }
        return { operation: 'accept' };
    }

    /* ------------------------------------------------------------------
     * Tool Call
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeToolCall` 钩子。
     *
     * 触发时机：每个工具调用**执行之前**（权限检查通过后，`tool.execute()` 之前）。
     * 回调签名：`(ctx: BeforeToolCallExecContext) => BeforeToolCallExecAction | Promise<...>`
     * `ctx.task` 为当前任务；`ctx.toolCall` 为待执行的工具调用。
     * - 返回 `{ operation: 'allow' }`：继续执行该工具。
     * - 返回 `{ operation: 'deny', message }`：阻止执行，`message` 会写入 `tool_call.result`
     *   作为错误信息返回给模型。
     *
     * 典型用途：安全拦截（AgentGate）、循环检测（电路断路器）、参数审计。
     */
    beforeToolCall(callback: BeforeToolCallExecCallback, options?: HookOptions): () => void {
        return this.registerHook(this.beforeToolCallHooks, callback, options);
    }

    async checkBeforeToolCall(ctx: BeforeToolCallExecContext): Promise<BeforeToolCallExecAction> {
        for (const hook of sortHooks(this.beforeToolCallHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'deny') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeToolCall: callback error', err);
            }
        }
        if (this.parent) {
            return this.parent.checkBeforeToolCall(ctx);
        }
        return { operation: 'allow' };
    }

    /**
     * 注册 `afterToolCall` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每个工具调用**执行完成后**（无论成功或失败），在 `freezeRenderResult` 之前触发。
     * 回调签名：`(ctx: AfterToolCallExecContext) => void | Promise<void>`
     * `ctx.task` 为当前任务；`ctx.toolCall` 为刚执行完的工具调用，此时
     * `tool_call.status`、`tool_call.result`、`tool_call.result_object` 均已就绪，
     * 钩子可以读取或改写它们（如将超长结果落盘并替换为摘要）。
     * 返回注销函数，用于移除当前注册项。
     *
     * 典型用途：结果后处理（摘要、索引）、观测（性能埋点）、循环检测（readFile unchanged 计数）。
     */
    afterToolCall(callback: AfterToolCallExecCallback, options?: HookOptions): () => void {
        return this.registerHook(this.afterToolCallHooks, callback, options);
    }

    async noticeAfterToolCall(ctx: AfterToolCallExecContext): Promise<void> {
        for (const hook of sortHooks(this.afterToolCallHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeAfterToolCall: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeAfterToolCall(ctx);
        }
    }

    /** 按裸工具名或带 bundle 前缀的工具名注册钩子。 */
    registerToolHook(
        toolName: string,
        hooks: {
            beforeToolCall?: BeforeToolCallExecCallback;
            afterToolCall?: AfterToolCallExecCallback;
        },
        options?: HookOptions
    ): void {
        const matches = (name: string) => name === toolName || name.endsWith(`-${toolName}`);
        if (hooks.beforeToolCall) {
            const callback = hooks.beforeToolCall;
            this.beforeToolCall(async ({ task, toolCall }) => {
                if (!matches(toolCall.tool_name)) {
                    return { operation: 'allow' };
                }
                return callback({ task, toolCall });
            }, options);
        }
        if (hooks.afterToolCall) {
            const callback = hooks.afterToolCall;
            this.afterToolCall(async ({ task, toolCall }) => {
                if (matches(toolCall.tool_name)) {
                    await callback({ task, toolCall });
                }
            }, options);
        }
    }

    /* ------------------------------------------------------------------
     * Turn Lifecycle
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeTurnStart` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每个新 turn 的**最开始**，在 `processCompletion()` 第一次调用之前触发。
     * 同一个 turn 内只会触发一次。适合在此处重置 per-turn 状态。
     * 回调签名：`(ctx: BeforeTurnStartContext) => void | Promise<void>`
     * `ctx.task` 为当前任务。
     *
     * 典型用途：重置轮次内的计数器、熔断器状态、性能计时器等。
     */
    beforeTurnStart(callback: BeforeTurnStartCallback, options?: HookOptions): void {
        this.beforeTurnStartHooks.push({ callback, options: resolveHookOptions(options) });
    }

    async noticeBeforeTurnStart(ctx: BeforeTurnStartContext): Promise<void> {
        for (const hook of sortHooks(this.beforeTurnStartHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeBeforeTurnStart: callback error', err);
            }
        }
        if (this.parent) {
            await this.parent.noticeBeforeTurnStart(ctx);
        }
    }

    /* ------------------------------------------------------------------
     * Before Chat Model Request
     * ------------------------------------------------------------------ */

    /**
     * 注册 `beforeChatModelRequest` 钩子（纯通知，无返回值）。
     *
     * 触发时机：每次向 LLM 发起请求（ask / complete / streamComplete）之前。
     * 回调签名：`(ctx: BeforeChatModelRequestContext) => void | Promise<void>`
     * - `ctx.chat`：本次请求的对话上下文；
     * - `ctx.model`：本次请求使用的模型实例；
     * - `ctx.options`：本次请求的可变选项，直接修改它即生效
     *   （headers 改 `ctx.options.extraHeaders`，参数改 `ctx.options.reasoningEffort` /
     *   `ctx.options.maxCompletionTokens`）；
     * - `ctx.task`：由 `ctx.options.task` 提供的任务（可能为 undefined）。
     *
     * 典型用途：按任务/工作区注入认证 header、渠道标识，或按模型改写请求参数。
     */
    beforeChatModelRequest(callback: BeforeChatModelRequestCallback, options?: HookOptions): () => void {
        return this.registerHook(this.beforeChatModelRequestHooks, callback, options);
    }

    async applyBeforeChatModelRequest(ctx: BeforeChatModelRequestContext): Promise<void> {
        for (const hook of sortHooks(this.beforeChatModelRequestHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.applyBeforeChatModelRequest: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent) {
            await this.parent.applyBeforeChatModelRequest(ctx);
        }
    }

    /* ------------------------------------------------------------------
     * Before Tool Call Validate
     * ------------------------------------------------------------------ */

    beforeToolCallValidate(callback: BeforeToolCallValidateCallback, options?: HookOptions): () => void {
        return this.registerHook(this.beforeToolCallValidateHooks, callback, options);
    }

    async checkBeforeToolCallValidate(ctx: BeforeToolCallValidateContext): Promise<BeforeToolCallValidateAction> {
        for (const hook of sortHooks(this.beforeToolCallValidateHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'deny') {
                    return feedback;
                }
            } catch (err) {
                logger.error('Hooks.checkBeforeToolCallValidate: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent) return await this.parent.checkBeforeToolCallValidate(ctx);
        return { operation: 'allow' };
    }

    /* ------------------------------------------------------------------
     * After Toolset Build
     * ------------------------------------------------------------------ */

    afterToolsetBuild(callback: AfterToolsetBuildCallback, options?: HookOptions): () => void {
        return this.registerHook(this.afterToolsetBuildHooks, callback, options);
    }

    async applyAfterToolsetBuild(ctx: AfterToolsetBuildContext): Promise<void> {
        for (const hook of sortHooks(this.afterToolsetBuildHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.applyAfterToolsetBuild: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent) await this.parent.applyAfterToolsetBuild(ctx);
    }

    /* ------------------------------------------------------------------
     * Permission Ask
     * ------------------------------------------------------------------ */

    beforePermissionAsk(callback: BeforePermissionAskCallback, options?: HookOptions): () => void {
        return this.registerHook(this.beforePermissionAskHooks, callback, options);
    }

    async checkBeforePermissionAsk(
        task: TaskState,
        toolCall: ToolCall,
        permissions: PermissionRequest[],
        decision: BeforePermissionAskAction['decision'] = 'ask'
    ): Promise<BeforePermissionAskAction['decision']> {
        const action: BeforePermissionAskAction = { decision };
        for (const hook of sortHooks(this.beforePermissionAskHooks)) {
            try {
                await hook.callback({ task, toolCall, permissions, action });
            } catch (err) {
                logger.error('Hooks.checkBeforePermissionAsk: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent)
            return await this.parent.checkBeforePermissionAsk(task, toolCall, permissions, action.decision);
        return action.decision;
    }

    /* ------------------------------------------------------------------
     * Skill Load
     * ------------------------------------------------------------------ */

    beforeSkillLoad(callback: BeforeSkillLoadCallback, options?: HookOptions): () => void {
        return this.registerHook(this.beforeSkillLoadHooks, callback, options);
    }

    async checkBeforeSkillLoad(ctx: SkillLoadContext): Promise<BeforeSkillLoadAction> {
        for (const hook of sortHooks(this.beforeSkillLoadHooks)) {
            try {
                const feedback = await hook.callback(ctx);
                if (feedback.operation === 'deny') return feedback;
            } catch (err) {
                logger.error('Hooks.checkBeforeSkillLoad: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent) {
            const parentFeedback = await this.parent.checkBeforeSkillLoad(ctx);
            if (parentFeedback.operation === 'deny') return parentFeedback;
        }
        return { operation: 'allow' };
    }

    afterSkillLoad(callback: AfterSkillLoadCallback, options?: HookOptions): () => void {
        return this.registerHook(this.afterSkillLoadHooks, callback, options);
    }

    async noticeAfterSkillLoad(ctx: SkillLoadContext): Promise<void> {
        for (const hook of sortHooks(this.afterSkillLoadHooks)) {
            try {
                await hook.callback(ctx);
            } catch (err) {
                logger.error('Hooks.noticeAfterSkillLoad: callback error', err);
                if (hook.options.onError === 'throw') throw err;
            }
        }
        if (this.parent) await this.parent.noticeAfterSkillLoad(ctx);
    }

    /* ------------------------------------------------------------------
     * TailCard / onTailcardGenerate
     * ------------------------------------------------------------------ */

    /**
     * 注册 `onTailcardGenerate` 钩子。
     *
     * 触发时机：每次向 LLM 发起请求之前（streamComplete 之前），在请求末尾
     * 拼接各模块生成的 TailCard。上一轮插入的 TailCard 不会留存到下一轮请求。
     * 回调签名：`(ctx: TailcardGenerationContext) => TailCard | undefined`
     * - 返回 `TailCard`：参与本次请求的 TailCards 拼接（id 唯一标识、priority
     *   决定拼接顺序、maxChars 限制单条长度）；
     * - 返回 `undefined`：本次不插入该模块的内容。
     *
     * `ctx.activeContext` 是任务被上下文压缩之后的真实视图；上下文准备失败时
     * 为 `undefined`，模块可使用 `ctx.chatContext` 回退。相同 id 重复返回时仅
     * 保留首次（注册顺序更早）的卡片；相同 priority 按注册顺序稳定排序。
     *
     * 典型用途：EvidenceCard 注入运行时 ledger、其它模块注入运行态上下文。
     */
    onTailcardGenerate(callback: OnTailcardGenerationCallback): () => void {
        return this.registerHook(this.tailcardHooks, callback);
    }

    /**
     * 调度所有已注册的 `onTailcardGenerate` 钩子，按注册顺序依次执行回调，
     * 收集非空 TailCard 后按 priority 升序（相同按注册顺序）拼接成完整的
     * TailCards 区域。单个回调抛错时仅记录日志并跳过，不影响其它回调。
     *
     * @returns 拼接后的 TailCards 文本；如果没有回调返回内容则返回 `undefined`。
     */
    private async collectTailcardSections(
        ctx: TailcardGenerationContext
    ): Promise<Array<{ id: string; content: string }>> {
        const cards: TailCard[] = [];
        for (const [order, hook] of this.tailcardHooks.entries()) {
            try {
                const card = await hook.callback(ctx);
                if (card === undefined) continue;
                cards.push(card);
            } catch (err) {
                logger.error(`Hooks.buildTailcards: callback ${order} failed`, err);
            }
        }
        if (this.parent) {
            cards.push(...(await this.parent.collectTailcardSections(ctx)));
        }
        return finalizeTailcardSections(cards);
    }

    async buildTailcards(ctx: TailcardGenerationContext): Promise<string | undefined> {
        const sections = await this.collectTailcardSections(ctx);
        return composeTailcardRegion(sections);
    }

    /* ------------------------------------------------------------------
     * 通用基础设施
     * ------------------------------------------------------------------ */

    private registerHook<CallbackType>(
        hooks: Hook<CallbackType>[],
        callback: CallbackType,
        options?: HookOptions
    ): () => void {
        const hook = { callback, options: resolveHookOptions(options) };
        hooks.push(hook);
        return () => {
            const index = hooks.indexOf(hook);
            if (index !== -1) hooks.splice(index, 1);
        };
    }
}

/** 全局钩子实例；任务级钩子通过 GlobalHooks.createChildHooks() 创建 */
export const GlobalHooks = Hooks.createGlobal();
