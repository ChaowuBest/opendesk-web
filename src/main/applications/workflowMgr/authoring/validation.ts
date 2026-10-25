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
 * 职责：解析并确定性校验 Authoring 产生的 Workflow Definition 与首次运行输入。
 */

import { parse } from 'acorn';

import { AssistantMessage, UserMessage } from '../../../aikernel/messages.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import {
    getRequiredWorkflowInputNames,
    type WorkflowDefinitionInput,
    type WorkflowJSONValue
} from '../../../aikernel/workflow.js';
import { collectDisallowedWorkflowAgentTools, isWorkflowAgentToolAllowed } from '../agent/policy.js';

const RESERVED_RUNTIME_IDENTIFIERS = new Set(['args', 'phase', 'agent', 'report']);
const WORKFLOW_SCRIPT_GLOBALS = new Set([
    ...RESERVED_RUNTIME_IDENTIFIERS,
    'AggregateError',
    'Array',
    'ArrayBuffer',
    'BigInt',
    'BigInt64Array',
    'BigUint64Array',
    'Boolean',
    'DataView',
    'Date',
    'Error',
    'EvalError',
    'FinalizationRegistry',
    'Float32Array',
    'Float64Array',
    'Infinity',
    'Int8Array',
    'Int16Array',
    'Int32Array',
    'Intl',
    'JSON',
    'Map',
    'Math',
    'NaN',
    'Number',
    'Object',
    'Promise',
    'Proxy',
    'RangeError',
    'ReferenceError',
    'Reflect',
    'RegExp',
    'Set',
    'String',
    'Symbol',
    'SyntaxError',
    'TypeError',
    'URIError',
    'Uint8Array',
    'Uint8ClampedArray',
    'Uint16Array',
    'Uint32Array',
    'WeakMap',
    'WeakRef',
    'WeakSet',
    'arguments',
    'decodeURI',
    'decodeURIComponent',
    'encodeURI',
    'encodeURIComponent',
    'isFinite',
    'isNaN',
    'parseFloat',
    'parseInt',
    'undefined'
]);
const FORBIDDEN_RUNTIME_IDENTIFIERS = new Set([
    'Buffer',
    'Function',
    'WebSocket',
    'XMLHttpRequest',
    'eval',
    'fetch',
    'globalThis',
    'process',
    'require'
]);
const AGENT_RESULT_FIELDS = new Set(['output', 'status', 'summary']);
export const AUTHOR_WORKFLOW_OUTPUT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    properties: {
        name: { type: 'string', minLength: 1 },
        description: { type: 'string', minLength: 1 },
        whenToUse: { type: 'string', minLength: 1 },
        phases: {
            type: 'array',
            minItems: 1,
            items: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1 },
                    description: { type: 'string' }
                },
                required: ['name'],
                additionalProperties: false
            }
        },
        inputSchema: { type: 'object' },
        launchInput: { type: 'object', additionalProperties: true },
        script: { type: 'string', minLength: 1 }
    },
    required: ['name', 'description', 'whenToUse', 'phases', 'inputSchema', 'script'],
    additionalProperties: false
};
type ScriptBindingKind = 'agent-result' | 'other';

interface ScriptNode {
    type: string;
    start: number;
    end: number;
    name?: string;
    value?: unknown;
    [key: string]: unknown;
}

export interface WorkflowToolCatalogEntry {
    name: string;
    description: string;
}

export interface ParsedAuthoredOutput {
    definition: WorkflowDefinitionInput;
    launchInput?: WorkflowJSONValue;
}

export interface WorkflowDefinitionValidationHost {
    collectDefinitionValidationErrors(
        definition: WorkflowDefinitionInput,
        options: { allowNameCollision: boolean }
    ): string[];
    validateInput(inputSchema: Record<string, unknown>, input: WorkflowJSONValue): unknown;
}

export class WorkflowAuthoringValidationError extends Error {
    constructor(readonly errors: string[]) {
        super(
            ['提交的 Workflow Definition 尚不可运行：', ...errors.map((error, index) => `${index + 1}. ${error}`)].join(
                '\n'
            )
        );
        this.name = 'WorkflowAuthoringValidationError';
    }
}

