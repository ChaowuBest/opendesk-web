/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * opendesk_meta.json 的类型定义、解析与验证
 *
 * 每个技能目录中可存放一个可选的 opendesk_meta.json，
 * 用于定义技能的依赖项和测试用例。
 *
 * 使用 zod 定义数据类型及校验规则，替代手写的 interface + 校验函数。
 */

import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { jsonrepair } from 'jsonrepair';

// ── Zod Schema 定义 ──

/** 环境变量依赖 */
export const EnvVarDependencySchema = z.object({
    name: z.string().min(1, '环境变量名称不能为空'),
    description: z.string().optional(),
    required: z.boolean().optional().default(false),
    defaultValue: z.string().optional()
});

/** Python 三方库依赖 */
export const PythonDependencySchema = z.object({
    name: z.string().min(1, 'Python 包名称不能为空'),
    version: z.string().optional(),
    description: z.string().optional()
});

/** npm 三方库依赖 */
export const NpmDependencySchema = z.object({
    name: z.string().min(1, 'npm 包名称不能为空'),
    version: z.string().optional(),
    description: z.string().optional()
});

/** 二进制可执行程序/命令依赖 */
export const BinaryDependencySchema = z.object({
    name: z.string().min(1, '命令名称不能为空'),
    version: z.string().optional(),
    description: z.string().optional(),
    installHint: z.string().optional()
});

/** 技能依赖项汇总 */
export const SkillDependenciesSchema = z.object({
    envVars: z.array(EnvVarDependencySchema).optional(),
    pythonPackages: z.array(PythonDependencySchema).optional(),
    npmPackages: z.array(NpmDependencySchema).optional(),
    binaries: z.array(BinaryDependencySchema).optional()
});

/** 测试状态枚举 */
export const TestStatusSchema = z.enum(['pending', 'passed', 'failed', 'skipped']);

/** 测试失败原因分类 */
export enum TestFailureReasonCategory {
    Misconfigured = 'misconfigured',
    DependencyRuntime = 'dependency_runtime',
    InputData = 'input_data',
    ExternalService = 'external_service',
    SkillImplementation = 'skill_implementation'
}

/** 测试失败原因分类 Schema */
export const TestFailureReasonCategorySchema = z.nativeEnum(TestFailureReasonCategory);

/** 单条测试用例 */
export const TestCaseSchema = z.object({
    index: z.number().int().positive('index 必须为正整数'),
    title: z.string().min(1, '测试用例标题不能为空'),
    prompt: z.string().min(1, '测试 Prompt 不能为空'),
    expectedResult: z.string().min(1, '预期结果不能为空'),
    status: TestStatusSchema,
    actualResult: z.string().optional(),
    error: z.string().optional(),
    failureReasonCategory: TestFailureReasonCategorySchema.optional(),
    taskId: z.string().optional().describe('执行该测试用例的 Agent 任务 ID')
});

/** opendesk_meta.json 的顶层结构 */
export const OpendeskMetaSchema = z.object({
    dependencies: SkillDependenciesSchema.optional(),
    testCases: z.array(TestCaseSchema).optional()
});

const TestResultMessageSchema = z
    .string()
    .min(1, 'message 不能为空')
    .describe('测试运行的简要概况（成功时描述执行过程和关键结果，失败时说明失败原因）');

/** Agent 返回的测试结果 */
export const TestResultSchema = z.discriminatedUnion('result', [
    z.object({
        result: z.literal('succeeded'),
        message: TestResultMessageSchema
    }),
    z.object({
        result: z.literal('failed'),
        message: TestResultMessageSchema,
        failureReasonCategory: TestFailureReasonCategorySchema
    })
]);

// ── 导出类型 ──

export type EnvVarDependency = z.infer<typeof EnvVarDependencySchema>;
export type PythonDependency = z.infer<typeof PythonDependencySchema>;
export type NpmDependency = z.infer<typeof NpmDependencySchema>;
export type BinaryDependency = z.infer<typeof BinaryDependencySchema>;
export type SkillDependencies = z.infer<typeof SkillDependenciesSchema>;
export type TestStatus = z.infer<typeof TestStatusSchema>;
export type TestFailureReasonCategoryType = z.infer<typeof TestFailureReasonCategorySchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;
export type OpendeskMeta = z.infer<typeof OpendeskMetaSchema>;
export type TestResult = z.infer<typeof TestResultSchema>;

// ── 验证结果 ──

