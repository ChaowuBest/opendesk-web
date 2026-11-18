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

import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { OPENDESK_PLUGIN_API_VERSION, OPENDESK_PLUGIN_CAPABILITIES, OPENDESK_PLUGIN_PLATFORMS } from './index.js';

export const OPENDESK_PLUGIN_MANIFEST = 'opendesk.plugin.json';

export type OpenDeskPluginPackageErrorCode =
    | 'package_json_missing'
    | 'package_json_invalid'
    | 'package_metadata_invalid'
    | 'plugin_declaration_missing'
    | 'plugin_manifest_invalid'
    | 'plugin_api_incompatible'
    | 'plugin_structure_invalid';

export class OpenDeskPluginPackageError extends Error {
    constructor(
        readonly code: OpenDeskPluginPackageErrorCode,
        message: string
    ) {
        super(message);
        this.name = 'OpenDeskPluginPackageError';
    }
}

const StringRecordSchema = z.record(z.string(), z.string());

/** displayName：简单字符串或按语言声明的本地化对象 */
const DisplayNameSchema = z.union([z.string().trim().min(1), z.record(z.string().min(1), z.string().trim().min(1))]);

const McpServerSchema = z.discriminatedUnion('transport', [
    z.object({
        name: z.string().min(1),
        transport: z.literal('stdio'),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        cwd: z.string().min(1).optional(),
        env: StringRecordSchema.optional()
    }),
    z.object({
        name: z.string().min(1),
        transport: z.enum(['sse', 'streamableHttp']),
        url: z.url(),
        headers: StringRecordSchema.optional()
    })
]);

const PluginResourcesSchema = z.object({
    skills: z.array(z.string().min(1)).optional(),
    mcpServers: z.array(McpServerSchema).optional(),
    agents: z.array(z.string().min(1)).optional(),
    /** 语言包声明：目录（收集顶层 *.json）或单文件，文件名即 BCP-47 语言 tag */
    locales: z.array(z.string().min(1)).optional()
});

/** 站点地址：只接受 http(s)——会展示在界面上，不能放行 `javascript:` 之类的协议 */
const HttpUrlSchema = z.string().refine(
    (value) => {
        try {
            const url = new URL(value);
            return url.protocol === 'http:' || url.protocol === 'https:';
        } catch {
            return false;
        }
    },
    { message: 'expected an http(s) URL' }
);

/**
 * 插件图标地址是否合法：http(s) 图片链接，或随包分发的安全相对路径（解析到插件根目录内）。
 *
 * 打包期（schema）与宿主加载（pluginmgr/discovery/manifest.ts）共用这一个实现，
 * 两边口径不会漂移：绝对路径、根相对路径（含反斜杠开头）与目录穿越都拒绝。
 */
export function isValidPluginIconUrl(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return (
            !path.isAbsolute(value) &&
            !value.startsWith('/') &&
            !value.startsWith('\\') &&
            !value.split(/[\\/]+/).includes('..')
        );
    }
}

const PluginIconUrlSchema = z.string().refine(isValidPluginIconUrl, {
    message: 'expected an http(s) URL or a safe relative path inside the plugin'
});

/** 本地化文本（displayName / description / 作者名与机构通用）：字符串或按语言声明的对象 */
const LocalizedTextSchema = DisplayNameSchema;

/** 插件作者：name 必填（字符串或本地化对象），institution / homepage 可选 */
const PluginAuthorSchema = z.object({
    name: LocalizedTextSchema,
    institution: LocalizedTextSchema.optional(),
    homepage: HttpUrlSchema.optional()
});

/**
 * 版本类字段必须是合法 SemVer。
 *
 * 规则与宿主侧 `src/main/utils/version.ts`（semver 库）逐条对齐，否则会出现
 * 「CLI 打包通过、宿主加载报错」这类事后才发现的不一致；两边由
 * `src/tests/ut/plugin/package.test.ts` 用同一批边界样例互检。
 * 注意前三个捕获组依次是 major / minor / patch，下面的数值上限校验依赖这个顺序。
 */