export function collectAuthoringErrors(
    output: ParsedAuthoredOutput,
    toolCatalog: readonly WorkflowToolCatalogEntry[],
    hostTask: TaskState,
    validator: WorkflowDefinitionValidationHost
): string[] {
    const errors = [
        ...validator.collectDefinitionValidationErrors(output.definition, {
            allowNameCollision: true
        }),
        ...collectAuthoredDefinitionErrors(output.definition, toolCatalog)
    ];
    if (output.launchInput !== undefined) {
        try {
            validator.validateInput(output.definition.inputSchema ?? {}, output.launchInput);
        } catch (error) {
            errors.push(...validationErrorMessages(error));
        }
        const unsupportedValues = collectUnsupportedLaunchInputValues(output.launchInput, hostTask);
        if (unsupportedValues.length > 0) {
            errors.push(
                `launchInput 包含宿主用户未提供的值：${unsupportedValues.join(
                    ', '
                )}。请省略 launchInput，并保持对应 inputSchema 字段为必填。`
            );
        }
    }
    return [...new Set(errors)];
}

export function validateAuthoredDefinition(
    input: WorkflowDefinitionInput,
    toolCatalog: readonly WorkflowToolCatalogEntry[] = []
): void {
    const errors = collectAuthoredDefinitionErrors(input, toolCatalog);
    if (errors.length > 0) {
        throw new WorkflowAuthoringValidationError(errors);
    }
}

export function collectAuthoredDefinitionErrors(
    input: WorkflowDefinitionInput,
    toolCatalog: readonly WorkflowToolCatalogEntry[] = []
): string[] {
    return [
        ...new Set([
            ...(input.inputSchema?.type === 'object'
                ? []
                : ['Workflow inputSchema 必须描述一个对象，使 RunWorkflow.input 具有稳定的字段契约。']),
            ...validateAuthoredScript(
                input.script,
                input.phases ?? [],
                toolCatalog,
                getRequiredWorkflowInputNames(input.inputSchema ?? {})
            )
        ])
    ];
}

