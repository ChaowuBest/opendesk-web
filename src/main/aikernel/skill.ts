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
import { BaseToolset, BaseTool, ToolResult } from './tool';
import { z } from 'zod';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
import { jsonrepair } from 'jsonrepair';
import format from 'string-template';
import { ToolCall } from './messages';
import chalk from 'chalk';
import { statusDisplay } from '../tui/components/toolcall';
import { escapeHtml } from '../utils/escape';
import type { TaskState } from './states/tasks';
import type { PermissionRequest } from './security/permission';
import { SoulSkillProvider } from './soul/skills';
import { SoulRegistry } from './soul/registry';

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

/**
 * Skill 类表示一个 Agent Skill
 */
export class Skill {
    frontmatter: SkillFrontmatter;
    body: string;
    directory?: string;
    toolsets?: BaseToolset[];
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
        let result = this.body;
        if (!this.toolsets) {
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
                    parameters: JSON.stringify(tool.params.toJSONSchema())
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
        Skill.validateName(frontmatter.name);
        Skill.validateDescription(frontmatter.description);
        if (frontmatter.compatibility != null) {
            const comp = String(frontmatter.compatibility);
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
        super('LoadSkill', '读取指定技能(Skill)的内容', LoadSkillSchema);
        this.setExecutor(this.loadSkill.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof LoadSkillSchema>): PermissionRequest[] {
        const resourcePath = `${args.bundleName}/${args.skillName}`;
        if (/[\r\n\x00-\x1f\u2028\u2029]/.test(resourcePath)) return [];
        return [{ resourceType: 'skill', action: 'read', resourcePath }];
    }

    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const args = toolcall.args_object as z.output<typeof LoadSkillSchema> | undefined;
        const skillName = args ? `${args.bundleName}/${args.skillName}` : '';

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const detailHtml = skillName
            ? `<span class="truncate text-xs text-slate-600">${escapeHtml(skillName)}</span>`
            : '';

        return `<div class="my-2">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-book shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">加载技能</span>
                ${statusIcon}
                ${detailHtml}
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

        // 构建标题行
        const title = `${bundleName}/${skillName}`;

        // 根据状态显示不同的卡片
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
        const skill = await SkillRegistry.getInstance().getSkill(args.bundleName, args.skillName);
        if (!skill) {
            return '未找到该Skill';
        } else {
            // 将 skill 的 .env 环境变量合并到当前 task 的 harnessContext.environ
            if (taskState && skill.env && Object.keys(skill.env).length > 0) {
                Object.assign(taskState.harnessContext.environ, skill.env);
                logger.info(
                    `skill ${args.skillName} env merged to task harnessContext.environ: ${Object.keys(skill.env).join(', ')}`
                );
            }

            const fullContent = skill.getFullContent();
            logger.info(`skill ${args.bundleName} ${args.skillName} 的完整内容是:\n` + fullContent);
            return fullContent;
        }
    }
}

const CallSkillToolSchema = z.object({
    bundleName: z.string().describe('要调用的Skill内置工具所属的应用名(bundleName)'),
    skillName: z.string().describe('要调用的Skill的名称'),
    toolName: z.string().describe('要调用的工具名称'),
    toolArgs: z.unknown().describe('要传递给工具的参数, 该参数是一个object, 应该遵循被调用的工具给出的Schema')
});

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

class CallSkillTool extends BaseTool<typeof CallSkillToolSchema> {
    constructor() {
        super('CallSkillTool', '调用Skill提供的内部工具', CallSkillToolSchema);
        this.setUniversalExecutor(this.callSkillToolUniversal.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof CallSkillToolSchema>): PermissionRequest[] {
        // 委托给内部工具的权限声明
        const cachedSkill = SkillRegistry.getInstance().getCachedSkill(args.bundleName, args.skillName);
        if (cachedSkill) {
            const innerTool = cachedSkill.getTool(args.toolName);
            if (innerTool) {
                let parsedToolArgs: object;
                try {
                    if (typeof args.toolArgs === 'object') parsedToolArgs = args.toolArgs;
                    else if (typeof args.toolArgs === 'string') parsedToolArgs = JSON.parse(jsonrepair(args.toolArgs));
                    else parsedToolArgs = {};
                } catch {
                    parsedToolArgs = {};
                }
                const innerPerms = innerTool.getDeclaredPermissions(parsedToolArgs);
                if (innerPerms.length > 0) {
                    return innerPerms;
                }
            }
        }
        return [];
    }

    /**
     * 渲染 CallSkillTool 工具调用的 Electron HTML 界面
     * 优先使用内部工具的自定义渲染，否则展示统一的技能调用卡片
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        const inner = this.resolveInnerTool(toolcall);
        if (inner) {
            const result = await inner.tool.renderToolCall(inner.toolCall);
            if (result) return result;
        }

        const args = toolcall.args_object as z.output<typeof CallSkillToolSchema> | undefined;
        const skillName = args ? `${args.bundleName}/${args.skillName}` : '';
        const toolName = args?.toolName || '';

        const statusIcon =
            toolcall.status === 'running'
                ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
                : toolcall.status === 'error'
                  ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
                  : '';

        const detailParts: string[] = [];
        if (skillName) detailParts.push(escapeHtml(skillName));
        if (toolName) detailParts.push(escapeHtml(toolName));
        const detailHtml =
            detailParts.length > 0
                ? `<span class="truncate text-xs text-slate-600">${detailParts.join(' / ')}</span>`
                : '';

        return `<div class="my-2">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-bolt shrink-0 text-slate-400 text-xs"></i>
                <span class="shrink-0 text-slate-500 text-xs">调用技能</span>
                ${statusIcon}
                ${detailHtml}
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
            if (typeof args.toolArgs === 'object') parsedToolArgs = args.toolArgs;
            else if (typeof args.toolArgs === 'string') parsedToolArgs = JSON.parse(jsonrepair(args.toolArgs));
            else parsedToolArgs = {};
        } catch {
            parsedToolArgs = {};
        }

        const innerToolCall = createInnerToolCall(args.toolName, parsedToolArgs, innerTool, toolcall);
        return { tool: innerTool, toolCall: innerToolCall };
    }

