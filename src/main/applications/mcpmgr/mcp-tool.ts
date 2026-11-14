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

import { BaseTool, type ToolArgsValidationResult } from '../../aikernel/tool.js';
import { ToolCall } from '../../aikernel/messages.js';
import { Card } from '../../tui/components/card.js';
import { statusDisplay, truncText } from '../../tui/components/toolcall.js';
import { escapeHtml } from '../../../common/utils/escape.js';
import chalk from 'chalk';
import { z } from 'zod';
import { t } from './locale/index.js';

const MCP_DESCRIPTION_MAX_CHARS = 80;
const SCHEMA_COMPOSITION_KEYS = ['allOf', 'anyOf', 'oneOf'] as const;

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveLocalSchemaRef(root: Record<string, any>, ref: string): Record<string, any> | undefined {
    if (!ref.startsWith('#/')) return undefined;
    let current: unknown = root;
    for (const encodedPart of ref.slice(2).split('/')) {
        if (!isRecord(current)) return undefined;
        const part = encodedPart.replace(/~1/g, '/').replace(/~0/g, '~');
        current = current[part];
    }
    return isRecord(current) ? current : undefined;
}

function schemaDefinesDescription(
    schema: Record<string, any>,
    root: Record<string, any>,
    seen = new Set<Record<string, any>>()
): boolean {
    if (seen.has(schema)) return false;
    seen.add(schema);
    if (isRecord(schema.properties) && Object.hasOwn(schema.properties, 'description')) return true;
    if (Array.isArray(schema.required) && schema.required.includes('description')) return true;
    if (typeof schema.$ref === 'string') {
        const referenced = resolveLocalSchemaRef(root, schema.$ref);
        if (referenced && schemaDefinesDescription(referenced, root, seen)) return true;
    }
    for (const key of SCHEMA_COMPOSITION_KEYS) {
        const branches = schema[key];
        if (
            Array.isArray(branches) &&
            branches.some((branch) => isRecord(branch) && schemaDefinesDescription(branch, root, seen))
        ) {
            return true;
        }
    }
    for (const key of ['then', 'else'] as const) {
        const branch = schema[key];
        if (isRecord(branch) && schemaDefinesDescription(branch, root, seen)) return true;
    }
    if (isRecord(schema.dependentSchemas)) {
        for (const branch of Object.values(schema.dependentSchemas)) {
            if (isRecord(branch) && schemaDefinesDescription(branch, root, seen)) return true;
        }
    }
    return false;
}

function schemaRejectsExtraDescription(
    schema: Record<string, any>,
    root: Record<string, any>,
    seen = new Set<Record<string, any>>()
): boolean {
    if (seen.has(schema)) return false;
    seen.add(schema);
    if (schema.additionalProperties === false || schema.unevaluatedProperties === false) return true;
    if (typeof schema.$ref === 'string') {
        const referenced = resolveLocalSchemaRef(root, schema.$ref);
        if (referenced && schemaRejectsExtraDescription(referenced, root, seen)) return true;
    }
    for (const key of SCHEMA_COMPOSITION_KEYS) {
        const branches = schema[key];
        if (
            Array.isArray(branches) &&
            branches.some((branch) => isRecord(branch) && schemaRejectsExtraDescription(branch, root, seen))
        ) {
            return true;
        }
    }
    for (const key of ['if', 'then', 'else'] as const) {
        const branch = schema[key];
        if (isRecord(branch) && schemaRejectsExtraDescription(branch, root, seen)) return true;
    }
    if (isRecord(schema.dependentSchemas)) {
        for (const branch of Object.values(schema.dependentSchemas)) {
            if (isRecord(branch) && schemaRejectsExtraDescription(branch, root, seen)) return true;
        }
    }
    return false;
}