const SEMVER_PATTERN =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
/** semver 库的版本号长度上限 */
const MAX_SEMVER_LENGTH = 256;

function isSemVerVersion(value: string): boolean {
    const text = value.trim();
    if (text.length > MAX_SEMVER_LENGTH) return false;
    const match = text.match(SEMVER_PATTERN);
    if (!match) return false;
    // semver 库只接受能安全表示成 JS number 的主次修订号
    return match.slice(1, 4).every((part) => Number(part) <= Number.MAX_SAFE_INTEGER);
}

const SemverSchema = z
    .string()
    .refine((value) => isSemVerVersion(value), { message: 'expected a SemVer version such as 1.2.3' });

export const OpenDeskPluginManifestSchema = z.object({
    /**
     * 插件入口：可运行插件必填；纯静态插件（如语言包，只声明 resources.* 的贡献）
     * 不需要入口文件，缺省即按纯静态插件装载（宿主不执行任何插件代码）。
     */
    entry: z.string().min(1).optional(),
    id: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
        .optional(),
    displayName: LocalizedTextSchema.optional(),
    /** 插件描述：与 displayName 一样支持字符串或按语言声明的对象 */
    description: LocalizedTextSchema.optional(),
    version: SemverSchema.optional(),
    /**
     * 插件分类标签，供插件市场按分类分组显示。
     * 取值是自由文本，需要与插件所在市场的分类保持一致才会被归类；
     * 不声明表示「未分类」，仍然会出现在市场的全部插件里。
     */
    category: z.array(z.string().min(1)).optional(),
    /** 作者信息：仅用于插件中心 / 插件市场的展示 */
    author: PluginAuthorSchema.optional(),
    /** 插件自身的站点地址（作者主页是 author.homepage） */
    homepage: HttpUrlSchema.optional(),
    /**
     * 插件图标：http(s) 图片链接或随包分发的相对路径（相对插件根目录）。
     * 仅用于插件中心 / 插件市场的展示；不声明时按名称渲染首字母图标。
     */
    iconUrl: PluginIconUrlSchema.optional(),
    apiVersion: z.literal(OPENDESK_PLUGIN_API_VERSION),
    capabilities: z.array(z.enum(OPENDESK_PLUGIN_CAPABILITIES)),
    platforms: z.array(z.enum(OPENDESK_PLUGIN_PLATFORMS)).optional(),
    minOpenDeskVersion: SemverSchema.optional(),
    maxOpenDeskVersion: SemverSchema.optional(),
    resources: PluginResourcesSchema.optional(),
    /**
     * 仅内置插件生效：由清单固定启停状态，pluginmgr 不再允许修改该插件开关。
     * 后装插件声明这两个字段时，宿主在加载时记一条 warning 并忽略。
     */
    system: z.boolean().optional(),
    /** 与 system 配合：固定启用（true，默认）或固定禁用（false） */
    enabled: z.boolean().optional()
});

const PackagePluginDeclarationSchema = OpenDeskPluginManifestSchema.omit({ entry: true }).extend({
    /** 与 entry 同口径：纯静态插件可不声明 */
    plugin: z.string().min(1).optional()
});

export interface ValidatedOpenDeskPluginPackage {
    id: string;
    name: string;
    version: string;
    /** 解析后的入口绝对路径；纯静态插件（语言包等）没有入口，为 undefined */
    entry?: string;
    apiVersion: number;
    capabilities: string[];
    /** 插件要求的宿主版本下界（含）；未声明表示不限。安装期的宿主版本闸门据此拦截 */
    minOpenDeskVersion?: string;
    /** 插件要求的宿主版本上界（含）；未声明表示不限 */
    maxOpenDeskVersion?: string;
    /** 插件支持的操作系统平台（win32 / darwin / linux 等）；未声明表示不限。安装期的平台闸门据此拦截 */
    platforms?: string[];
}