/** 单条验证错误 */
export interface ValidationError {
    /** JSON 路径（如 dependencies.envVars[0].name） */
    path: string;
    /** 自然语言错误描述 */
    message: string;
}

/** 验证结果 */
export interface ValidationResult {
    /** 是否通过验证 */
    valid: boolean;
    /** 验证错误列表 */
    errors: ValidationError[];
}

// ── 常量 ──

/** opendesk_meta.json 文件名 */
export const OPENDESK_META_FILENAME = 'opendesk_meta.json';

/** 分析结果校验失败后的最大重试轮数 */
export const MAX_VALIDATION_RETRIES = 5;

/** 测试结果 JSON 解析/校验的最大重试轮数 */
export const MAX_TESTRESULT_RETRIES = 3;

// ── 解析与校验函数 ──

/**
 * 解析 opendesk_meta.json 字符串为 OpendeskMeta 对象。
 * 先做 JSON 解析，再用 zod schema 校验，失败时抛出包含自然语言错误描述的 Error。
 */
export function parseOpendeskMeta(jsonStr: string): OpendeskMeta {
    if (!jsonStr || typeof jsonStr !== 'string') {
        throw new Error('opendesk_meta.json 内容为空或不是有效的字符串');
    }

    let parsed: unknown;
    try {
        // 用 jsonrepair 修复常见的 JSON 格式问题（agent 生成的文件可能存在末尾逗号等瑕疵）
        parsed = JSON.parse(jsonrepair(jsonStr));
    } catch (e) {
        const msg = e instanceof SyntaxError ? e.message : String(e);
        throw new Error(`opendesk_meta.json JSON 解析失败: ${msg}`);
    }

    const result = OpendeskMetaSchema.safeParse(parsed);
    if (!result.success) {
        const messages = formatZodErrors(result.error.issues);
        throw new Error(`opendesk_meta.json 验证失败：\n${messages}\n请修正以上错误后重试。`);
    }

    return result.data;
}

/**
 * 校验任意数据是否符合 OpendeskMeta schema。
 * 返回 ValidationResult，失败时包含清晰的自然语言错误描述，
 * 方便后续 agent 进行纠正。
 */
export function validateOpendeskMeta(data: unknown): ValidationResult {
    const result = OpendeskMetaSchema.safeParse(data);
    if (result.success) {
        return { valid: true, errors: [] };
    }

    const errors: ValidationError[] = result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join('.') : '$',
        message: issue.message
    }));

    return { valid: false, errors };
}

/**
 * 将 zod 的 ZodIssue 数组格式化为人类可读的错误列表字符串。
 */
export function formatZodErrors(issues: z.ZodIssue[]): string {
    return issues
        .map((issue) => {
            const p = issue.path.length > 0 ? issue.path.join('.') : '$';
            return `  - ${p}: ${issue.message}`;
        })
        .join('\n');
}

/**
 * 将 ValidationError 数组格式化为人类可读的错误列表字符串。
 */
export function formatValidationErrors(errors: ValidationError[]): string {
    return errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
}

/**
 * 读取并验证 opendesk_meta.json 文件。
 * 如果文件不存在，返回 undefined。
 * 如果文件存在但解析或 JSON 格式错误，抛出包含自然语言错误描述的 Error。
 * 如果 zod 校验失败，同样抛出 Error。
 */
export function loadAndValidateOpendeskMeta(skillDir: string): OpendeskMeta | undefined {
    const metaPath = path.join(skillDir, OPENDESK_META_FILENAME);

    if (!fs.existsSync(metaPath)) {
        return undefined;
    }

    let raw: string;
    try {
        raw = fs.readFileSync(metaPath, 'utf-8');
    } catch (e) {
        throw new Error(`无法读取 ${OPENDESK_META_FILENAME}: ${(e as Error).message}`);
    }

    if (!raw.trim()) {
        // 空文件视为没有元数据
        return undefined;
    }

    return parseOpendeskMeta(raw);
}

/**
 * 尝试加载并校验 opendesk_meta.json，返回详细结果（不抛异常）。
 * 用于 agent 重试流程中区分"文件不存在"、"JSON 解析失败"和"校验失败"。
 *
 * @returns 成功返回 data，失败返回 error 和可选的 validationErrors
 */