function addDescriptionToClosedSchemaBranches(
    schema: Record<string, any>,
    root: Record<string, any>,
    descriptionSchema: Record<string, string>,
    isRoot = false,
    seen = new Set<Record<string, any>>()
): void {
    if (seen.has(schema)) return;
    seen.add(schema);
    if (isRoot || schema.additionalProperties === false) {
        schema.type ??= 'object';
        schema.properties = {
            ...(isRecord(schema.properties) ? schema.properties : {}),
            description: descriptionSchema
        };
        if (isRoot) {
            const required = Array.isArray(schema.required) ? schema.required : [];
            schema.required = required.includes('description') ? required : [...required, 'description'];
        }
    }
    if (typeof schema.$ref === 'string') {
        const referenced = resolveLocalSchemaRef(root, schema.$ref);
        if (referenced) addDescriptionToClosedSchemaBranches(referenced, root, descriptionSchema, false, seen);
    }
    for (const key of SCHEMA_COMPOSITION_KEYS) {
        const branches = schema[key];
        if (!Array.isArray(branches)) continue;
        for (const branch of branches) {
            if (isRecord(branch)) addDescriptionToClosedSchemaBranches(branch, root, descriptionSchema, false, seen);
        }
    }
    for (const key of ['then', 'else'] as const) {
        const branch = schema[key];
        if (isRecord(branch)) addDescriptionToClosedSchemaBranches(branch, root, descriptionSchema, false, seen);
    }
    if (isRecord(schema.dependentSchemas)) {
        for (const branch of Object.values(schema.dependentSchemas)) {
            if (isRecord(branch)) addDescriptionToClosedSchemaBranches(branch, root, descriptionSchema, false, seen);
        }
    }
}

function prepareInputSchema(inputSchema: object): {
    original: Record<string, any>;
    exposed: Record<string, any>;
    hasInjectedDescription: boolean;
} {
    const original = structuredClone(isRecord(inputSchema) ? inputSchema : {});
    const hasInjectedDescription = !schemaDefinesDescription(original, original);
    if (!hasInjectedDescription) return { original, exposed: original, hasInjectedDescription };
    const exposed = structuredClone(original);
    const descriptionSchema = {
        type: 'string',
        description: t('tool.purpose.description')
    };
    addDescriptionToClosedSchemaBranches(exposed, exposed, descriptionSchema, true);
    return {
        original,
        exposed,
        hasInjectedDescription
    };
}

function displayDescription(value: unknown, fullName: string): string {
    if (typeof value !== 'string') return fullName;
    const text = value.trim();
    if (!text) return fullName;
    const chars = Array.from(text);
    return chars.length > MCP_DESCRIPTION_MAX_CHARS
        ? `${chars.slice(0, MCP_DESCRIPTION_MAX_CHARS - 1).join('')}…`
        : text;
}

export function renderMcpToolCall(toolcall: ToolCall, fullName: string): string {
    const displayPurpose = displayDescription(toolcall.args_object?.['description'], fullName);
    const statusIcon =
        toolcall.status === 'running'
            ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>'
            : toolcall.status === 'error'
              ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-rose-500"></span>'
              : '';
    const errorContent =
        toolcall.status === 'error' && toolcall.result
            ? `<div class="text-xs text-rose-600 bg-rose-50 px-3 py-2 rounded break-all mt-0.5">${escapeHtml(toolcall.result)}</div>`
            : '';

    return `<div class="od-inline-toolcall-container" title="${escapeHtml(fullName)}">
        <div class="flex flex-col min-w-0">
            <div class="flex items-center gap-1.5 min-w-0">
                <i class="fas fa-plug shrink-0 text-blue-400 text-xs"></i>
                <span class="shrink-0 text-xs text-slate-600 font-medium">${escapeHtml(t('tool.label'))}</span>
                <span class="text-xs text-slate-500 truncate min-w-0">${escapeHtml(displayPurpose)}</span>
                ${statusIcon}
            </div>
            ${errorContent}
        </div>
    </div>`;
}

/**
 * MCP 工具模型可见名的净化规则：`<namespace>__<tool>` 的两段都经此净化。
 * 与 MCPTool 的命名约定强绑定，插件全局 MCP 与技能内部 MCP 的工具集组装共用。
 */
export function mcpSafeName(value: string): string {
    return value.replace(/[^a-zA-Z0-9_]/g, '_');
}