function validateAuthoredScript(
    source: string,
    phases: Array<{ name: string; description?: string }>,
    toolCatalog: readonly WorkflowToolCatalogEntry[],
    requiredInputNames: readonly string[]
): string[] {
    let root: ScriptNode;
    try {
        root = parse(`async function workflowMain() {\n${source}\n}`, {
            ecmaVersion: 'latest',
            sourceType: 'script'
        }) as unknown as ScriptNode;
    } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
    }

    const errors: string[] = [];
    const phaseCalls: string[] = [];
    let reportCallCount = 0;
    const workflowMain = ((root.body as ScriptNode[] | undefined) ?? [])[0];
    const workflowStatements =
        workflowMain?.type === 'FunctionDeclaration'
            ? (((workflowMain.body as ScriptNode | undefined)?.body as ScriptNode[] | undefined) ?? [])
            : [];
    if (
        !workflowStatements.some(
            (statement) =>
                statement.type !== 'FunctionDeclaration' &&
                statement.type !== 'ClassDeclaration' &&
                statement.type !== 'EmptyStatement'
        )
    ) {
        errors.push('Workflow 脚本必须在 async 函数体中直接包含可执行语句；只有声明不会启动 Workflow。');
    }
    const bindingsByScope = collectScriptBindings(root);
    const declaredIdentifierNodes = collectDeclaredIdentifierNodes(root);
    const undefinedIdentifiers = new Set<string>();
    const requiredInputs = new Set(requiredInputNames);

    walkScript(root, [], (node, ancestors) => {
        if (isBindingNode(node)) {
            for (const name of bindingNames(bindingPattern(node))) {
                if (RESERVED_RUNTIME_IDENTIFIERS.has(name)) {
                    errors.push(`Runtime 标识符“${name}”不能被声明、赋值或遮蔽。`);
                }
            }
        }

        if (node.type === 'Identifier' && node.name && FORBIDDEN_RUNTIME_IDENTIFIERS.has(node.name)) {
            errors.push(`Workflow 脚本中不能使用 Runtime 标识符“${node.name}”。`);
        }
        if (
            node.type === 'Identifier' &&
            node.name &&
            !FORBIDDEN_RUNTIME_IDENTIFIERS.has(node.name) &&
            isIdentifierReference(node, ancestors, declaredIdentifierNodes) &&
            !WORKFLOW_SCRIPT_GLOBALS.has(node.name) &&
            !resolvesToBinding(node.name, ancestors, bindingsByScope)
        ) {
            undefinedIdentifiers.add(node.name);
        }
        if (
            node.type === 'LogicalExpression' &&
            (node.operator === '||' || node.operator === '??') &&
            isStaticFallbackValue(node.right as ScriptNode | undefined)
        ) {
            const inputName = directArgsPropertyName(node.left as ScriptNode | undefined);
            if (inputName && requiredInputs.has(inputName)) {
                errors.push(`必填输入“${inputName}”必须直接从 args 读取，不能使用字面量默认值。`);
            }
        }

        if (node.type !== 'CallExpression') {
            return;
        }
        const callee = node.callee as ScriptNode | undefined;
        const name = callee?.type === 'Identifier' ? callee.name : undefined;
        if (!name || !RESERVED_RUNTIME_IDENTIFIERS.has(name)) {
            return;
        }
        if (!isAwaited(node, ancestors)) {
            errors.push(`${name}(...) 必须使用 await。`);
        }
        const args = (node.arguments as ScriptNode[] | undefined) ?? [];
        if (name === 'phase') {
            if (args.length !== 1) {
                errors.push('phase(...) 只接收一个字符串参数，不接收回调函数。');
            }
            const phaseName = literalString(args[0]);
            if (!phaseName) {
                errors.push('phase(...) 必须使用非空字符串字面量，以便 run 预先构建阶段列表。');
            } else {
                phaseCalls.push(phaseName);
            }
        }
        if (name === 'agent' && (!args[0] || args[0].type === 'ObjectExpression')) {
            errors.push('agent() 的第一个位置参数必须是 prompt。');
        }
        if (name === 'agent') {
            errors.push(...validateAgentAllowedTools(args[1], toolCatalog));
        }
        if (name === 'report') {
            reportCallCount += 1;
        }
    });

    if (undefinedIdentifiers.size > 0) {
        errors.push(
            `Workflow 脚本引用了不可用的标识符：${[...undefinedIdentifiers].sort().join(', ')}。只能使用本地声明、标准 ECMAScript 内建对象或宿主全局变量 args、phase、agent、report；agent 工具名称只能出现在 allowedTools 中。`
        );
    }

    walkScript(root, [], (node, ancestors) => {
        if (node.type !== 'MemberExpression') {
            return;
        }
        const object = node.object as ScriptNode | undefined;
        if (
            object?.type !== 'Identifier' ||
            !object.name ||
            !resolvesToAgentResult(object.name, ancestors, bindingsByScope)
        ) {
            return;
        }
        const property = memberPropertyName(node);
        if (property && !AGENT_RESULT_FIELDS.has(property)) {
            errors.push(
                `Agent 结果“${object.name}”只包含 status、summary 和 output；领域字段“${property}”应从 ${object.name}.output 读取。`
            );
        }
    });

    const declaredPhases = phases.map((phase) => phase.name);
    if (!sameSequence(declaredPhases, phaseCalls)) {
        errors.push(
            `声明的 phases（${declaredPhases.join(' -> ') || '无'}）必须与 phase(...) 调用（${phaseCalls.join(' -> ') || '无'}）在顺序和数量上完全一致。`
        );
    }
    if (reportCallCount === 0) {
        errors.push('Workflow 脚本必须使用 await report(value) 发布最终 JSON-safe 结果。');
    }
    return errors;
}

function validateAgentAllowedTools(
    options: ScriptNode | undefined,
    toolCatalog: readonly WorkflowToolCatalogEntry[]
): string[] {
    if (!options) {
        return [];
    }
    if (options.type !== 'ObjectExpression') {
        return ['agent options 必须是对象字面量，以便在 Workflow 运行前校验 allowedTools。'];
    }
    const allowedToolsProperty = ((options.properties as ScriptNode[] | undefined) ?? []).find(
        (property) => property.type === 'Property' && objectPropertyName(property) === 'allowedTools'
    );
    if (!allowedToolsProperty) {
        return [];
    }
    const value = allowedToolsProperty.value as ScriptNode | undefined;
    const elements =
        value?.type === 'ArrayExpression' ? ((value.elements as ScriptNode[] | undefined) ?? []) : undefined;
    if (!elements || elements.some((element) => element.type !== 'Literal' || typeof element.value !== 'string')) {
        return ['agent allowedTools 必须是数组字面量，并使用可用工具目录中的准确名称。'];
    }
    const availableNames = new Set(toolCatalog.map((tool) => tool.name));
    const declaredNames = elements.map((element) => (element.value as string).trim());
    const disallowedNames = collectDisallowedWorkflowAgentTools(declaredNames);
    const unknownNames = [
        ...new Set(declaredNames.filter((name) => isWorkflowAgentToolAllowed(name) && !availableNames.has(name)))
    ];
    const errors: string[] = [];
    if (disallowedNames.length > 0) {
        errors.push(`Workflow agent 不能使用嵌套 Agent 或代码执行工具：${disallowedNames.join(', ')}。`);
    }
    if (unknownNames.length > 0) {
        const availableSummary =
            toolCatalog.length > 0 ? toolCatalog.map((tool) => tool.name).join(', ') : '（当前无可用工具）';
        errors.push(
            `agent allowedTools 包含不可用的工具名称：${unknownNames
                .map((name) => name || '（空）')
                .join(', ')}。只能使用：${availableSummary}。`
        );
    }
    return errors;
}