export function tryLoadOpendeskMeta(
    skillDir: string
): { success: true; data: OpendeskMeta } | { success: false; error: string; validationErrors?: ValidationError[] } {
    const metaPath = path.join(skillDir, OPENDESK_META_FILENAME);

    if (!fs.existsSync(metaPath)) {
        return { success: false, error: `${OPENDESK_META_FILENAME} 文件不存在，请确保已正确写入` };
    }

    let raw: string;
    try {
        raw = fs.readFileSync(metaPath, 'utf-8');
    } catch (e) {
        return { success: false, error: `无法读取 ${OPENDESK_META_FILENAME}: ${(e as Error).message}` };
    }

    if (!raw.trim()) {
        return { success: false, error: `${OPENDESK_META_FILENAME} 文件为空` };
    }

    let parsed: unknown;
    try {
        // 用 jsonrepair 修复常见的 JSON 格式问题（agent 生成的文件可能存在末尾逗号等瑕疵）
        parsed = JSON.parse(jsonrepair(raw));
    } catch (e) {
        const msg = e instanceof SyntaxError ? e.message : String(e);
        return { success: false, error: `JSON 解析失败: ${msg}` };
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { success: false, error: '顶层必须是一个 JSON 对象（{}）' };
    }

    const result = OpendeskMetaSchema.safeParse(parsed);
    if (!result.success) {
        const validationErrors: ValidationError[] = result.error.issues.map((issue) => ({
            path: issue.path.length > 0 ? issue.path.join('.') : '$',
            message: issue.message
        }));
        return { success: false, error: '数据校验失败', validationErrors };
    }

    return { success: true, data: result.data };
}

/**
 * 生成格式化的 opendesk_meta.json 字符串（带缩进）。
 */
export function formatOpendeskMeta(meta: OpendeskMeta): string {
    return JSON.stringify(meta, null, 2);
}

/**
 * 从 Agent 回复文本中提取并校验 TestResult JSON。
 * 支持 agent 回复中可能包裹在 markdown 代码块内的 JSON。
 *
 * @returns 成功返回 data，失败返回 error
 */
export function parseTestResult(text: string): { success: true; data: TestResult } | { success: false; error: string } {
    if (!text || typeof text !== 'string') {
        return { success: false, error: 'Agent 回复为空' };
    }

    // 尝试提取 markdown 代码块中的 JSON
    let jsonStr = text.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
        jsonStr = fenceMatch[1].trim();
    }

    let parsed: unknown;
    try {
        // 先用 jsonrepair 修复常见的 JSON 格式问题（末尾逗号、无引号键等），
        // 提升 agent 返回结果的解析容错率
        const repaired = jsonrepair(jsonStr);
        parsed = JSON.parse(repaired);
    } catch (e) {
        const msg = e instanceof SyntaxError ? e.message : String(e);
        return { success: false, error: `JSON 解析失败: ${msg}` };
    }

    const result = TestResultSchema.safeParse(parsed);
    if (!result.success) {
        const messages = formatZodErrors(result.error.issues);
        return { success: false, error: `校验失败：\n${messages}` };
    }

    return { success: true, data: result.data };
}

/**
 * 根据测试结果 message 归类失败原因。
 * 仅作为 Agent 未返回合法分类或执行异常时的兜底启发式。
 */
export function classifyTestFailureReason(message: string): TestFailureReasonCategory {
    const text = message.toLowerCase();

    if (
        /env|environment variable|permission denied|sandbox|config|configuration|executable permission|access denied|eacces|eperm|平台|环境变量|配置|权限|系统路径|可执行权限/.test(
            text
        )
    ) {
        return TestFailureReasonCategory.Misconfigured;
    }

    if (
        /module not found|cannot find module|no module named|command not found|not found:|npm|pip|python|node|binary|runtime|version|compile|build failed|缺少.*依赖|依赖.*失败|版本不兼容|编译失败|运行时|二进制|命令不存在/.test(
            text
        )
    ) {
        return TestFailureReasonCategory.DependencyRuntime;
    }

    if (
        /invalid input|invalid argument|enoent|file not found|no such file|path|format|encoding|too large|参数|输入|文件不存在|路径|格式|编码|大小/.test(
            text
        )
    ) {
        return TestFailureReasonCategory.InputData;
    }

    if (
        /network|timeout|timed out|api timeout|http|https|dns|econnrefused|econnreset|enotfound|fetch|远端|外部服务|网络|超时|认证|接口|服务异常/.test(
            text
        )
    ) {
        return TestFailureReasonCategory.ExternalService;
    }

    return TestFailureReasonCategory.SkillImplementation;
}
