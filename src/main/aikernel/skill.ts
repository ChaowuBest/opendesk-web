/**
 * Copyright (c) 2026 The OpenDesk Team
 *
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

/**
 * Agent Skills 格式：对齐 Anthropic 发布的行业标准（agentskills.io）
 *
 * 规范要点：
 * - 每个技能为一个目录；拷贝到用户目录时以 SKILL.md 中的 name 作为目录名
 * - 必含文件：SKILL.md（YAML frontmatter + Markdown 正文）
 * - 必填字段：name（1-64 字符）, description（1-1024 字符）
 * - 可选字段：license, compatibility（≤500 字符）, metadata, allowed-tools（实验性）
 * - 可选子目录：scripts/, references/, assets/
 *
 * 参考：https://agentskills.io/specification
 */

import path from 'path';
import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import { BaseToolset, BaseTool, ToolResult, type ToolArgsValidationResult } from './tool';
import { z } from 'zod';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import format from 'string-template';
import { parseJsonWithRepair } from '../../utils/json.js';
import { ToolCall } from './messages';
import chalk from 'chalk';
import { statusDisplay } from '../tui/components/toolcall';
import { escapeHtml } from '../../common/utils/escape.js';
import type { TaskState } from './states/tasks';
import type { PermissionRequest } from './security/permission';
import type { TaskSkillExposure } from './agents/common.js';
import { SoulSkillProvider } from './soul/skills';
import { SoulRegistry } from './soul/registry';
import { GlobalHooks, type Hooks, type SkillLoadContext } from './hooks.js';
import { ReadableDirectoryRegistry } from './security/enforcer.js';

const NAME_MAX_LEN = 64;
const DESCRIPTION_MAX_LEN = 1024;
const COMPATIBILITY_MAX_LEN = 500;

const SKILL_FRONTMATTER_XML = `
<skill>
    <bundleName>{bundleName}</bundleName>
    <name>{skillName}</name>
    <directory>{skillDirectory}</directory>
    <description>{description}</description>
</skill>
`;

const TOOL_XML = `
<tool>
    <name>{name}</name>
    <description>{description}</description>
    <paramSchema>{parameters}</paramSchema>
</tool>
`;

function normalizeSkillExposureNames(values?: readonly string[]): Set<string> | undefined {
    const normalized = values?.map((value) => value.trim()).filter((value) => value.length > 0);
    return normalized && normalized.length > 0 ? new Set(normalized) : undefined;
}

function normalizeSkillDirectory(value?: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) {
        return undefined;
    }
    const normalized = path.normalize(trimmed);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 让技能安装目录对其所在任务可读。
 *
 * 技能正文会把「Skill 的安装路径是：<dir>」告诉模型，模型随后用文件工具读取目录内的
 * scripts/references/assets 以及 test/ 等自定义子目录。但默认可读规则只覆盖技能中心
 * 初始化时整根注册的内置技能根与用户技能根，其余来源（external_paths / --mount-skill
 * 目录、自定义 Agent / Staff 私有技能）加载成功后仍按越界读处理——GUI 下弹权限确认，
 * 子 Agent（没有交互提供者）直接被拒绝。因此技能加载成功时：
 * - 把技能目录注册进可读目录注册表，之后新建任务的权限引擎自动带上只读规则；
 * - 当前任务的权限引擎早于本次注册创建，显式补一条 read allow 规则。
 */
export async function makeSkillDirectoryReadable(task: TaskState | undefined, directory?: string): Promise<void> {
    if (!directory) return;

    ReadableDirectoryRegistry.getInstance().register(directory);
    await task?.harnessContext.grantDirectoryReadAccess(directory);
}

function normalizeSkillExposureDirectories(values?: readonly string[]): Set<string> | undefined {
    const normalized = values
        ?.map((value) => normalizeSkillDirectory(value))
        .filter((value): value is string => value !== undefined);
    return normalized && normalized.length > 0 ? new Set(normalized) : undefined;
}

function createSkillFrontmatterExposureMatcher(exposure?: TaskSkillExposure): (skill: Skill) => boolean {
    const skillNames = normalizeSkillExposureNames(exposure?.skillNames);
    const skillDirectories = normalizeSkillExposureDirectories(exposure?.skillDirectories);
    if (!skillNames && !skillDirectories) {
        return () => true;
    }
    return (skill) => {
        if (skillNames?.has(skill.frontmatter.name)) {
            return true;
        }
        const skillDirectory = normalizeSkillDirectory(skill.directory);
        return skillDirectory !== undefined && skillDirectories?.has(skillDirectory) === true;
    };
}

function isSkillExposedToAgent(skill: Skill, agentId?: string): boolean {
    return skill.agentIds === undefined || (agentId !== undefined && skill.agentIds.includes(agentId));
}

/** SKILL.md 文件名（规范要求） */
export const SKILL_MD_FILENAME = 'SKILL.md';

export interface SkillFrontmatter {
    // Anthropic Agent Skills 标准字段
    /** 技能名称（1-64 字符） */
    name: string;
    /** 技能描述（1-1024 字符） */
    description: string;
    /** 许可证信息 */
    license?: string;
    /** 兼容性说明（≤500 字符） */
    compatibility?: string;
    /** 元数据 */
    metadata?: Record<string, unknown>;
    /** 预先被允许使用的工具（即调用这些工具无需用户手动确认）列表 -- 实验性特性 */
    'allowed-tools'?: string[];

    // Claude Code 扩展字段
    /** 控制是否在 / 菜单中显示（默认 true） */
    'user-invocable'?: boolean;
    /** 阻止 LLM 自动激活此 Skill（默认 false）；为 true 时 Skill 描述不会加载到 LLM 上下文 */
    'disable-model-invocation'?: boolean;
    /** 自动补全时显示的参数提示 */
    'argument-hint'?: string;

    /** 允许扩展字段 */
    [key: string]: unknown;
}

/** 插件来源类型：builtin=内置插件，local=后装插件；技能/MCP 分类展示共用的归一化取值 */
export type PluginSourceKind = 'builtin' | 'local';

export interface SkillAttribution {
    sourceId: string;
    sourceName: string;
    /** 贡献来源的插件类型：builtin=内置插件，local=后装插件；供技能中心分类展示 */
    sourceKind?: PluginSourceKind;
}

/**
 * Skill 类表示一个 Agent Skill
 */
export class Skill {
    frontmatter: SkillFrontmatter;
    body: string;
    directory?: string;
    toolsets?: BaseToolset[];
    /**
     * 惰性工具集解析器：由 Provider 注入，在 Skill 被加载（loadSkillForAgent）时执行，
     * 返回该 Skill 最终生效的完整 toolsets（含静态与动态解析出的部分，如内部挂载的
     * MCP 工具集）。列表展示等只读场景不触发解析，保持按需连接的渐进式披露语义。
     */
    toolsetResolver?: () => Promise<BaseToolset[]>;
    /** 由外部生命周期管理器提供，只允许宿主展示和调用。 */
    readOnly = false;
    /** 由宿主贡献的 Skill 的来源标识，不写入 SKILL.md frontmatter。 */
    attribution?: SkillAttribution;
    /**
     * 限定 Skill 仅向指定 Agent 暴露。
     * undefined 表示不限定；空数组表示不向任何 Agent 暴露。
     */
    agentIds?: readonly string[];
    /** skill 自带的 .env 文件中的环境变量，加载 skill 时从 directory/.env 解析 */
    env: Record<string, string> = {};