function walkScript(
    node: ScriptNode,
    ancestors: ScriptNode[],
    visitor: (node: ScriptNode, ancestors: ScriptNode[]) => void
): void {
    visitor(node, ancestors);
    const nextAncestors = [...ancestors, node];
    for (const [key, value] of Object.entries(node)) {
        if (key === 'start' || key === 'end' || key === 'loc' || key === 'range') {
            continue;
        }
        if (Array.isArray(value)) {
            for (const child of value) {
                if (isScriptNode(child)) {
                    walkScript(child, nextAncestors, visitor);
                }
            }
        } else if (isScriptNode(value)) {
            walkScript(value, nextAncestors, visitor);
        }
    }
}

function collectScriptBindings(root: ScriptNode): Map<ScriptNode, Map<string, ScriptBindingKind>> {
    const bindingsByScope = new Map<ScriptNode, Map<string, ScriptBindingKind>>();
    const bind = (scope: ScriptNode | undefined, names: string[], kind: ScriptBindingKind): void => {
        if (!scope) return;
        const bindings = bindingsByScope.get(scope) ?? new Map<string, ScriptBindingKind>();
        for (const name of names) {
            bindings.set(name, kind);
        }
        bindingsByScope.set(scope, bindings);
    };

    walkScript(root, [], (node, ancestors) => {
        if (node.type === 'VariableDeclarator') {
            const declaration = ancestors.at(-1);
            const functionScoped = declaration?.type === 'VariableDeclaration' && declaration.kind === 'var';
            const scope = findBindingScope(ancestors, functionScoped);
            const binding = node.id as ScriptNode | undefined;
            const initializer = unwrapAwait(node.init as ScriptNode | undefined);
            const agentResult =
                binding?.type === 'Identifier' && isRuntimeCall(initializer, 'agent') ? 'agent-result' : 'other';
            bind(scope, bindingNames(binding), agentResult);
            return;
        }
        if (
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression'
        ) {
            const identifier = node.id as ScriptNode | undefined;
            if (node.type === 'FunctionDeclaration') {
                bind(findBindingScope(ancestors, false), bindingNames(identifier), 'other');
            } else {
                bind(node, bindingNames(identifier), 'other');
            }
            bind(node, bindingNames((node.params as ScriptNode[] | undefined) ?? []), 'other');
            return;
        }
        if (node.type === 'ClassDeclaration') {
            bind(findBindingScope(ancestors, false), bindingNames(node.id as ScriptNode | undefined), 'other');
            return;
        }
        if (node.type === 'ClassExpression') {
            bind(node, bindingNames(node.id as ScriptNode | undefined), 'other');
            return;
        }
        if (node.type === 'CatchClause') {
            bind(node, bindingNames(node.param as ScriptNode | undefined), 'other');
        }
    });
    return bindingsByScope;
}