/** MCP 工具类，保留服务端参数，同时提供调用目的和专门的渲染逻辑。 */
export class MCPTool extends BaseTool<z.ZodType<Record<string, unknown>>> {
    private serverName: string;
    private originalToolName: string;
    private readonly exposedSchema: Record<string, any>;
    private readonly originalRejectsExtraDescription: boolean;
    readonly hasInjectedDescription: boolean;

    constructor(
        serverName: string,
        toolName: string,
        description: string,
        inputSchema: object,
        agentIds?: readonly string[],
        toolNamespace = serverName,
        modelToolName = toolName
    ) {
        // 工具名格式：serverName__toolName（去掉 mcpmgr 前缀）
        const safeName = `${mcpSafeName(toolNamespace)}__${modelToolName}`;
        const prepared = prepareInputSchema(inputSchema);
        let params: z.ZodType<Record<string, unknown>>;
        try {
            params = z.fromJSONSchema(prepared.original as any) as z.ZodType<Record<string, unknown>>;
        } catch {
            params = z.object({}).passthrough();
        }
        super(safeName, `[MCP: ${serverName}] ${description}`, params);

        this.serverName = serverName;
        this.originalToolName = toolName;
        this.exposedSchema = prepared.exposed;
        this.originalRejectsExtraDescription = schemaRejectsExtraDescription(prepared.original, prepared.original);
        this.hasInjectedDescription = prepared.hasInjectedDescription;
        this.agentIds = agentIds;
        this.renderToolCallOnError = true;
    }

    getJsonSchema(): Record<string, any> {
        return this.exposedSchema;
    }

    validateArgs(args: unknown): ToolArgsValidationResult<z.ZodType<Record<string, unknown>>> {
        if (!this.hasInjectedDescription || !isRecord(args)) return super.validateArgs(args);
        const hasDisplayDescription = Object.hasOwn(args, 'description');
        const displayDescription = args.description;
        const originalArgs = { ...args };
        delete originalArgs.description;
        const validation = super.validateArgs(originalArgs);
        if (!validation.success || !hasDisplayDescription) return validation;
        return {
            success: true,
            data: {
                ...validation.data,
                description: displayDescription
            }
        };
    }

    protected prepareArgsForExecution(args: Record<string, unknown>): Record<string, unknown> {
        // 组合 schema 的闭合分支可能未被 Zod 完整校验，仍须遵守服务端原始约束。
        if (
            !this.hasInjectedDescription ||
            (!this.originalRejectsExtraDescription && super.validateArgs(args).success)
        ) {
            return args;
        }
        const executionArgs = { ...args };
        delete executionArgs.description;
        return executionArgs;
    }

    /**
     * 自定义的 GUI 工具调用渲染
     */
    async renderToolCall(toolcall: ToolCall): Promise<string | undefined> {
        return renderMcpToolCall(toolcall, `${this.serverName} · ${this.originalToolName}`);
    }

    /**
     * 自定义的 TUI 工具调用渲染
     */
    renderToolCallCli(toolcall: ToolCall, width: number): string[] | undefined {
        const body: string[] = [];
        const fullName = `${this.serverName} · ${this.originalToolName}`;
        const description = displayDescription(toolcall.args_object?.['description'], fullName);

        if (toolcall.status === 'running') {
            body.push(chalk.dim(`  ⏳ ${t('cli.tool.running')}`));
        } else if (toolcall.status === 'success') {
            body.push(chalk.dim(`  ✓ ${t('cli.tool.success')}`));
            if (toolcall.result) {
                const truncated = truncText(toolcall.result, width - 20);
                body.push(chalk.dim('  ') + chalk.gray(truncated));
            }
        } else if (toolcall.status === 'error' && toolcall.result) {
            body.push(chalk.redBright('  ' + truncText(toolcall.result, width - 10)));
        }

        return new Card({
            icon: '🔌',
            title: `${t('tool.label')} · ${truncText(description, Math.max(12, width - 24))}`,
            status: statusDisplay(toolcall.status),
            body
        }).render(width);
    }
}