    constructor(frontmatter: SkillFrontmatter, body: string, directory?: string, toolsets?: BaseToolset[]) {
        this.frontmatter = frontmatter;
        this.body = body;
        this.directory = directory;
        this.toolsets = toolsets;
        if (directory) {
            const envPath = path.join(directory, '.env');
            if (fs.existsSync(envPath)) {
                try {
                    this.env = dotenv.parse(fs.readFileSync(envPath, 'utf-8'));
                } catch {
                    /* .env 解析失败不影响 skill 加载 */
                }
            }
        }
    }

    /** 用户是否可以通过 /skillname 调用此 Skill（默认 true） */
    get isUserInvocable(): boolean {
        return this.frontmatter['user-invocable'] !== false;
    }

    /** LLM 是否可以自动激活此 Skill（默认 true；disable-model-invocation=true 时为 false） */
    get isModelInvocable(): boolean {
        return this.frontmatter['disable-model-invocation'] !== true;
    }

    getFullContent() {
        let result = '';
        if (this.directory) {
            result += `Skill 的安装路径是：${this.directory}\n\n`;
        }
        result += this.body;
        // resolver 可能产出空数组（如内部 MCP 全部未连接），此时视作没有内部工具
        if (!this.toolsets || this.toolsets.length === 0) {
            return result;
        }

        result += '\n\n';
        result += '# 该Skill自带的可以被CallSkillTool调用的内部工具\n\n';
        result += '<tools>\n';
        for (const toolset of this.toolsets) {
            for (const [, tool] of toolset.tools) {
                result += format(TOOL_XML, {
                    name: tool.name,
                    description: tool.description,
                    parameters: JSON.stringify(tool.getJsonSchema())
                });
            }
        }
        result += '</tools>';

        return result;
    }

    /**
     * 根据工具名称获取工具
     * @param toolName - 工具名称
     * @returns 找到的工具，未找到返回 undefined
     */
    getTool(toolName: string): BaseTool<z.ZodType> | undefined {
        if (!this.toolsets) {
            return undefined;
        }
        for (const toolset of this.toolsets) {
            const tool = toolset.getTool(toolName);
            if (tool) {
                return tool;
            }
        }
        return undefined;
    }

    /**
     * 尝试修补常见的 YAML frontmatter 格式错误，使其可被严格解析器接受。
     *
     * 已知的技能作者常犯错误：
     *  1. 未加引号的冒号值 — `description: 支持 http://xxx 的访问`
     *     YAML 将第二个冒号视为嵌套映射，导致解析失败。
     *     修补：用 JSON.stringify 包裹整个值。
     *
     *  2. 未闭合的双引号 — `description: "很长的描述但忘了关引号`
     *     YAML 期望匹配的关闭引号，遇到 EOF 报错。
     *     修补：在行尾补上对应的闭合引号。
     *
     *  3. 未闭合的单引号 — 同上，单引号版本。
     *
     * @returns 修补后的文本；如果无需修补则返回原文
     */
    static patchFrontmatterYaml(raw: string): string {
        return raw
            .split('\n')
            .map((line) => {
                const m = line.match(/^(\w[\w-]*):(\s+)(.+)$/);
                if (!m) return line;
                const [, key, spacing, value] = m;
                if (value.includes(':') && !value.startsWith('"') && !value.startsWith("'")) {
                    return key + ':' + spacing + JSON.stringify(value);
                }
                if (value.startsWith('"') && !value.endsWith('"')) {
                    return key + ':' + spacing + value + '"';
                }
                if (value.startsWith("'") && !value.endsWith("'")) {
                    return key + ':' + spacing + value + "'";
                }
                return line;
            })
            .join('\n');
    }

    /**
     * 先用严格解析尝试；失败后自动 patch 再重试一次。
     * @throws 如果 patch 后仍然解析失败
     */
    private static tryParseYamlWithPatch(raw: string): SkillFrontmatter {
        try {
            return parseYaml(raw) as SkillFrontmatter;
        } catch (firstErr) {
            const patched = Skill.patchFrontmatterYaml(raw);
            if (patched === raw) {
                const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
                throw new Error(`YAML frontmatter 解析失败: ${msg}`);
            }
            try {
                return parseYaml(patched) as SkillFrontmatter;
            } catch (_) {
                const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
                throw new Error(`YAML frontmatter 解析失败: ${msg}`);
            }
        }
    }

    /**
     * 解析并验证 SKILL.md 内容
     * @param raw - 文件全文
     * @returns 解析后的 Skill 对象
     * @throws 如果解析或验证失败
     */
    static parseMd(raw: string): Skill {
        if (typeof raw !== 'string' || !raw.trim()) {
            throw new Error('SKILL.md 内容为空');
        }
        const trimmed = raw.trim();
        if (!trimmed.startsWith('---')) {
            throw new Error('SKILL.md 必须以 YAML frontmatter（---）开头');
        }
        const secondDash = trimmed.indexOf('\n---', 3);
        if (secondDash === -1) {
            throw new Error('SKILL.md 未找到 frontmatter 结束标记（---）');
        }
        const frontmatterRaw = trimmed.slice(3, secondDash).trim();
        const body = trimmed.slice(secondDash + 4).trim();
        const frontmatter = Skill.tryParseYamlWithPatch(frontmatterRaw);
        if (!frontmatter || typeof frontmatter !== 'object') {
            throw new Error('frontmatter 必须为非空对象');
        }

        // 验证 frontmatter
        Skill.validateFrontmatter(frontmatter);

        return new Skill(frontmatter, body);
    }

    /**
     * 校验 name 字段（1-64 字符，非空即可）
     * @param name - 技能名称
     * @throws 如果验证失败
     */
    static validateName(name: unknown): void {
        if (typeof name !== 'string') {
            throw new Error('name 必须为字符串');
        }
        const trimmed = name.trim();
        if (trimmed.length === 0) {
            throw new Error('name 不能为空');
        }
        if (trimmed.length > NAME_MAX_LEN) {
            throw new Error(`name 长度不能超过 ${NAME_MAX_LEN} 字符`);
        }
    }

    /**
     * 校验 description 字段（1-1024 字符）
     * @param description - 技能描述
     * @throws 如果验证失败
     */
    static validateDescription(description: unknown): void {
        if (description == null) {
            throw new Error('description 必填');
        }
        const str = typeof description === 'string' ? description : String(description);
        if (str.length === 0) {
            throw new Error('description 不能为空');
        }
        if (str.length > DESCRIPTION_MAX_LEN) {
            throw new Error(`description 长度不能超过 ${DESCRIPTION_MAX_LEN} 字符`);
        }
    }