function collectDeclaredIdentifierNodes(root: ScriptNode): Set<ScriptNode> {
    const identifiers = new Set<ScriptNode>();
    const collect = (pattern: ScriptNode | ScriptNode[] | undefined): void => {
        if (!pattern) return;
        if (Array.isArray(pattern)) {
            for (const item of pattern) collect(item);
            return;
        }
        if (pattern.type === 'Identifier') {
            identifiers.add(pattern);
            return;
        }
        if (pattern.type === 'Property') {
            collect(pattern.value as ScriptNode | undefined);
            return;
        }
        if (pattern.type === 'RestElement') {
            collect(pattern.argument as ScriptNode | undefined);
            return;
        }
        if (pattern.type === 'AssignmentPattern') {
            collect(pattern.left as ScriptNode | undefined);
            return;
        }
        if (pattern.type === 'ObjectPattern') {
            collect((pattern.properties as ScriptNode[] | undefined) ?? []);
            return;
        }
        if (pattern.type === 'ArrayPattern') {
            collect((pattern.elements as ScriptNode[] | undefined) ?? []);
        }
    };

    walkScript(root, [], (node) => {
        if (node.type === 'VariableDeclarator') {
            collect(node.id as ScriptNode | undefined);
            return;
        }
        if (
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'ArrowFunctionExpression'
        ) {
            collect(node.id as ScriptNode | undefined);
            collect((node.params as ScriptNode[] | undefined) ?? []);
            return;
        }
        if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
            collect(node.id as ScriptNode | undefined);
            return;
        }
        if (node.type === 'CatchClause') {
            collect(node.param as ScriptNode | undefined);
        }
    });
    return identifiers;
}