function normalizePluginId(packageName: string): string {
    const normalized = packageName
        .replace(/^@/, '')
        .replace(/[\\/]+/g, '.')
        .replace(/[^a-zA-Z0-9._-]+/g, '-');
    return /^[a-zA-Z]/.test(normalized) ? normalized : `plugin-${normalized}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertSafeRelativePath(value: string): void {
    if (path.isAbsolute(value) || value.split(/[\\/]+/).includes('..')) {
        throw new OpenDeskPluginPackageError('plugin_structure_invalid', `Unsafe plugin path: ${value}`);
    }
}

function readPackageJson(directory: string): Record<string, unknown> {
    const file = path.join(directory, 'package.json');
    if (!fs.existsSync(file)) {
        throw new OpenDeskPluginPackageError('package_json_missing', 'package.json not found');
    }
    let value: unknown;
    try {
        value = JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new OpenDeskPluginPackageError('package_json_invalid', `invalid package.json: ${detail}`);
    }
    if (!isRecord(value)) {
        throw new OpenDeskPluginPackageError('package_json_invalid', 'package.json must contain an object');
    }
    return value;
}

function readOptionalPackageJson(directory: string): Record<string, unknown> {
    return fs.existsSync(path.join(directory, 'package.json')) ? readPackageJson(directory) : {};
}

function parsePluginDeclaration<T>(value: unknown, schema: z.ZodType<T>, source: string): T {
    if (!isRecord(value)) {
        throw new OpenDeskPluginPackageError('plugin_manifest_invalid', `invalid ${source}: expected an object`);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'apiVersion') && value.apiVersion !== OPENDESK_PLUGIN_API_VERSION) {
        throw new OpenDeskPluginPackageError(
            'plugin_api_incompatible',
            `unsupported plugin API version: ${String(value.apiVersion)}`
        );
    }
    try {
        return schema.parse(value);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new OpenDeskPluginPackageError('plugin_manifest_invalid', `invalid ${source}: ${detail}`);
    }
}

function readManifestJson(file: string): unknown {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            `invalid ${OPENDESK_PLUGIN_MANIFEST}: ${detail}`
        );
    }
}

function readPluginManifest(directory: string, packageJson: Record<string, unknown>) {
    const manifestPath = path.join(directory, OPENDESK_PLUGIN_MANIFEST);
    if (fs.existsSync(manifestPath)) {
        const manifest = parsePluginDeclaration(
            readManifestJson(manifestPath),
            OpenDeskPluginManifestSchema,
            OPENDESK_PLUGIN_MANIFEST
        );
        if (packageJson.opendesk !== undefined) {
            const declaration = parsePluginDeclaration(
                packageJson.opendesk,
                PackagePluginDeclarationSchema,
                'package.json#opendesk'
            );
            if (declaration.plugin !== manifest.entry || declaration.id !== manifest.id) {
                throw new OpenDeskPluginPackageError(
                    'plugin_manifest_invalid',
                    'opendesk.plugin.json conflicts with package.json#opendesk'
                );
            }
        }
        return manifest;
    }
    if (packageJson.opendesk === undefined) {
        throw new OpenDeskPluginPackageError(
            'plugin_declaration_missing',
            `OpenDesk plugin declaration not found in ${OPENDESK_PLUGIN_MANIFEST} or package.json#opendesk`
        );
    }
    const declaration = parsePluginDeclaration(
        packageJson.opendesk,
        PackagePluginDeclarationSchema,
        'package.json#opendesk'
    );
    return {
        ...declaration,
        entry: declaration.plugin
    };
}

