/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

/**
 * opendesk_meta.json 的类型定义、解析与验证
 *
 * 每个技能目录中可存放一个可选的 opendesk_meta.json，
 * 用于定义技能的依赖项和测试用例。
 */

import fs from 'fs';
import path from 'path';

// ── 依赖项类型 ──

/** 环境变量依赖 */
export interface EnvVarDependency {
    /** 环境变量名称 */
    name: string;
    /** 用途说明 */
    description?: string;
    /** 是否必需 */
    required?: boolean;
    /** 默认值 */
    defaultValue?: string;
}

/** Python 三方库依赖 */
export interface PythonDependency {
    /** 包名称（如 requests、numpy） */
    name: string;
    /** 版本约束（如 >=2.28, ^1.0） */
    version?: string;
    /** 用途说明 */
    description?: string;
}

/** npm 三方库依赖 */
export interface NpmDependency {
    /** 包名称 */
    name: string;
    /** 版本约束 */
    version?: string;
    /** 用途说明 */
    description?: string;
}

/** 二进制可执行程序/命令依赖 */
export interface BinaryDependency {
    /** 命令名称（如 ffmpeg、git） */
    name: string;
    /** 最低版本要求 */
    version?: string;
    /** 用途说明 */
    description?: string;
    /** 安装指引（如 brew install ffmpeg） */
    installHint?: string;
}

/** 技能依赖项汇总 */
export interface SkillDependencies {
    /** 环境变量 */
    envVars?: EnvVarDependency[];
    /** Python 三方库 */
    pythonPackages?: PythonDependency[];
    /** npm 三方库 */
    npmPackages?: NpmDependency[];
    /** 二进制可执行程序 */
    binaries?: BinaryDependency[];
}

// ── 测试用例类型 ──

/** 测试状态枚举 */
export type TestStatus = 'pending' | 'passed' | 'failed' | 'skipped';

/** 单条测试用例 */
export interface TestCase {
    /** 测试用例序号 */
    index: number;
    /** 测试用例标题 */
    title: string;
    /** 场景描述 */
    scenario: string;
    /** 预期结果 */
    expectedResult: string;
    /** 当前测试状态 */
    status: TestStatus;
    /** 实际结果（测试运行后填写） */
    actualResult?: string;
    /** 错误信息（测试失败时填写） */
    error?: string;
}

// ── 顶层元数据类型 ──

/** opendesk_meta.json 的顶层结构 */
export interface OpendeskMeta {
    /** 技能依赖项 */
    dependencies?: SkillDependencies;
    /** 测试用例列表 */
    testCases?: TestCase[];
}

// ── 验证结果 ──