    /**
     * 校验完整 frontmatter（必填 name、description；可选 license、compatibility、metadata、allowed-tools）
     * @param frontmatter - 解析后的 YAML 对象
     * @throws 如果验证失败
     */
    static validateFrontmatter(frontmatter: unknown): void {
        if (!frontmatter || typeof frontmatter !== 'object') {
            throw new Error('frontmatter 必须为非空对象');
        }
        const fm = frontmatter as Record<string, unknown>;
        Skill.validateName(fm.name);
        Skill.validateDescription(fm.description);
        if (fm.compatibility != null) {
            const comp = String(fm.compatibility);
            if (comp.length > COMPATIBILITY_MAX_LEN) {
                throw new Error(`compatibility 长度不能超过 ${COMPATIBILITY_MAX_LEN} 字符`);
            }
        }
    }
}

const LoadSkillSchema = z.object({
    bundleName: z.string().describe('要读取的Skill所属的应用名(bundleName)'),
    skillName: z.string().describe('要读取的Skill的名称(name)')
});

class LoadSkillTool extends BaseTool<typeof LoadSkillSchema> {
    constructor() {
        super('LoadSkill', '读取指定技能(Skill)的内容', LoadSkillSchema, undefined, {
            'zh-CN': '读取技能',
            'en-US': 'Load Skill'
        });
        this.setExecutor(this.loadSkill.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof LoadSkillSchema>): PermissionRequest[] {
        const resourcePath = `${args.bundleName}/${args.skillName}`;
        if (/[\r\n\x00-\x1f\u2028\u2029]/.test(resourcePath)) return [];
        return [{ resourceType: 'skill', action: 'read', resourcePath }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof LoadSkillSchema> | undefined;
        const bundleName = args?.bundleName || '';
        const skillName = args?.skillName || '';

        const provider = SkillRegistry.getInstance().getSkillProvider(bundleName);
        const appDisplayName = (provider as any)?.name || bundleName;

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const chevron = '<i class="fas fa-chevron-right text-slate-500" style="font-size:8px;margin:0 2px;"></i>';
        const crumbs: string[] = [];
        if (appDisplayName) crumbs.push(`<span class="text-slate-500">${escapeHtml(appDisplayName)}</span>`);
        if (skillName) crumbs.push(`<span class="text-slate-400 font-medium">${escapeHtml(skillName)}</span>`);
        const breadcrumbHtml =
            crumbs.length > 0
                ? `<span class="truncate text-xs inline-flex items-center gap-1">${crumbs.join(chevron)}</span>`
                : '';

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-book shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">加载技能</span>
                ${statusIcon}
                ${breadcrumbHtml}
            </div>
        </div>`;
    }

    renderToolCallCli(toolcall: ToolCall, _width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof LoadSkillSchema> | undefined;
        if (!args) {
            return [chalk.dim('📚 加载技能...')];
        }

        const { bundleName, skillName } = args;
        const { icon } = statusDisplay(toolcall.status);

        const provider = SkillRegistry.getInstance().getSkillProvider(bundleName);
        const appName = (provider as any)?.name || bundleName;
        const title = `${appName} › ${skillName}`;

        if (toolcall.status === 'running') {
            return [`  ${icon} ${chalk.cyan('📚')} ${chalk.bold(title)} ${chalk.dim('· 加载中...')}`];
        } else if (toolcall.status === 'success') {
            return [`  ${icon} ${chalk.cyan('📚')} ${chalk.bold(title)} ${chalk.dim('· 已加载')}`];
        } else if (toolcall.status === 'error') {
            return [`  ${icon} ${chalk.red('📚')} ${chalk.bold(title)} ${chalk.dim('· 加载失败')}`];
        } else {
            return [`  ${icon} ${chalk.cyan('📚')} ${chalk.bold(title)}`];
        }
    }

    private async loadSkill(args: z.output<typeof LoadSkillSchema>, taskState?: TaskState): Promise<string> {
        const loaded = await SkillRegistry.getInstance().loadSkillForAgent(
            args.bundleName,
            args.skillName,
            taskState?.agentId,
            taskState?.hooks
        );
        if (!loaded) {
            return '未找到该Skill';
        } else {
            const { skill, content } = loaded;

            // 技能目录（含 test/ 等自定义子目录）随技能加载开放只读，避免模型读技能资源时被权限拦住
            await makeSkillDirectoryReadable(taskState, skill.directory);

            // 将 skill 的 .env 环境变量合并到当前 task 的 harnessContext.environ
            if (taskState && skill.env && Object.keys(skill.env).length > 0) {
                Object.assign(taskState.harnessContext.environ, skill.env);
                logger.info(
                    `skill ${args.skillName} env merged to task harnessContext.environ: ${Object.keys(skill.env).join(', ')}`
                );
            }

            // 已加载技能不再单独 push 到 taskState.loadedSkills 字段：
            // 安全网关拦截归因改由 TaskState.getLoadedSkillsFromContext() 从
            // chat_context 的 LoadSkill ToolCall 实时反推，覆盖更全且随回退自动同步。

            logger.info(`skill ${args.bundleName} ${args.skillName} 的完整内容是:\n` + content);
            return content;
        }
    }
}

const CallSkillToolSchema = z.object({
    bundleName: z.string().describe('要调用的Skill内置工具所属的应用名(bundleName)'),
    skillName: z.string().describe('要调用的Skill的名称'),
    toolName: z.string().describe('要调用的工具名称'),
    arguments: z
        .unknown()
        .optional()
        .describe('要传递给工具的参数, 该参数是一个object, 应该遵循被调用的工具给出的Schema。无参数工具可省略或传{}')
});

/**
 * arguments 字段改名前（历史任务记录 / 旧提示词）使用的外层参数旧名。
 * 解析与平铺参数修复时需识别旧名并回退，避免模型沿用旧习惯传参时内层参数整体丢失。
 */
const LEGACY_TOOL_ARGS_KEY = 'toolArgs';

/**
 * 创建一个临时的 ToolCall 对象用于渲染内部工具调用
 * @param toolName - 内部工具名称
 * @param toolArgs - 内部工具参数
 * @param tool - 内部工具实例
 * @param parentToolCall - 父工具调用对象（用于继承状态等信息）
 * @returns 临时 ToolCall 对象
 */
function createInnerToolCall(
    toolName: string,
    toolArgs: object,
    tool: BaseTool<z.ZodType>,
    parentToolCall: ToolCall
): ToolCall {
    const innerToolCall = new ToolCall(0, `inner-${toolName}`, toolName, JSON.stringify(toolArgs));
    innerToolCall.args_object = toolArgs;
    innerToolCall.status = parentToolCall.status;
    innerToolCall.result = parentToolCall.result;
    innerToolCall.result_object = parentToolCall.result_object;
    innerToolCall.setTool(tool);
    return innerToolCall;
}

function parseCallSkillToolArgs(innerArgs: unknown): object {
    if (innerArgs === undefined || innerArgs === null) {
        return {};
    }
    if (typeof innerArgs === 'object') {
        return innerArgs;
    }
    if (typeof innerArgs === 'string') {
        const trimmed = innerArgs.trim();
        if (trimmed.length === 0) {
            return {};
        }
        const parsed = parseJsonWithRepair(trimmed);
        if (parsed === null) {
            return {};
        }
        if (typeof parsed === 'object') {
            return parsed;
        }
    }
    throw new Error('内层工具参数无法解析');
}

/**
 * 读取调用入参中显式声明的内层工具参数字段。
 * arguments 缺失时回退改名前的旧名 toolArgs，保证改名不影响旧习惯调用与历史记录回放。
 */
function resolveExplicitInnerArgs(record: Record<string, unknown>): unknown {
    if (record['arguments'] !== undefined) {
        return record['arguments'];
    }
    return record[LEGACY_TOOL_ARGS_KEY];
}

class CallSkillTool extends BaseTool<typeof CallSkillToolSchema> {
    /** CallSkillTool 自身 schema 的外层字段（从 schema 派生，新增外层字段时自动同步）+ 改名前旧名，平铺参数修复时需从候选内层参数中剔除 */
    private static readonly OUTER_ARG_KEYS: readonly string[] = [
        ...Object.keys(CallSkillToolSchema.shape),
        LEGACY_TOOL_ARGS_KEY
    ];

    constructor() {
        super(
            'CallSkillTool',
            '调用Skill提供的内部工具, 只有先调用LoadSkillTool加载了Skill, 才能调用它的内部工具',
            CallSkillToolSchema,
            undefined,
            { 'zh-CN': '调用技能', 'en-US': 'Call Skill' }
        );
        this.setUniversalExecutor(this.callSkillToolUniversal.bind(this));
    }

    /**
     * 部分模型在调用 CallSkillTool 时会把内部工具参数直接平铺到顶层，
     * 丢失 toolName/arguments 包装，或仍按改名前旧名 toolArgs 传递内层参数，
     * 导致内层参数整体丢失，且模型重试往往重复同样的错误。
     * 此方法尝试把这类参数还原为规范的 { bundleName, skillName, toolName, arguments } 结构。
     * 仅当已加载技能的内部工具 schema 能唯一解释全部平铺字段时才修复，避免误判。
     */
    private resolveSkillToolArgs(
        raw: unknown
    ): { bundleName: string; skillName: string; toolName: string; arguments: object } | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return undefined;
        }
        const record = raw as Record<string, unknown>;
        const bundleName = typeof record['bundleName'] === 'string' ? record['bundleName'] : undefined;
        const skillName = typeof record['skillName'] === 'string' ? record['skillName'] : undefined;
        if (!bundleName || !skillName) {
            return undefined;
        }

        const toolName = typeof record['toolName'] === 'string' ? record['toolName'] : undefined;
        if (toolName) {
            let innerArgs: object;
            try {
                innerArgs = parseCallSkillToolArgs(resolveExplicitInnerArgs(record));
            } catch {
                innerArgs = {};
            }
            return { bundleName, skillName, toolName, arguments: innerArgs };
        }

        // toolName 缺失：合并顶层平铺字段与显式 arguments（同名字段以显式 arguments 为准，旧名 toolArgs 参与回退）后推断
        const flatArgs: Record<string, unknown> = {};
        let hasFlatArgs = false;
        for (const [key, value] of Object.entries(record)) {
            if (CallSkillTool.OUTER_ARG_KEYS.includes(key)) {
                continue;
            }
            flatArgs[key] = value;
            hasFlatArgs = true;
        }
        // toolName 缺失：显式 arguments 可能是 JSON 字符串（部分模型按字符串嵌套传递，见 task_mtvpprvf_91ts 故障），先解析成对象
        let parsedExplicitInnerArgs: unknown;
        try {
            parsedExplicitInnerArgs = parseCallSkillToolArgs(resolveExplicitInnerArgs(record));
        } catch {
            parsedExplicitInnerArgs = undefined;
        }
        if (
            parsedExplicitInnerArgs &&
            typeof parsedExplicitInnerArgs === 'object' &&
            !Array.isArray(parsedExplicitInnerArgs)
        ) {
            Object.assign(flatArgs, parsedExplicitInnerArgs);
            hasFlatArgs = true;
        }
        if (!hasFlatArgs) {
            return undefined;
        }

        const skill = SkillRegistry.getInstance().getCachedSkill(bundleName, skillName);
        if (!skill) {
            return undefined;
        }
        const inferredToolName = this.inferInnerToolName(skill, flatArgs);
        if (!inferredToolName) {
            return undefined;
        }
        return { bundleName, skillName, toolName: inferredToolName, arguments: flatArgs };
    }

    /**
     * 根据平铺参数在各内部工具 schema 上的命中情况推断 toolName。
     * 候选必须满足：所有平铺字段都能被该工具 schema 解释，且至少命中一个必填字段；
     * 多个候选打分完全相同时视为歧义，返回 undefined（宁可不修复也不误判）。
     */
    private inferInnerToolName(skill: Skill, flatArgs: Record<string, unknown>): string | undefined {
        if (!skill.toolsets) {
            return undefined;
        }
        const flatKeys = Object.keys(flatArgs);
        if (flatKeys.length === 0) {
            return undefined;
        }

        interface Candidate {
            name: string;
            requiredRatio: number;
            hitCount: number;
        }
        const candidates: Candidate[] = [];
        for (const toolset of skill.toolsets) {
            for (const [, tool] of toolset.tools) {
                const jsonSchema = tool.getJsonSchema();
                const properties = (jsonSchema?.properties ?? {}) as Record<string, unknown>;
                const required = Array.isArray(jsonSchema?.required) ? (jsonSchema.required as string[]) : [];
                let unknownKeys = 0;
                let requiredHits = 0;
                let hitCount = 0;
                for (const key of flatKeys) {
                    if (key in properties) {
                        hitCount++;
                        if (required.includes(key)) {
                            requiredHits++;
                        }
                    } else {
                        unknownKeys++;
                    }
                }
                if (unknownKeys > 0 || requiredHits === 0) {
                    continue;
                }
                const requiredRatio = required.length > 0 ? requiredHits / required.length : 0;
                candidates.push({ name: tool.name, requiredRatio, hitCount });
            }
        }
        if (candidates.length === 0) {
            return undefined;
        }
        candidates.sort((a, b) => b.requiredRatio - a.requiredRatio || b.hitCount - a.hitCount);
        const top = candidates[0];
        const runnerUp = candidates[1];
        if (runnerUp && runnerUp.requiredRatio === top.requiredRatio && runnerUp.hitCount === top.hitCount) {
            return undefined;
        }
        return top.name;
    }

    /**
     * 改名兼容：arguments 缺失且存在旧名 toolArgs 时，把旧名重命名为 arguments 返回。
     * zod 会把旧名 toolArgs 当未知字段忽略、把 optional 的 arguments 视为缺失，
     * schema 校验会静默通过但内层参数整体丢失（真实故障 task 5f9d23b1 的静默失败路径），
     * 因此必须在成功路径上主动归一化。仅处理带 toolName 的规范形态；
     * 无 toolName 的平铺形态由 resolveSkillToolArgs 推断处理。
     * 旧名内容无法解析（如标量）时直接抛错，由 validateArgs 转为显式失败，
     * 避免静默丢弃参数退化为空参执行（改名前 execute 主路径对同类输入即显式报错）。
     */
    private normalizeLegacyInnerArgs(raw: unknown): object | undefined {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            return undefined;
        }
        const record = raw as Record<string, unknown>;
        if (record['arguments'] !== undefined || record[LEGACY_TOOL_ARGS_KEY] === undefined) {
            return undefined;
        }
        if (typeof record['toolName'] !== 'string') {
            return undefined;
        }
        const innerArgs = parseCallSkillToolArgs(record[LEGACY_TOOL_ARGS_KEY]);
        const { [LEGACY_TOOL_ARGS_KEY]: _legacy, ...rest } = record;
        return { ...rest, arguments: innerArgs };
    }

    validateArgs(args: unknown): ToolArgsValidationResult<typeof CallSkillToolSchema> {
        const baseResult = super.validateArgs(args);
        if (baseResult.success) {
            try {
                const normalized = this.normalizeLegacyInnerArgs(args);
                if (normalized) {
                    const normalizedResult = super.validateArgs(normalized);
                    if (normalizedResult.success) {
                        return { ...normalizedResult, repaired: true };
                    }
                }
            } catch (err) {
                return {
                    success: false,
                    error: err instanceof Error ? err.message : String(err)
                };
            }
            return baseResult;
        }
        const repaired = this.resolveSkillToolArgs(args);
        if (!repaired) {
            return baseResult;
        }
        const repairedResult = super.validateArgs(repaired);
        return repairedResult.success ? { ...repairedResult, repaired: true } : baseResult;
    }

    getDeclaredPermissions(args: z.output<typeof CallSkillToolSchema>): PermissionRequest[] {
        // 委托给内部工具的权限声明。
        // args 可能未经 schema 校验（如缺失 toolName 的平铺参数），
        // 先尝试解析/修复，保证修复后的调用不会绕过内部工具的权限审批
        const resolved = this.resolveSkillToolArgs(args);
        if (!resolved) {
            return [];
        }
        const cachedSkill = SkillRegistry.getInstance().getCachedSkill(resolved.bundleName, resolved.skillName);
        if (cachedSkill) {
            const innerTool = cachedSkill.getTool(resolved.toolName);
            if (innerTool) {
                const innerPerms = innerTool.getDeclaredPermissions(resolved.arguments);
                if (innerPerms.length > 0) {
                    return innerPerms;
                }
            }
        }
        return [];
    }

    /**
     * 渲染 CallSkillTool 工具调用的 Electron HTML 界面
     * 优先使用内部工具的自定义渲染，否则展示统一的技能调用面包屑卡片
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const inner = this.resolveInnerTool(toolcall);
        if (inner) {
            const result = await inner.tool.renderToolCall(inner.toolCall);
            if (result) return result;
        }

        const args = toolcall.args_object as z.output<typeof CallSkillToolSchema> | undefined;
        const bundleName = args?.bundleName || '';
        const skillName = args?.skillName || '';
        const toolName = args?.toolName || '';

        // 使用应用 name（显示名称）而非 bundleName
        const provider = SkillRegistry.getInstance().getSkillProvider(bundleName);
        const appDisplayName = (provider as any)?.name || bundleName;

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const chevron = '<i class="fas fa-chevron-right text-slate-500" style="font-size:8px;margin:0 2px;"></i>';
        const crumbs: string[] = [];
        if (appDisplayName) crumbs.push(`<span class="text-slate-500">${escapeHtml(appDisplayName)}</span>`);
        if (skillName) crumbs.push(`<span class="text-slate-500">${escapeHtml(skillName)}</span>`);
        if (toolName) crumbs.push(`<span class="text-slate-400 font-medium">${escapeHtml(toolName)}</span>`);
        const breadcrumbHtml =
            crumbs.length > 0
                ? `<span class="truncate text-xs inline-flex items-center gap-1">${crumbs.join(chevron)}</span>`
                : '';

        return `<div class="od-inline-toolcall-container">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-bolt shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">调用技能</span>
                ${statusIcon}
                ${breadcrumbHtml}
            </div>
        </div>`;
    }

    /**
     * 渲染 CallSkillTool 工具调用的 TUI 界面
     * 优先使用内部工具的自定义渲染，否则显示默认的技能工具调用卡片
     */
    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const args = toolcall.args_object as z.output<typeof CallSkillToolSchema> | undefined;
        if (!args) {
            return this.renderDefaultCard(toolcall, width, '', '', '');
        }

        const { bundleName, skillName, toolName } = args;
        if (!bundleName || !skillName || !toolName) {
            return this.renderDefaultCard(toolcall, width, bundleName || '', skillName || '', toolName || '');
        }

        const inner = this.resolveInnerTool(toolcall);
        if (inner) {
            const customRender = inner.tool.renderToolCallCli(inner.toolCall, width);
            if (customRender) return customRender;
        }

        return this.renderDefaultCard(toolcall, width, bundleName, skillName, toolName);
    }

    requiresUserAttention(toolcall: ToolCall): boolean | undefined {
        const inner = this.resolveInnerTool(toolcall);
        return inner?.tool.requiresUserAttention(inner.toolCall);
    }

    /**
     * 从父级 ToolCall 中解析并构建内部工具的 ToolCall，供渲染使用
     */
    private resolveInnerTool(toolcall: ToolCall): { tool: BaseTool<z.ZodType>; toolCall: ToolCall } | undefined {
        const args = toolcall.args_object as z.output<typeof CallSkillToolSchema> | undefined;
        if (!args?.bundleName || !args?.skillName || !args?.toolName) return undefined;

        const cachedSkill = SkillRegistry.getInstance().getCachedSkill(args.bundleName, args.skillName);
        if (!cachedSkill) return undefined;

        const innerTool = cachedSkill.getTool(args.toolName);
        if (!innerTool) return undefined;

        let parsedToolArgs: object;
        try {
            // 历史任务记录回放时 args_object 可能仍是旧名 toolArgs，统一经回退解析
            parsedToolArgs = parseCallSkillToolArgs(resolveExplicitInnerArgs(args as Record<string, unknown>));
        } catch {
            parsedToolArgs = {};
        }

        const innerToolCall = createInnerToolCall(args.toolName, parsedToolArgs, innerTool, toolcall);
        return { tool: innerTool, toolCall: innerToolCall };
    }

    /**
     * 渲染默认的技能工具调用卡片（面包屑风格：应用名 › 技能名 › 工具名）
     */
    private renderDefaultCard(
        toolcall: ToolCall,
        width: number,
        bundleName: string,
        skillName: string,
        toolName: string
    ): string[] {
        const { icon } = statusDisplay(toolcall.status);

        const provider = SkillRegistry.getInstance().getSkillProvider(bundleName);
        const appName = (provider as any)?.name || bundleName || '未知应用';
        const skill = skillName || '未知技能';
        const tool = toolName || '未知工具';

        const sep = chalk.dim(' › ');
        const breadcrumb = chalk.dim(appName) + sep + chalk.dim(skill) + sep + chalk.bold(tool);

        const accentColor =
            toolcall.status === 'error'
                ? chalk.red
                : toolcall.status === 'success'
                  ? chalk.green
                  : toolcall.status === 'running'
                    ? chalk.blue
                    : chalk.dim;

        const header = `  ${icon} ${chalk.magenta('⚡')} ${breadcrumb}`;

        if (toolcall.status === 'running') {
            return [header + ' ' + accentColor('执行中...')];
        } else if (toolcall.status === 'success') {
            return [header + ' ' + accentColor('完成')];
        } else if (toolcall.status === 'error') {
            return [header + ' ' + accentColor('失败')];
        } else {
            return [header];
        }
    }

    /**
     * 内层参数校验失败时生成自我纠正指引：
     * 列出该工具的必填参数（含类型）与本次实际收到的字段；
     * 收到空参数时额外点名外层字段名错误（如沿用旧名 toolArgs）这一常见根因，
     * 对应真实故障（task 5f9d23b1）：模型反复收到 "target: 类型不正确或缺少必要字段"
     * 这类含糊错误后无法定位根因，盲目重试十余次。
     */
    private buildInnerArgsErrorGuidance(tool: BaseTool<z.ZodType>, toolArgs: object): string {
        const jsonSchema = tool.getJsonSchema();
        const required = Array.isArray(jsonSchema?.required) ? (jsonSchema.required as string[]) : [];
        const properties = (jsonSchema?.properties ?? {}) as Record<string, { type?: string }>;
        const receivedKeys = Object.keys(toolArgs);
        const parts: string[] = [];
        if (required.length > 0) {
            const requiredDesc = required.map((name) => `${name}(${properties[name]?.type ?? 'any'})`).join(', ');
            parts.push(`内部工具 ${tool.name} 要求以下必填参数: ${requiredDesc}`);
        }
        if (receivedKeys.length === 0) {
            parts.push(
                `本次调用没有收到任何内层参数。参数必须放在 CallSkillTool 顶层 arguments 字段中传递；` +
                    `请检查是否误用了其他字段名（如 ${LEGACY_TOOL_ARGS_KEY}/args/params），或把参数平铺到了顶层`
            );
        } else {
            parts.push(`本次调用收到的内层参数字段: ${receivedKeys.join(', ')}，请对照上方必填参数补齐或修正字段名`);
        }
        return parts.join('。') + '。';
    }

    /**
     * 通用执行器：转发 updatedCallback 和 taskState 给内部工具，
     * 使内部工具的流式更新（如 QR 码渲染）能够传播到 TUI/Electron 前端。
     */
    private async callSkillToolUniversal(
        args: z.output<typeof CallSkillToolSchema>,
        parentResult: ToolResult,
        taskState?: TaskState
    ): Promise<void> {
        const skill = await SkillRegistry.getInstance().getSkillForAgent(
            args.bundleName,
            args.skillName,
            taskState?.agentId
        );
        if (!skill) {
            parentResult.updateResult('未找到该Skill');
            return;
        }

        const tool = skill.getTool(args.toolName);
        if (!tool) {
            parentResult.updateResult(`未找到工具 ${args.toolName}`);
            return;
        }

        try {
            const toolArgs = parseCallSkillToolArgs(args.arguments);

            logger.info(`call skill tool ${args.toolName} with ${JSON.stringify(args.arguments)}`);

            // 内层参数预检：校验失败时直接返回带必填参数指引的错误，
            // 让模型能对照参数列表发现外层字段名写错（如误用旧名 toolArgs/args）或漏传参数并自我纠正，
            // 而不是收到含糊的逐字段校验错误后盲目重试
            const precheck = tool.validateArgs(toolArgs);
            if (!precheck.success) {
                throw new Error(`${precheck.error}。${this.buildInnerArgsErrorGuidance(tool, toolArgs)}`);
            }

            // skill 内部工具执行前送审 AgentGate 安全网关。
            // executeToolCall 的 checkBeforeToolCall 只针对 CallSkillTool 本身
            // （action_detail 只有 bundleName/skillName/toolName，无真实命令），
            // skill 内部工具的真实命令（如 executeBash 的 command）必须在此送审，
            // 否则 rm -rf / 类危险操作逃过 AgentMoss。
            const innerToolCall = new ToolCall(
                0,
                `inner-${args.toolName}-${Date.now()}`,
                args.toolName,
                JSON.stringify(toolArgs)
            );
            innerToolCall.args_object = toolArgs;
            if (taskState?.hooks) {
                const innerFeedback = await taskState.hooks.checkBeforeToolCall({
                    task: taskState,
                    toolCall: innerToolCall
                });
                if (innerFeedback?.operation === 'deny') {
                    const msg = innerFeedback.message || 'skill 内部工具被安全网关拦截';
                    parentResult.updateResult(`skill 内部工具 ${args.toolName} 被拦截: ${msg}`);
                    throw new Error(`skill tool ${args.toolName} denied by hook: ${msg}`);
                }
            }

            const innerResult = await tool.execute(
                toolArgs,
                (innerToolResult) => {
                    parentResult.result = innerToolResult.result;
                    parentResult.result_object = innerToolResult.result_object;
                    if (parentResult.updatedCallback) {
                        parentResult.updatedCallback(parentResult);
                    }
                },
                taskState
            );

            parentResult.result = innerResult.result;
            parentResult.result_object = innerResult.result_object;

            if (innerResult.status === 'error') {
                throw new Error(innerResult.result || '工具调用失败');
            }
        } catch (err) {
            logger.error(`skill tool call failed: ${err}`);
            const errorMessage = err instanceof Error ? err.message : String(err);
            parentResult.updateResult(`工具调用失败: ${errorMessage}`);
            throw new Error(`工具调用失败: ${errorMessage}`);
        }
    }
}

export interface SkillProvider {
    /**
     * 技能归属的应用 bundleName。
     *
     * 大多数 provider 直接由应用实现，provider key 就是 bundleName，无需声明；
     * 应用内 agent 的专属技能（key 形如 `staff:xxx`）必须声明归属，
     * 否则应用被插件禁用时这组技能会漏过应用级门控。
     */
    readonly ownerBundleName?: string;
    getSkills(): Promise<Skill[]>;
}

export interface LoadedSkillResult {
    skill: Skill;
    content: string;
}

export class SkillLoadBlockedError extends Error {
    readonly code = 'skill.load.blocked';

    constructor(
        readonly bundleName: string,
        readonly skillName: string,
        message?: string,
        readonly metadata?: Record<string, unknown>
    ) {
        super(message || `Skill load blocked: ${bundleName}/${skillName}`);
        this.name = 'SkillLoadBlockedError';
    }
}

export class SkillRegistry {
    static instance: SkillRegistry | null = null;

    /** 由 applications 层注入的技能过滤函数列表，用于统一实现启用/禁用控制 */
    static skillFilters: Array<(bundleName: string, skillName: string) => boolean> = [];

    /**
     * 由 applications 层注入的 provider 级过滤函数：返回 false 时该 bundle 的全部技能视为不存在
     * （被插件禁用的应用）。所有 filter 都返回 true 时 provider 才可用（AND 逻辑）。
     * 与 skillFilters 分开是因为这里要挡住整组技能，包括 getCachedSkill / getSkillProvider
     * 这类不经过 isSkillEnabled 的查找路径。
     */
    static providerFilters: Array<(bundleName: string) => boolean> = [];

    /**
     * 注册 provider 级过滤函数。通常由 applications 层注入「应用是否被插件禁用」的判断。
     */
    static registerProviderFilter(filter: (bundleName: string) => boolean): void {
        SkillRegistry.providerFilters.push(filter);
    }

    static unregisterProviderFilter(filter: (bundleName: string) => boolean): void {
        const idx = SkillRegistry.providerFilters.indexOf(filter);
        if (idx !== -1) SkillRegistry.providerFilters.splice(idx, 1);
    }

    /**
     * 注册技能过滤函数。所有已注册的 filter 都返回 true 时，技能才算启用（AND 逻辑）。
     * 通常在 applications 层调用，注入状态管理逻辑。
     */
    static registerSkillFilter(filter: (bundleName: string, skillName: string) => boolean): void {
        SkillRegistry.skillFilters.push(filter);
    }

    /**
     * 注销技能过滤函数。
     */
    static unregisterSkillFilter(filter: (bundleName: string, skillName: string) => boolean): void {
        const idx = SkillRegistry.skillFilters.indexOf(filter);
        if (idx !== -1) SkillRegistry.skillFilters.splice(idx, 1);
    }

    providers: Map<string, SkillProvider> = new Map();

    /** per-provider getSkills 结果缓存：provider 重建技能对象成本高（parseMd/new Toolset/new Tool×N），
     *  技能列表变更统一经 clearCache 失效，provider 注册变化时按 bundle 失效 */
    private providerSkillsCache: Map<string, Promise<Skill[]>> = new Map();

    /** Skill 缓存，用于同步获取已加载的 Skill */
    private skillCache: Map<string, Map<string, Skill>> = new Map();

    /** provider 是否可用（被插件禁用的应用整组技能不可见） */
    private isProviderEnabled(bundleName: string): boolean {
        // 按归属应用判断：provider key 通常就是应用名；应用内 agent 的技能 provider
        // （key 形如 staff:xxx）通过 ownerBundleName 声明归属，随应用一起停用
        const owner = this.providers.get(bundleName)?.ownerBundleName ?? bundleName;
        return SkillRegistry.providerFilters.every((f) => f(owner));
    }

    /** 检查技能是否被禁用（无 filter 时默认全部启用，所有 filter AND 通过才算启用） */
    private isSkillEnabled(bundleName: string, skillName: string): boolean {
        if (!this.isProviderEnabled(bundleName)) return false;
        return SkillRegistry.skillFilters.every((f) => f(bundleName, skillName));
    }

    static getInstance(): SkillRegistry {
        if (SkillRegistry.instance === null) {
            SkillRegistry.instance = new SkillRegistry();
            SkillRegistry.instance.registerBuiltinProviders();
        }
        return SkillRegistry.instance;
    }

    private registerBuiltinProviders(): void {
        SoulRegistry.initialize();
        this.registerSkillProvider('soul', new SoulSkillProvider());
    }

    registerSkillProvider(bundleName: string, provider: SkillProvider) {
        // 同名覆盖（如 Staff agent 重建后 reassert）时丢弃旧 provider 的缓存结果
        this.providerSkillsCache.delete(bundleName);
        this.providers.set(bundleName, provider);
    }

    unregisterSkillProvider(bundleName: string, provider?: SkillProvider): void {
        if (provider !== undefined && this.providers.get(bundleName) !== provider) return;
        this.providers.delete(bundleName);
        this.clearCache(bundleName);
    }

    getSkillProvider(bundleName: string): SkillProvider | undefined {
        // 应用被插件禁用时整组技能不可用：provider 视为不存在，所有依赖它的查找都会失败
        if (!this.isProviderEnabled(bundleName)) return undefined;
        return this.providers.get(bundleName);
    }

    /**
     * 从缓存中同步获取已加载的 Skill
     * @param bundleName - 应用标识
     * @param skillName - 技能名称
     * @returns 缓存中的 Skill，如果未缓存则返回 undefined
     */
    getCachedSkill(bundleName: string, skillName: string): Skill | undefined {
        if (!this.isProviderEnabled(bundleName)) return undefined;
        const bundleCache = this.skillCache.get(bundleName);
        if (!bundleCache) {
            return undefined;
        }
        return bundleCache.get(skillName);
    }

    /**
     * 将 Skill 添加到缓存中
     * @param bundleName - 应用标识
     * @param skill - 要缓存的 Skill
     */
    cacheSkill(bundleName: string, skill: Skill): void {
        let bundleCache = this.skillCache.get(bundleName);
        if (!bundleCache) {
            bundleCache = new Map();
            this.skillCache.set(bundleName, bundleCache);
        }
        bundleCache.set(skill.frontmatter.name, skill);
    }

    /**
     * 清除指定应用的 Skill 缓存
     * @param bundleName - 应用标识，如果不提供则清除所有缓存
     */
    clearCache(bundleName?: string): void {
        if (bundleName) {
            this.skillCache.delete(bundleName);
            this.providerSkillsCache.delete(bundleName);
        } else {
            this.skillCache.clear();
            this.providerSkillsCache.clear();
        }
    }

    /**
     * 获取 provider 的技能列表（带缓存）。失败结果不缓存，下次调用重试。
     */
    private loadProviderSkills(bundleName: string, provider: SkillProvider): Promise<Skill[]> {
        let cached = this.providerSkillsCache.get(bundleName);
        if (!cached) {
            cached = provider.getSkills().catch((err) => {
                this.providerSkillsCache.delete(bundleName);
                throw err;
            });
            this.providerSkillsCache.set(bundleName, cached);
        }
        return cached;
    }

    async getAvailableSkills(agentId?: string): Promise<Map<string, Skill[]>> {
        const result: Map<string, Skill[]> = new Map();
        for (const [bundleName, provider] of this.providers) {
            // 被插件禁用的应用整组技能直接跳过：连 getSkills 都不调用，避免残留注册与副作用
            if (!this.isProviderEnabled(bundleName)) continue;
            try {
                const allSkills = await this.loadProviderSkills(bundleName, provider);
                // 缓存全部技能（包括禁用的，确保 LoadSkill/CallSkill 可查找）
                for (const skill of allSkills) {
                    this.cacheSkill(bundleName, skill);
                }
                // 只返回启用的技能
                const enabledSkills = allSkills.filter(
                    (skill) =>
                        this.isSkillEnabled(bundleName, skill.frontmatter.name) && isSkillExposedToAgent(skill, agentId)
                );
                result.set(bundleName, enabledSkills);
            } catch (err) {
                logger.error(`获取技能失败: ${err}`);
            }
        }
        return result;
    }

    /**
     * 获取所有技能（不过滤），供 UI 等需要展示全部技能（含禁用）的场景使用。
     */
    async getAllSkillsRaw(): Promise<Map<string, Skill[]>> {
        const result: Map<string, Skill[]> = new Map();
        for (const [bundleName, provider] of this.providers) {
            // 被插件禁用的应用整组技能直接跳过：连 getSkills 都不调用，避免残留注册与副作用
            if (!this.isProviderEnabled(bundleName)) continue;
            try {
                const skills = await this.loadProviderSkills(bundleName, provider);
                result.set(bundleName, skills);
            } catch (err) {
                logger.error(`获取技能失败: ${err}`);
            }
        }
        return result;
    }

    async getSkillFrontmatterXml(exposure?: TaskSkillExposure, agentId?: string): Promise<string> {
        const shouldExposeSkill = createSkillFrontmatterExposureMatcher(exposure);
        let result = '<available_skills>\n';
        for (const [bundleName, provider] of this.providers) {
            // 被插件禁用的应用整组技能直接跳过：连 getSkills 都不调用，避免残留注册与副作用
            if (!this.isProviderEnabled(bundleName)) continue;
            const skills = await this.loadProviderSkills(bundleName, provider);
            for (const skill of skills) {
                // disable-model-invocation=true 的 Skill 不向 LLM 暴露描述
                if (!skill.isModelInvocable) continue;
                // 禁用的技能不向 LLM 暴露
                if (!this.isSkillEnabled(bundleName, skill.frontmatter.name)) continue;
                if (!isSkillExposedToAgent(skill, agentId)) continue;
                if (!shouldExposeSkill(skill)) continue;
                result += format(SKILL_FRONTMATTER_XML, {
                    bundleName: bundleName,
                    skillName: skill.frontmatter.name,
                    skillDirectory: skill.directory || '该Skill不存在文件系统中',
                    description: skill.frontmatter.description
                });
            }
        }
        result += '</available_skills>';
        return result;
    }

    /**
     * 获取所有 user-invocable 的 Skill 列表（供 / 菜单和自动补全使用）
     */
    async getUserInvocableSkills(agentId?: string): Promise<{ bundleName: string; skill: Skill }[]> {
        const result: { bundleName: string; skill: Skill }[] = [];
        for (const [bundleName, provider] of this.providers) {
            // 被插件禁用的应用整组技能直接跳过：连 getSkills 都不调用，避免残留注册与副作用
            if (!this.isProviderEnabled(bundleName)) continue;
            try {
                const skills = await this.loadProviderSkills(bundleName, provider);
                for (const skill of skills) {
                    if (
                        skill.isUserInvocable &&
                        this.isSkillEnabled(bundleName, skill.frontmatter.name) &&
                        isSkillExposedToAgent(skill, agentId)
                    ) {
                        result.push({ bundleName, skill });
                    }
                }
            } catch (err) {
                logger.error(`获取 user-invocable 技能失败: ${err}`);
            }
        }
        return result;
    }

    /**
     * 获取所有 Skill（含 bundleName），平坦列表
     */
    async getAllSkillsFlat(agentId?: string): Promise<{ bundleName: string; skill: Skill }[]> {
        const result: { bundleName: string; skill: Skill }[] = [];
        for (const [bundleName, provider] of this.providers) {
            // 被插件禁用的应用整组技能直接跳过：连 getSkills 都不调用，避免残留注册与副作用
            if (!this.isProviderEnabled(bundleName)) continue;
            try {
                const skills = await this.loadProviderSkills(bundleName, provider);
                for (const skill of skills) {
                    if (
                        this.isSkillEnabled(bundleName, skill.frontmatter.name) &&
                        isSkillExposedToAgent(skill, agentId)
                    ) {
                        result.push({ bundleName, skill });
                    }
                }
            } catch (err) {
                logger.error(`获取技能失败: ${err}`);
            }
        }
        return result;
    }

    async getSkill(bundleName: string, skillName: string): Promise<Skill | undefined> {
        // 先检查过滤状态
        if (!this.isSkillEnabled(bundleName, skillName)) {
            return undefined;
        }

        // 先检查缓存
        const cachedSkill = this.getCachedSkill(bundleName, skillName);
        if (cachedSkill) {
            return cachedSkill;
        }

        const provider = this.providers.get(bundleName);
        if (!provider) {
            return undefined;
        }

        const skills = await this.loadProviderSkills(bundleName, provider);
        const skill = skills.find((skill) => skill.frontmatter.name === skillName);
        if (skill) {
            // 缓存找到的 Skill
            this.cacheSkill(bundleName, skill);
        }
        return skill;
    }

    async getSkillForAgent(bundleName: string, skillName: string, agentId?: string): Promise<Skill | undefined> {
        const skill = await this.getSkill(bundleName, skillName);
        return skill && isSkillExposedToAgent(skill, agentId) ? skill : undefined;
    }

    async loadSkillForAgent(
        bundleName: string,
        skillName: string,
        agentId?: string,
        hooks: Hooks = GlobalHooks
    ): Promise<LoadedSkillResult | undefined> {
        const skill = await this.getSkillForAgent(bundleName, skillName, agentId);
        if (!skill) return undefined;

        const ctx: SkillLoadContext = {
            bundleName,
            skillName,
            skillDirectory: skill.directory,
            source: skill.attribution ? 'plugin' : skill.directory ? 'installed' : 'builtin',
            frontmatter: { ...skill.frontmatter }
        };
        try {
            const decision = await hooks.checkBeforeSkillLoad(ctx);
            if (decision.operation === 'deny') {
                throw new SkillLoadBlockedError(bundleName, skillName, decision.message);
            }
        } catch (error) {
            if (error instanceof SkillLoadBlockedError) throw error;
            throw new SkillLoadBlockedError(
                bundleName,
                skillName,
                error instanceof Error ? error.message : String(error)
            );
        }

        // 动态 toolsets（如 skill 内部挂载的 MCP）只在真正加载时解析；
        // 解析失败不阻断 skill 加载，此时 skill 正文仍可见、只是缺少内部工具
        if (skill.toolsetResolver) {
            try {
                skill.toolsets = await skill.toolsetResolver();
            } catch (error) {
                logger.error(`Skill toolset resolver failed: ${bundleName}/${skillName}`, error);
            }
        }

        const content = skill.getFullContent();
        try {
            await hooks.noticeAfterSkillLoad(ctx);
        } catch (error) {
            logger.error(`Hooks.noticeAfterSkillLoad failed: ${bundleName}/${skillName}`, error);
        }
        return { skill, content };
    }

    getToolset(): BaseToolset {
        const toolset = new BaseToolset('skill-manager');
        toolset.addTool(new LoadSkillTool());
        toolset.addTool(new CallSkillTool());
        return toolset;
    }
}

// ─── afterToolcallParse 钩子注册 ──────────────────────────────────────────────

function isArgsObjectEmpty(args: unknown): boolean {
    if (args === undefined || args === null || args === '') return true;
    if (typeof args === 'object' && !Array.isArray(args) && Object.keys(args as object).length === 0) return true;
    return false;
}

/**
 * 注册全局 afterToolcallParse 钩子：
 * 1. 基础 JSON 合法性检查：args_string 非空但解析失败（args_object 为 undefined）时拒绝；
 * 2. CallSkillTool 专项：工具名后缀为 CallSkillTool 且 args_object 为空时拒绝，
 *    因为 LLM 经常在有效工具调用后紧跟一串空的 CallSkillTool 垃圾调用。
 */
function registerParseToolcallValidationHooks(): void {
    GlobalHooks.afterToolcallParse(async ({ toolCall }) => {
        const raw = toolCall.args_string || '';
        if (raw.trim().length > 0 && toolCall.args_object === undefined) {
            return {
                operation: 'reject',
                message: `args_string is not valid JSON: ${raw.substring(0, 200)}`
            };
        }
        return { operation: 'finish' };
    });

    GlobalHooks.afterToolcallParse(async ({ toolCall }) => {
        if (!toolCall.tool_name || !toolCall.tool_name.endsWith('CallSkillTool')) {
            return { operation: 'finish' };
        }
        if (isArgsObjectEmpty(toolCall.args_object)) {
            return {
                operation: 'reject',
                message: `${toolCall.tool_name} has empty args`
            };
        }
        return { operation: 'finish' };
    });
}

registerParseToolcallValidationHooks();