    /**
     * 渲染默认的技能工具调用卡片
     */
    private renderDefaultCard(
        toolcall: ToolCall,
        width: number,
        bundleName: string,
        skillName: string,
        toolName: string
    ): string[] {
        const { icon } = statusDisplay(toolcall.status);

        const skillPath = bundleName && skillName ? `${bundleName}/${skillName}` : '未知技能';
        const tool = toolName || '未知工具';

        const accentColor =
            toolcall.status === 'error'
                ? chalk.red
                : toolcall.status === 'success'
                  ? chalk.green
                  : toolcall.status === 'running'
                    ? chalk.blue
                    : chalk.dim;

        const header = `  ${icon} ${chalk.magenta('⚡')} ${accentColor.bold(tool)} ${chalk.dim('·')} ${chalk.dim(skillPath)}`;

        if (toolcall.status === 'running') {
            return [header + ' ' + chalk.dim('执行中...')];
        } else if (toolcall.status === 'success') {
            return [header + ' ' + chalk.dim('完成')];
        } else if (toolcall.status === 'error') {
            return [header + ' ' + chalk.red('失败')];
        } else {
            return [header];
        }
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
        const skill = await SkillRegistry.getInstance().getSkill(args.bundleName, args.skillName);
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
            let toolArgs: object;
            if (typeof args.toolArgs == 'object') {
                toolArgs = args.toolArgs;
            } else if (typeof args.toolArgs == 'string') {
                toolArgs = JSON.parse(jsonrepair(args.toolArgs));
            } else {
                parentResult.updateResult('错误: toolArgs的类型无法解析');
                return;
            }

            logger.info(`call skill tool ${args.toolName} with ${JSON.stringify(args.toolArgs)}`);

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
        }
    }
}

interface SkillProvider {
    getSkills(): Promise<Skill[]>;
}

export class SkillRegistry {
    static instance: SkillRegistry | null = null;

    providers: Map<string, SkillProvider> = new Map();

    /** Skill 缓存，用于同步获取已加载的 Skill */
    private skillCache: Map<string, Map<string, Skill>> = new Map();

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
        this.providers.set(bundleName, provider);
    }

    getSkillProvider(bundleName: string): SkillProvider | undefined {
        return this.providers.get(bundleName);
    }

    /**
     * 从缓存中同步获取已加载的 Skill
     * @param bundleName - 应用标识
     * @param skillName - 技能名称
     * @returns 缓存中的 Skill，如果未缓存则返回 undefined
     */
    getCachedSkill(bundleName: string, skillName: string): Skill | undefined {
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
        } else {
            this.skillCache.clear();
        }
    }

    async getAvailableSkills(): Promise<Map<string, Skill[]>> {
        const result: Map<string, Skill[]> = new Map();
        for (const [bundleName, provider] of this.providers) {
            try {
                const skills = await provider.getSkills();
                result.set(bundleName, skills);
                // 更新缓存
                for (const skill of skills) {
                    this.cacheSkill(bundleName, skill);
                }
            } catch (err) {
                logger.error(`获取技能失败: ${err}`);
            }
        }
        return result;
    }

    async getSkillFrontmatterXml(): Promise<string> {
        let result = '<available_skills>\n';
        for (const [bundleName, provider] of this.providers) {
            const skills = await provider.getSkills();
            for (const skill of skills) {
                // disable-model-invocation=true 的 Skill 不向 LLM 暴露描述
                if (!skill.isModelInvocable) continue;
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
    async getUserInvocableSkills(): Promise<{ bundleName: string; skill: Skill }[]> {
        const result: { bundleName: string; skill: Skill }[] = [];
        for (const [bundleName, provider] of this.providers) {
            try {
                const skills = await provider.getSkills();
                for (const skill of skills) {
                    if (skill.isUserInvocable) {
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
    async getAllSkillsFlat(): Promise<{ bundleName: string; skill: Skill }[]> {
        const result: { bundleName: string; skill: Skill }[] = [];
        for (const [bundleName, provider] of this.providers) {
            try {
                const skills = await provider.getSkills();
                for (const skill of skills) {
                    result.push({ bundleName, skill });
                }
            } catch (err) {
                logger.error(`获取技能失败: ${err}`);
            }
        }
        return result;
    }

    async getSkill(bundleName: string, skillName: string): Promise<Skill | undefined> {
        // 先检查缓存
        const cachedSkill = this.getCachedSkill(bundleName, skillName);
        if (cachedSkill) {
            return cachedSkill;
        }

        const provider = this.providers.get(bundleName);
        if (!provider) {
            return undefined;
        }

        const skills = await provider.getSkills();
        const skill = skills.find((skill) => skill.frontmatter.name === skillName);
        if (skill) {
            // 缓存找到的 Skill
            this.cacheSkill(bundleName, skill);
        }
        return skill;
    }

    getToolset(): BaseToolset {
        const toolset = new BaseToolset('skill-manager');
        toolset.addTool(new LoadSkillTool());
        toolset.addTool(new CallSkillTool());
        return toolset;
    }
}