/** 验证错误 */
export interface ValidationError {
    /** JSON 路径（如 $.dependencies.envVars[0].name） */
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

/** 并发分析上限 */
export const MAX_ANALYSIS_CONCURRENCY = 5;

// ── 验证辅助 ──

function isNonEmptyString(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function isPositiveInteger(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

// ── 解析函数 ──

/**
 * 解析 opendesk_meta.json 字符串为 OpendeskMeta 对象。
 * 解析失败时抛出包含自然语言错误描述的 Error。
 */
export function parseOpendeskMeta(jsonStr: string): OpendeskMeta {
    if (!jsonStr || typeof jsonStr !== 'string') {
        throw new Error('opendesk_meta.json 内容为空或不是有效的字符串');
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(jsonStr);
    } catch (e) {
        const msg = e instanceof SyntaxError ? e.message : String(e);
        throw new Error(`opendesk_meta.json JSON 解析失败: ${msg}`);
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('opendesk_meta.json 的顶层必须是一个 JSON 对象（{}）');
    }

    return parsed as OpendeskMeta;
}

// ── 验证函数 ──

/**
 * 验证 OpendeskMeta 对象的合法性。
 * 返回 ValidationResult，失败时包含清晰的自然语言错误描述，
 * 方便后续 agent 进行纠正。
 */
export function validateOpendeskMeta(meta: OpendeskMeta): ValidationResult {
    const errors: ValidationError[] = [];

    // 验证 dependencies
    if (meta.dependencies !== undefined) {
        if (meta.dependencies === null || typeof meta.dependencies !== 'object' || Array.isArray(meta.dependencies)) {
            errors.push({
                path: '$.dependencies',
                message:
                    'dependencies 必须是一个 JSON 对象，包含可选的 envVars、pythonPackages、npmPackages、binaries 字段'
            });
        } else {
            const deps = meta.dependencies as Record<string, unknown>;

            // 验证 envVars
            if (deps.envVars !== undefined) {
                if (!Array.isArray(deps.envVars)) {
                    errors.push({
                        path: '$.dependencies.envVars',
                        message:
                            'envVars 必须是一个数组，每个元素包含 name（必填，字符串）、description（可选，字符串）、required（可选，布尔值）、defaultValue（可选，字符串）'
                    });
                } else {
                    (deps.envVars as unknown[]).forEach((item, i) => {
                        if (!item || typeof item !== 'object') {
                            errors.push({
                                path: `$.dependencies.envVars[${i}]`,
                                message: `envVars[${i}] 必须是一个 JSON 对象`
                            });
                            return;
                        }
                        const ev = item as Record<string, unknown>;
                        if (!isNonEmptyString(ev.name)) {
                            errors.push({
                                path: `$.dependencies.envVars[${i}].name`,
                                message: `envVars[${i}].name 是必填字段，必须是一个非空字符串，表示环境变量的名称`
                            });
                        }
                        if (ev.required !== undefined && typeof ev.required !== 'boolean') {
                            errors.push({
                                path: `$.dependencies.envVars[${i}].required`,
                                message: `envVars[${i}].required 如果提供，必须是一个布尔值（true 或 false）`
                            });
                        }
                        if (ev.description !== undefined && typeof ev.description !== 'string') {
                            errors.push({
                                path: `$.dependencies.envVars[${i}].description`,
                                message: `envVars[${i}].description 如果提供，必须是一个字符串`
                            });
                        }
                        if (ev.defaultValue !== undefined && typeof ev.defaultValue !== 'string') {
                            errors.push({
                                path: `$.dependencies.envVars[${i}].defaultValue`,
                                message: `envVars[${i}].defaultValue 如果提供，必须是一个字符串`
                            });
                        }
                    });
                }
            }

            // 验证 pythonPackages
            if (deps.pythonPackages !== undefined) {
                if (!Array.isArray(deps.pythonPackages)) {
                    errors.push({
                        path: '$.dependencies.pythonPackages',
                        message:
                            'pythonPackages 必须是一个数组，每个元素包含 name（必填，字符串）、version（可选，字符串）、description（可选，字符串）'
                    });
                } else {
                    (deps.pythonPackages as unknown[]).forEach((item, i) => {
                        if (!item || typeof item !== 'object') {
                            errors.push({
                                path: `$.dependencies.pythonPackages[${i}]`,
                                message: `pythonPackages[${i}] 必须是一个 JSON 对象`
                            });
                            return;
                        }
                        const pkg = item as Record<string, unknown>;
                        if (!isNonEmptyString(pkg.name)) {
                            errors.push({
                                path: `$.dependencies.pythonPackages[${i}].name`,
                                message: `pythonPackages[${i}].name 是必填字段，必须是一个非空字符串，表示 Python 包名称（如 requests）`
                            });
                        }
                        if (pkg.version !== undefined && typeof pkg.version !== 'string') {
                            errors.push({
                                path: `$.dependencies.pythonPackages[${i}].version`,
                                message: `pythonPackages[${i}].version 如果提供，必须是一个字符串，表示版本约束（如 ">=2.28"）`
                            });
                        }
                        if (pkg.description !== undefined && typeof pkg.description !== 'string') {
                            errors.push({
                                path: `$.dependencies.pythonPackages[${i}].description`,
                                message: `pythonPackages[${i}].description 如果提供，必须是一个字符串`
                            });
                        }
                    });
                }
            }

            // 验证 npmPackages
            if (deps.npmPackages !== undefined) {
                if (!Array.isArray(deps.npmPackages)) {
                    errors.push({
                        path: '$.dependencies.npmPackages',
                        message:
                            'npmPackages 必须是一个数组，每个元素包含 name（必填，字符串）、version（可选，字符串）、description（可选，字符串）'
                    });
                } else {
                    (deps.npmPackages as unknown[]).forEach((item, i) => {
                        if (!item || typeof item !== 'object') {
                            errors.push({
                                path: `$.dependencies.npmPackages[${i}]`,
                                message: `npmPackages[${i}] 必须是一个 JSON 对象`
                            });
                            return;
                        }
                        const pkg = item as Record<string, unknown>;
                        if (!isNonEmptyString(pkg.name)) {
                            errors.push({
                                path: `$.dependencies.npmPackages[${i}].name`,
                                message: `npmPackages[${i}].name 是必填字段，必须是一个非空字符串，表示 npm 包名称`
                            });
                        }
                        if (pkg.version !== undefined && typeof pkg.version !== 'string') {
                            errors.push({
                                path: `$.dependencies.npmPackages[${i}].version`,
                                message: `npmPackages[${i}].version 如果提供，必须是一个字符串`
                            });
                        }
                        if (pkg.description !== undefined && typeof pkg.description !== 'string') {
                            errors.push({
                                path: `$.dependencies.npmPackages[${i}].description`,
                                message: `npmPackages[${i}].description 如果提供，必须是一个字符串`
                            });
                        }
                    });
                }
            }

            // 验证 binaries
            if (deps.binaries !== undefined) {
                if (!Array.isArray(deps.binaries)) {
                    errors.push({
                        path: '$.dependencies.binaries',
                        message:
                            'binaries 必须是一个数组，每个元素包含 name（必填，字符串）、version（可选，字符串）、description（可选，字符串）、installHint（可选，字符串）'
                    });
                } else {
                    (deps.binaries as unknown[]).forEach((item, i) => {
                        if (!item || typeof item !== 'object') {
                            errors.push({
                                path: `$.dependencies.binaries[${i}]`,
                                message: `binaries[${i}] 必须是一个 JSON 对象`
                            });
                            return;
                        }
                        const bin = item as Record<string, unknown>;
                        if (!isNonEmptyString(bin.name)) {
                            errors.push({
                                path: `$.dependencies.binaries[${i}].name`,
                                message: `binaries[${i}].name 是必填字段，必须是一个非空字符串，表示命令名称（如 ffmpeg、git）`
                            });
                        }
                        if (bin.version !== undefined && typeof bin.version !== 'string') {
                            errors.push({
                                path: `$.dependencies.binaries[${i}].version`,
                                message: `binaries[${i}].version 如果提供，必须是一个字符串，表示最低版本要求`
                            });
                        }
                        if (bin.description !== undefined && typeof bin.description !== 'string') {
                            errors.push({
                                path: `$.dependencies.binaries[${i}].description`,
                                message: `binaries[${i}].description 如果提供，必须是一个字符串`
                            });
                        }
                        if (bin.installHint !== undefined && typeof bin.installHint !== 'string') {
                            errors.push({
                                path: `$.dependencies.binaries[${i}].installHint`,
                                message: `binaries[${i}].installHint 如果提供，必须是一个字符串，如 "brew install ffmpeg"`
                            });
                        }
                    });
                }
            }
        }
    }

    // 验证 testCases
    if (meta.testCases !== undefined) {
        if (!Array.isArray(meta.testCases)) {
            errors.push({
                path: '$.testCases',
                message:
                    'testCases 必须是一个数组，每个元素包含 index（必填，正整数）、title（必填，字符串）、scenario（必填，字符串）、expectedResult（必填，字符串）、status（必填，取值为 pending/passed/failed/skipped）'
            });
        } else {
            (meta.testCases as unknown[]).forEach((item, i) => {
                if (!item || typeof item !== 'object') {
                    errors.push({
                        path: `$.testCases[${i}]`,
                        message: `testCases[${i}] 必须是一个 JSON 对象`
                    });
                    return;
                }
                const tc = item as Record<string, unknown>;

                if (tc.index === undefined || tc.index === null) {
                    errors.push({
                        path: `$.testCases[${i}].index`,
                        message: `testCases[${i}].index 是必填字段，必须是一个正整数，表示测试用例的序号`
                    });
                } else if (!isPositiveInteger(tc.index)) {
                    errors.push({
                        path: `$.testCases[${i}].index`,
                        message: `testCases[${i}].index 当前值为 ${JSON.stringify(tc.index)}，必须是一个正整数`
                    });
                }

                if (!isNonEmptyString(tc.title)) {
                    errors.push({
                        path: `$.testCases[${i}].title`,
                        message: `testCases[${i}].title 是必填字段，必须是一个非空字符串，表示测试用例的标题`
                    });
                }

                if (!isNonEmptyString(tc.scenario)) {
                    errors.push({
                        path: `$.testCases[${i}].scenario`,
                        message: `testCases[${i}].scenario 是必填字段，必须是一个非空字符串，描述测试场景`
                    });
                }

                if (!isNonEmptyString(tc.expectedResult)) {
                    errors.push({
                        path: `$.testCases[${i}].expectedResult`,
                        message: `testCases[${i}].expectedResult 是必填字段，必须是一个非空字符串，描述预期结果`
                    });
                }

                const validStatuses: TestStatus[] = ['pending', 'passed', 'failed', 'skipped'];
                if (tc.status === undefined || tc.status === null) {
                    errors.push({
                        path: `$.testCases[${i}].status`,
                        message: `testCases[${i}].status 是必填字段，取值必须是: ${validStatuses.join('、')}`
                    });
                } else if (!validStatuses.includes(tc.status as TestStatus)) {
                    errors.push({
                        path: `$.testCases[${i}].status`,
                        message: `testCases[${i}].status 当前值为 "${String(tc.status)}"，取值必须是: ${validStatuses.join('、')}`
                    });
                }

                if (tc.actualResult !== undefined && typeof tc.actualResult !== 'string') {
                    errors.push({
                        path: `$.testCases[${i}].actualResult`,
                        message: `testCases[${i}].actualResult 如果提供，必须是一个字符串`
                    });
                }

                if (tc.error !== undefined && typeof tc.error !== 'string') {
                    errors.push({
                        path: `$.testCases[${i}].error`,
                        message: `testCases[${i}].error 如果提供，必须是一个字符串`
                    });
                }
            });
        }
    }

    return {
        valid: errors.length === 0,
        errors
    };
}

/**
 * 读取并验证 opendesk_meta.json 文件。
 * 如果文件不存在，返回 undefined。
 * 如果文件存在但解析或验证失败，抛出包含自然语言错误描述的 Error。
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

    const meta = parseOpendeskMeta(raw);
    const result = validateOpendeskMeta(meta);
    if (!result.valid) {
        const errorMessages = result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n');
        throw new Error(`${OPENDESK_META_FILENAME} 验证失败：\n${errorMessages}\n请修正以上错误后重试。`);
    }

    return meta;
}

/**
 * 生成格式化的 opendesk_meta.json 字符串（带缩进）。
 */
export function formatOpendeskMeta(meta: OpendeskMeta): string {
    return JSON.stringify(meta, null, 2);
}