function validatePluginDirectory(directory: string, requirePackageMetadata: boolean): ValidatedOpenDeskPluginPackage {
    const packageJson = requirePackageMetadata ? readPackageJson(directory) : readOptionalPackageJson(directory);
    if (requirePackageMetadata && (typeof packageJson.name !== 'string' || !packageJson.name)) {
        throw new OpenDeskPluginPackageError('package_metadata_invalid', 'package name is required');
    }
    if (requirePackageMetadata && (typeof packageJson.version !== 'string' || !packageJson.version)) {
        throw new OpenDeskPluginPackageError('package_metadata_invalid', 'package version is required');
    }
    const declaration = readPluginManifest(directory, packageJson);
    // 入口仅在声明时校验存在性：纯静态插件（语言包等只声明 resources.locales 的贡献）
    // 没有可运行入口，缺 entry 是合法形态，由宿主 loader 走静态装载路径
    let entry: string | undefined;
    if (declaration.entry !== undefined) {
        assertSafeRelativePath(declaration.entry);
        const resolvedEntry = path.resolve(directory, declaration.entry);
        if (!fs.existsSync(resolvedEntry) || !fs.statSync(resolvedEntry).isFile()) {
            throw new OpenDeskPluginPackageError(
                'plugin_structure_invalid',
                `plugin entry not found: ${declaration.entry}`
            );
        }
        entry = resolvedEntry;
    }
    for (const skillPath of declaration.resources?.skills ?? []) {
        assertSafeRelativePath(skillPath);
        const skillDirectory = path.resolve(directory, skillPath);
        if (!fs.existsSync(skillDirectory) || !fs.statSync(skillDirectory).isDirectory()) {
            throw new OpenDeskPluginPackageError(
                'plugin_structure_invalid',
                `plugin skill path not found: ${skillPath}`
            );
        }
    }
    for (const agentPath of declaration.resources?.agents ?? []) {
        assertSafeRelativePath(agentPath);
        const agentDirectory = path.resolve(directory, agentPath);
        if (!fs.existsSync(agentDirectory) || !fs.statSync(agentDirectory).isDirectory()) {
            throw new OpenDeskPluginPackageError(
                'plugin_structure_invalid',
                `plugin agent path not found: ${agentPath}`
            );
        }
    }
    for (const server of declaration.resources?.mcpServers ?? []) {
        if (server.transport !== 'stdio') continue;
        if (server.command.startsWith('./') || server.command.startsWith('../')) {
            assertSafeRelativePath(server.command);
        }
        if (server.cwd) assertSafeRelativePath(server.cwd);
    }
    if (declaration.resources?.skills?.length && !declaration.capabilities.includes('skill')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin skill resource requires the skill capability'
        );
    }
    if (declaration.resources?.mcpServers?.length && !declaration.capabilities.includes('mcp')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin MCP resource requires the mcp capability'
        );
    }
    if (declaration.resources?.agents?.length && !declaration.capabilities.includes('agent')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin agent resource requires the agent capability'
        );
    }
    if (declaration.resources?.locales?.length && !declaration.capabilities.includes('locale')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin locale resource requires the locale capability'
        );
    }
    for (const localePath of declaration.resources?.locales ?? []) {
        assertSafeRelativePath(localePath);
        const resolvedLocalePath = path.resolve(directory, localePath);
        if (!fs.existsSync(resolvedLocalePath)) {
            throw new OpenDeskPluginPackageError(
                'plugin_structure_invalid',
                `plugin locale path not found: ${localePath}`
            );
        }
    }
    const packageName = typeof packageJson.name === 'string' && packageJson.name ? packageJson.name : undefined;
    const packageVersion =
        typeof packageJson.version === 'string' && packageJson.version ? packageJson.version : undefined;
    const inferredName = declaration.id ?? path.basename(path.resolve(directory));
    return {
        id: declaration.id ?? normalizePluginId(packageName ?? inferredName),
        name: packageName ?? inferredName,
        version: packageVersion ?? declaration.version ?? '0.0.0',
        entry,
        apiVersion: declaration.apiVersion,
        capabilities: [...declaration.capabilities],
        minOpenDeskVersion: declaration.minOpenDeskVersion,
        maxOpenDeskVersion: declaration.maxOpenDeskVersion,
        platforms: declaration.platforms ? [...declaration.platforms] : undefined
    };
}

export function validateOpenDeskPluginPackage(directory: string): ValidatedOpenDeskPluginPackage {
    return validatePluginDirectory(directory, true);
}

export function validateOpenDeskPluginDirectory(directory: string): ValidatedOpenDeskPluginPackage {
    return validatePluginDirectory(directory, false);
}