function isIdentifierReference(
    node: ScriptNode,
    ancestors: ScriptNode[],
    declaredIdentifierNodes: Set<ScriptNode>
): boolean {
    if (declaredIdentifierNodes.has(node)) {
        return false;
    }
    const parent = ancestors.at(-1);
    if (!parent) {
        return false;
    }
    if (
        (parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') &&
        parent.property === node &&
        parent.computed !== true
    ) {
        return false;
    }
    if (
        (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
        parent.key === node &&
        parent.computed !== true &&
        parent.value !== node
    ) {
        return false;
    }
    if (
        (parent.type === 'LabeledStatement' && parent.label === node) ||
        ((parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && parent.label === node)
    ) {
        return false;
    }
    return parent.type !== 'MetaProperty';
}

function resolvesToBinding(
    name: string,
    ancestors: ScriptNode[],
    bindingsByScope: Map<ScriptNode, Map<string, ScriptBindingKind>>
): boolean {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const scope = ancestors[index];
        if (isBindingScope(scope) && bindingsByScope.get(scope)?.has(name)) {
            return true;
        }
    }
    return false;
}

function resolvesToAgentResult(
    name: string,
    ancestors: ScriptNode[],
    bindingsByScope: Map<ScriptNode, Map<string, ScriptBindingKind>>
): boolean {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const scope = ancestors[index];
        if (!isBindingScope(scope)) continue;
        const binding = bindingsByScope.get(scope)?.get(name);
        if (binding !== undefined) {
            return binding === 'agent-result';
        }
    }
    return false;
}

function findBindingScope(ancestors: ScriptNode[], functionScoped: boolean): ScriptNode | undefined {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const candidate = ancestors[index];
        if (functionScoped ? isFunctionBindingScope(candidate) : isBindingScope(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

function isBindingScope(node: ScriptNode): boolean {
    return (
        isFunctionBindingScope(node) ||
        node.type === 'BlockStatement' ||
        node.type === 'CatchClause' ||
        node.type === 'Program'
    );
}

function isFunctionBindingScope(node: ScriptNode): boolean {
    return (
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'Program'
    );
}

function isScriptNode(value: unknown): value is ScriptNode {
    return Boolean(value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string');
}

function isBindingNode(node: ScriptNode): boolean {
    return (
        node.type === 'VariableDeclarator' ||
        node.type === 'FunctionDeclaration' ||
        node.type === 'FunctionExpression' ||
        node.type === 'ArrowFunctionExpression' ||
        node.type === 'ClassDeclaration' ||
        node.type === 'ClassExpression' ||
        node.type === 'CatchClause' ||
        node.type === 'AssignmentExpression' ||
        node.type === 'UpdateExpression'
    );
}

function bindingPattern(node: ScriptNode): ScriptNode | ScriptNode[] | undefined {
    if (node.type === 'VariableDeclarator') return node.id as ScriptNode | undefined;
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression') {
        return [node.id as ScriptNode, ...((node.params as ScriptNode[] | undefined) ?? [])].filter(Boolean);
    }
    if (node.type === 'ArrowFunctionExpression') return (node.params as ScriptNode[] | undefined) ?? [];
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return node.id as ScriptNode | undefined;
    if (node.type === 'CatchClause') return node.param as ScriptNode | undefined;
    if (node.type === 'AssignmentExpression') return node.left as ScriptNode | undefined;
    return node.argument as ScriptNode | undefined;
}

function bindingNames(pattern: ScriptNode | ScriptNode[] | undefined): string[] {
    if (!pattern) return [];
    if (Array.isArray(pattern)) return pattern.flatMap((item) => bindingNames(item));
    if (pattern.type === 'Identifier') return pattern.name ? [pattern.name] : [];
    if (pattern.type === 'Property') return bindingNames(pattern.value as ScriptNode | undefined);
    if (pattern.type === 'RestElement') return bindingNames(pattern.argument as ScriptNode | undefined);
    if (pattern.type === 'AssignmentPattern') return bindingNames(pattern.left as ScriptNode | undefined);
    if (pattern.type === 'ObjectPattern') {
        return ((pattern.properties as ScriptNode[] | undefined) ?? []).flatMap((item) => bindingNames(item));
    }
    if (pattern.type === 'ArrayPattern') {
        return ((pattern.elements as ScriptNode[] | undefined) ?? []).flatMap((item) => bindingNames(item));
    }
    return [];
}

function unwrapAwait(node: ScriptNode | undefined): ScriptNode | undefined {
    return node?.type === 'AwaitExpression' ? (node.argument as ScriptNode | undefined) : node;
}

function isRuntimeCall(node: ScriptNode | undefined, name: string): boolean {
    const callee = node?.type === 'CallExpression' ? (node.callee as ScriptNode | undefined) : undefined;
    return callee?.type === 'Identifier' && callee.name === name;
}

function isAwaited(node: ScriptNode, ancestors: ScriptNode[]): boolean {
    for (let index = ancestors.length - 1; index >= 0; index -= 1) {
        const ancestor = ancestors[index];
        if (ancestor.type === 'AwaitExpression' || ancestor.type === 'ReturnStatement') {
            return true;
        }
        if (
            ancestor.type === 'ExpressionStatement' ||
            ancestor.type === 'VariableDeclarator' ||
            ancestor.type === 'AssignmentExpression'
        ) {
            return false;
        }
        if (
            ancestor.type === 'FunctionDeclaration' ||
            ancestor.type === 'FunctionExpression' ||
            ancestor.type === 'ArrowFunctionExpression'
        ) {
            return true;
        }
    }
    return false;
}

function literalString(node: ScriptNode | undefined): string | undefined {
    return node?.type === 'Literal' && typeof node.value === 'string' && node.value.trim()
        ? node.value.trim()
        : undefined;
}

function objectPropertyName(node: ScriptNode): string | undefined {
    const key = node.key as ScriptNode | undefined;
    if (!key) return undefined;
    if (node.computed === true) return typeof key.value === 'string' ? key.value : undefined;
    if (key.type === 'Identifier') return key.name;
    return typeof key.value === 'string' ? key.value : undefined;
}

function memberPropertyName(node: ScriptNode): string | undefined {
    const property = node.property as ScriptNode | undefined;
    if (!property) return undefined;
    if (node.computed === true) return typeof property.value === 'string' ? property.value : undefined;
    return property.type === 'Identifier' ? property.name : undefined;
}

function directArgsPropertyName(node: ScriptNode | undefined): string | undefined {
    if (!node || (node.type !== 'MemberExpression' && node.type !== 'OptionalMemberExpression')) {
        return undefined;
    }
    const object = node.object as ScriptNode | undefined;
    return object?.type === 'Identifier' && object.name === 'args' ? memberPropertyName(node) : undefined;
}

function isStaticFallbackValue(node: ScriptNode | undefined): boolean {
    if (!node) {
        return false;
    }
    if (node.type === 'Literal' || node.type === 'ArrayExpression' || node.type === 'ObjectExpression') {
        return true;
    }
    return node.type === 'TemplateLiteral' && ((node.expressions as ScriptNode[] | undefined) ?? []).length === 0;
}

function sameSequence(left: string[], right: string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function parseAuthoredOutput(value: WorkflowJSONValue): ParsedAuthoredOutput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Workflow 创建过程必须返回对象。');
    }
    const name = value.name;
    const description = value.description;
    const whenToUse = value.whenToUse;
    const phases = value.phases;
    const script = value.script;
    const inputSchema = value.inputSchema;
    if (typeof name !== 'string' || typeof description !== 'string' || typeof script !== 'string') {
        throw new Error('Workflow 创建结果必须包含字符串类型的 name、description 和 script。');
    }
    if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
        throw new Error('Workflow 创建结果必须包含 inputSchema 对象。');
    }
    if (whenToUse !== undefined && typeof whenToUse !== 'string') {
        throw new Error('Workflow 创建结果必须包含字符串类型的 name、description 和 script。');
    }
    if (phases !== undefined && !Array.isArray(phases)) {
        throw new Error('Workflow 创建结果必须包含字符串类型的 name、description 和 script。');
    }
    const parsedPhases = (phases as Array<{ name?: unknown; description?: unknown }> | undefined)?.map((phase) => {
        if (!phase || typeof phase !== 'object' || Array.isArray(phase) || typeof phase.name !== 'string') {
            throw new Error('Workflow 创建结果必须包含字符串类型的 name、description 和 script。');
        }
        if (phase.description !== undefined && typeof phase.description !== 'string') {
            throw new Error('Workflow 创建结果必须包含字符串类型的 name、description 和 script。');
        }
        return {
            name: phase.name,
            ...(phase.description ? { description: phase.description } : {})
        };
    });
    return {
        definition: {
            name,
            description,
            ...(whenToUse ? { whenToUse } : {}),
            ...(parsedPhases?.length ? { phases: parsedPhases } : {}),
            script,
            inputSchema
        },
        ...(value.launchInput === undefined ? {} : { launchInput: value.launchInput })
    } as { definition: WorkflowDefinitionInput; launchInput?: WorkflowJSONValue };
}

function collectUnsupportedLaunchInputValues(input: WorkflowJSONValue, hostTask: TaskState): string[] {
    const evidence = collectHostUserInputEvidence(hostTask).map(normalizeInputEvidence).filter(Boolean);
    return [
        ...new Set(
            collectWorkflowInputScalarValues(input).filter((value) => {
                const normalizedValue = normalizeInputEvidence(value);
                return (
                    !normalizedValue ||
                    !evidence.some((item) => item === normalizedValue || item.includes(normalizedValue))
                );
            })
        )
    ];
}

function collectHostUserInputEvidence(hostTask: TaskState): string[] {
    const evidence: string[] = [];
    for (const message of hostTask.chat_context?.messages ?? []) {
        if (message instanceof UserMessage && message.internal !== true) {
            evidence.push(message.rawText ?? message.getPlainText());
            continue;
        }
        if (!(message instanceof AssistantMessage)) {
            continue;
        }
        for (const part of message.content) {
            if (part.type !== 'tool_call') {
                continue;
            }
            for (const toolCall of part.toolcalls) {
                if (toolCall.tool_name === 'interaction-askUser' && toolCall.status === 'success') {
                    evidence.push(...parseAskUserInputEvidence(toolCall.result));
                }
            }
        }
    }
    return evidence;
}

function parseAskUserInputEvidence(result: string | undefined): string[] {
    if (!result) {
        return [];
    }
    try {
        const parsed = JSON.parse(result) as { answers?: unknown };
        if (!parsed.answers || typeof parsed.answers !== 'object' || Array.isArray(parsed.answers)) {
            return [];
        }
        return Object.values(parsed.answers)
            .flatMap((answer) => (Array.isArray(answer) ? answer : []))
            .filter((answer): answer is string => typeof answer === 'string' && answer.trim().length > 0);
    } catch {
        return [];
    }
}

function collectWorkflowInputScalarValues(value: WorkflowJSONValue): string[] {
    if (value === null) {
        return [];
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [String(value)];
    }
    if (Array.isArray(value)) {
        return value.flatMap(collectWorkflowInputScalarValues);
    }
    return Object.values(value).flatMap(collectWorkflowInputScalarValues);
}

function normalizeInputEvidence(value: string): string {
    return value.normalize('NFKC').trim().toLocaleLowerCase();
}

export function missingRequiredInputNames(
    inputSchema: Record<string, unknown>,
    input: WorkflowJSONValue | undefined
): string[] {
    const required = getRequiredWorkflowInputNames(inputSchema);
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return required;
    }
    return required.filter((field) => !Object.prototype.hasOwnProperty.call(input, field));
}

function validationErrorMessages(error: unknown): string[] {
    if (
        error &&
        typeof error === 'object' &&
        Array.isArray((error as { errors?: unknown }).errors) &&
        (error as { errors: unknown[] }).errors.every((item) => typeof item === 'string')
    ) {
        return (error as { errors: string[] }).errors;
    }
    return [error instanceof Error ? error.message : String(error)];
}
