/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { Skill, SKILL_MD_FILENAME } from '../../../aikernel/skill.js';
import {
    localePrimaryTag,
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_CAPABILITIES,
    OPENDESK_PLUGIN_PLATFORMS,
    type OpenDeskPlugin,
    type PluginAuthor,
    type PluginCapability,
    type PluginDisplayName,
    type PluginLocalePackDefinition,
    type PluginLocalizedText,
    type PluginMcpServerDefinition,
    type PluginPlatform,
    type PluginStaticResources
} from '../../../../../packages/plugin-sdk/src/index.js';
import { isValidPluginIconUrl } from '../../../../../packages/plugin-sdk/src/package.js';
import { AGENT_MANIFEST_ERROR_CODES, loadAgentsFromDirectory } from './agent-resource.js';
import { isValidVersion } from '../../../utils/version.js';
import { type LocalePackContent, LocalePackParseError, parseLocalePackJson } from '../../../../common/locale/pack.js';

export interface PluginManifestResources {
    skills?: string[];
    mcpServers?: PluginMcpServerDefinition[];
    agents?: string[];
    /**
     * 语言包声明：插件根内的相对路径数组，元素为目录（收集目录顶层 *.json，文件名即
     * 语言 tag，与 skills 目录的平铺收集一致）或单个 .json 语言包文件。
     * 声明时必须同时声明 `locale` capability。
     */
    locales?: string[];
}

export interface PluginManifest {
    entry?: string;
    id?: string;
    displayName?: PluginDisplayName;
    description?: PluginLocalizedText;
    version?: string;
    /** 插件分类标签（插件市场按分类显示用），未声明表示未分类 */
    category?: string[];
    /** 作者信息：仅用于界面展示 */
    author?: PluginAuthor;
    /** 插件自身的站点地址（作者主页是 author.homepage） */
    homepage?: string;
    /**
     * 插件图标：http(s) 图片链接或包内相对路径（相对插件根目录，指向随包分发的图标文件）。
     * 仅用于插件中心 / 插件市场的展示；不声明时按名称渲染首字母图标。
     */
    iconUrl?: string;
    apiVersion: number;
    capabilities?: PluginCapability[];
    platforms?: PluginPlatform[];
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    resources?: PluginManifestResources;
    /** 仅内置插件生效：由清单固定启停状态，pluginmgr 不再允许更改开关 */
    system?: boolean;
    /** 与 system 配合：固定启用（true，默认）或固定禁用（false） */
    enabled?: boolean;
}

const capabilitySet = new Set<string>(OPENDESK_PLUGIN_CAPABILITIES);
const platformSet = new Set<string>(OPENDESK_PLUGIN_PLATFORMS);
const pluginIdPattern = /^[a-zA-Z][a-zA-Z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function optionalString(value: unknown, code: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(code);
    return value.trim();
}

function optionalBoolean(value: unknown, code: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw new Error(code);
    return value;
}

/** 版本类字段：非空且必须是合法 SemVer（允许 `v` 前缀与首尾空白） */
function optionalVersion(value: unknown, code: string): string | undefined {
    const text = optionalString(value, code);
    if (text === undefined) return undefined;
    if (!isValidVersion(text)) throw new Error(code);
    return text;
}

/**
 * 解析本地化文本（displayName / description 通用）：
 * 支持简单字符串或 { "en": "...", "zh": "..." } 形式的本地化对象。
 * 对象键归一化为主语言标签（如 zh-CN -> zh），值必须为非空字符串。
 */
function optionalLocalizedText(value: unknown, code: string): PluginLocalizedText | undefined {
    if (value === undefined) return undefined;
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) throw new Error(code);
        return trimmed;
    }
    if (!isRecord(value)) throw new Error(code);
    const localized: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== 'string' || !entry.trim()) throw new Error(code);
        const tag = localePrimaryTag(key);
        if (!tag) throw new Error(code);
        localized[tag] = entry.trim();
    }
    if (Object.keys(localized).length === 0) throw new Error(code);
    return localized;
}

function requiredString(value: unknown, code: string): string {
    const parsed = optionalString(value, code);
    if (!parsed) throw new Error(code);
    return parsed;
}

function optionalStringArray(value: unknown, code: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
        throw new Error(code);
    }
    return value.map((entry) => entry.trim());
}

function optionalStringRecord(value: unknown, code: string): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || Object.values(value).some((entry) => typeof entry !== 'string')) {
        throw new Error(code);
    }
    return Object.fromEntries(Object.entries(value) as Array<[string, string]>);
}

function parseCapabilities(value: unknown): PluginCapability[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((capability) => typeof capability !== 'string')) {
        throw new Error('plugin.manifest_invalid_capabilities');
    }
    const capabilities = [...new Set(value as string[])];
    if (capabilities.some((capability) => !capabilitySet.has(capability))) {
        throw new Error('plugin.manifest_unknown_capability');
    }
    return capabilities as PluginCapability[];
}

function parsePlatforms(value: unknown): PluginPlatform[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((platform) => typeof platform !== 'string')) {
        throw new Error('plugin.manifest_invalid_platforms');
    }
    const platforms = [...new Set(value as string[])];
    if (platforms.some((platform) => !platformSet.has(platform))) {
        throw new Error('plugin.manifest_unknown_platform');
    }
    return platforms as PluginPlatform[];
}

function parseMcpServer(value: unknown): PluginMcpServerDefinition {
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid_mcp_server');
    const name = requiredString(value.name, 'plugin.manifest_invalid_mcp_name');
    const transport = requiredString(value.transport, 'plugin.manifest_invalid_mcp_transport');
    if (transport === 'stdio') {
        return {
            name,
            transport,
            command: requiredString(value.command, 'plugin.manifest_invalid_mcp_command'),
            args: optionalStringArray(value.args, 'plugin.manifest_invalid_mcp_args'),
            cwd: optionalString(value.cwd, 'plugin.manifest_invalid_mcp_cwd'),
            env: optionalStringRecord(value.env, 'plugin.manifest_invalid_mcp_env')
        };
    }
    if (transport !== 'sse' && transport !== 'streamableHttp') {
        throw new Error('plugin.manifest_invalid_mcp_transport');
    }
    const url = requiredString(value.url, 'plugin.manifest_invalid_mcp_url');
    try {
        new URL(url);
    } catch {
        throw new Error('plugin.manifest_invalid_mcp_url');
    }
    return {
        name,
        transport,
        url,
        headers: optionalStringRecord(value.headers, 'plugin.manifest_invalid_mcp_headers')
    };
}

/**
 * 解析作者信息（可选）。
 *
 * name 必填、institution 可选的本地化文本；homepage 只能是 http(s) 地址，
 * 免得界面上出现 `javascript:` 之类可点击的危险链接。
 */
function parsePluginAuthor(value: unknown): PluginAuthor | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid_author');
    const name = optionalLocalizedText(value.name, 'plugin.manifest_invalid_author');
    if (!name) throw new Error('plugin.manifest_invalid_author');
    const homepage = optionalString(value.homepage, 'plugin.manifest_invalid_author');
    if (homepage) {
        let url: URL;
        try {
            url = new URL(homepage);
        } catch {
            throw new Error('plugin.manifest_invalid_author');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new Error('plugin.manifest_invalid_author');
        }
    }
    return {
        name,
        institution: optionalLocalizedText(value.institution, 'plugin.manifest_invalid_author'),
        homepage
    };
}

/**
 * 解析插件自身的站点地址（可选）。
 *
 * 只接受 http(s)：这条信息会作为可点链接展示在插件详情里，
 * 放行 `javascript:` 之类的协议等于给清单作者一个注入入口。
 */
function parseHomepage(value: unknown): string | undefined {
    const text = optionalString(value, 'plugin.manifest_invalid_homepage');
    if (text === undefined) return undefined;
    let url: URL;
    try {
        url = new URL(text);
    } catch {
        throw new Error('plugin.manifest_invalid_homepage');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('plugin.manifest_invalid_homepage');
    }
    return text;
}

/**
 * 解析插件图标地址（可选）：http(s) 图片链接，或指向插件根目录内文件的相对路径。
 *
 * 图标只在界面上当图片显示，但相对路径会由宿主读文件（转成渲染层可显示的 data URL），
 * 所以绝对路径、根相对路径与目录穿越都要拦下——写坏时让清单加载失败，
 * 而不是悄悄读到了插件目录外的文件。校验与打包期 schema 共用 SDK 的同一个实现，口径不会漂移。
 */
function parseIconUrl(value: unknown): string | undefined {
    const text = optionalString(value, 'plugin.manifest_invalid_icon_url');
    if (text === undefined) return undefined;
    if (!isValidPluginIconUrl(text)) throw new Error('plugin.manifest_invalid_icon_url');
    return text;
}

function parseResources(value: unknown): PluginManifestResources | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid_resources');
    const skills = optionalStringArray(value.skills, 'plugin.manifest_invalid_skills');
    let mcpServers: PluginMcpServerDefinition[] | undefined;
    if (value.mcpServers !== undefined) {
        if (!Array.isArray(value.mcpServers)) throw new Error('plugin.manifest_invalid_mcp_servers');
        mcpServers = value.mcpServers.map(parseMcpServer);
    }
    const agents = optionalStringArray(value.agents, 'plugin.manifest_invalid_agents');
    const locales = optionalStringArray(value.locales, 'plugin.manifest_invalid_locales');
    return {
        skills,
        mcpServers,
        agents,
        locales
    };
}

export function parsePluginManifest(value: unknown): PluginManifest {
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid');
    const apiVersion = value.apiVersion ?? OPENDESK_PLUGIN_API_VERSION;
    if (!Number.isInteger(apiVersion) || (apiVersion as number) <= 0) {
        throw new Error('plugin.manifest_invalid_api_version');
    }
    const id = optionalString(value.id, 'plugin.manifest_invalid_id');
    if (id && !pluginIdPattern.test(id)) throw new Error('plugin.manifest_invalid_id');
    const capabilities = parseCapabilities(value.capabilities);
    const platforms = parsePlatforms(value.platforms);
    const resources = parseResources(value.resources);
    if (capabilities && resources?.skills?.length && !capabilities.includes('skill')) {
        throw new Error('plugin.manifest_resource_capability_missing:skill');
    }
    if (capabilities && resources?.mcpServers?.length && !capabilities.includes('mcp')) {
        throw new Error('plugin.manifest_resource_capability_missing:mcp');
    }
    if (capabilities && resources?.agents?.length && !capabilities.includes('agent')) {
        throw new Error('plugin.manifest_resource_capability_missing:agent');
    }
    if (capabilities && resources?.locales?.length && !capabilities.includes('locale')) {
        throw new Error('plugin.manifest_resource_capability_missing:locale');
    }
    return {
        entry: optionalString(value.entry, 'plugin.manifest_invalid_entry'),
        id,
        displayName: optionalLocalizedText(value.displayName, 'plugin.manifest_invalid_display_name'),
        description: optionalLocalizedText(value.description, 'plugin.manifest_invalid_description'),
        version: optionalVersion(value.version, 'plugin.manifest_invalid_version'),
        category: optionalStringArray(value.category, 'plugin.manifest_invalid_category'),
        author: parsePluginAuthor(value.author),
        homepage: parseHomepage(value.homepage),
        iconUrl: parseIconUrl(value.iconUrl),
        apiVersion: apiVersion as number,
        capabilities,
        platforms,
        minOpenDeskVersion: optionalVersion(value.minOpenDeskVersion, 'plugin.manifest_invalid_min_opendesk_version'),
        maxOpenDeskVersion: optionalVersion(value.maxOpenDeskVersion, 'plugin.manifest_invalid_max_opendesk_version'),
        resources,
        system: optionalBoolean(value.system, 'plugin.manifest_invalid_system'),
        enabled: optionalBoolean(value.enabled, 'plugin.manifest_invalid_enabled')
    };
}

/** 清单里声明的启停控制字段（原始 JSON 或已解析清单皆可） */
export interface PluginManifestControlFields {
    /** 由清单固定启停：pluginmgr 不允许修改该插件的开关 */
    system: boolean;
    /** system 为 true 时的固定状态：true（默认）恒启用，false 恒禁用 */
    enabled?: boolean;
}

/**
 * 解析清单里的启停控制字段。
 *
 * `system` / `enabled` 只对内置插件生效：后装插件（plugins 目录、外部路径、运行时目录）
 * 即使声明了也不能锁住自己的开关，加载时由 loader 记 warning 后忽略。
 */
export function resolveManifestControlFields(
    declaration: { system?: unknown; enabled?: unknown } | undefined,
    options: { builtin: boolean }
): PluginManifestControlFields | undefined {
    if (!options.builtin || !declaration) return undefined;
    if (declaration.system === undefined && declaration.enabled === undefined) return undefined;
    return {
        system: declaration.system === true,
        enabled: typeof declaration.enabled === 'boolean' ? declaration.enabled : undefined
    };
}

/** 清单是否声明了 system / enabled（不区分来源，用于给后装插件打 warning） */
export function declaresManifestControlFields(manifest: PluginManifest | undefined): boolean {
    return manifest?.system !== undefined || manifest?.enabled !== undefined;
}

/**
 * 轻量读取插件位置上的清单声明（不解析、不校验），用于只关心个别字段的场景。
 * 与 readPluginManifest 的查找顺序一致：根目录 opendesk.plugin.json 优先，其次入口
 * 同名清单，最后 package.json#opendesk 声明。顺序或回落路径不一致会导致 discovery
 * 与加载/GUI 列表对同一插件采信不同清单（如 package 声明的内置插件锁定状态分裂）。
 * 清单不可读或不是合法 JSON 时返回 undefined：这类问题留给加载阶段报 plugin.* 诊断。
 */
export function readManifestDeclaration(spec: string): Record<string, unknown> | undefined {
    try {
        const stat = fs.statSync(spec);
        const root = stat.isDirectory() ? spec : path.dirname(spec);
        const basename = path.basename(spec, stat.isFile() ? path.extname(spec) : undefined);
        const readIfExists = (file: string) => (fs.existsSync(file) ? readJson(file) : undefined);
        const directoryManifest = readIfExists(path.join(root, 'opendesk.plugin.json'));
        const sidecar = stat.isFile()
            ? (readIfExists(path.join(root, `${basename}.opendesk.plugin.json`)) ??
              readIfExists(path.join(root, `${basename}.plugin.json`)))
            : undefined;
        const packageManifest = () => {
            const packageJson = readIfExists(path.join(root, 'package.json'));
            return isRecord(packageJson) && isRecord(packageJson.opendesk) ? packageJson.opendesk : undefined;
        };
        const declared = directoryManifest ?? sidecar ?? packageManifest();
        return isRecord(declared) ? declared : undefined;
    } catch {
        return undefined;
    }
}

function readJson(file: string): unknown {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as unknown;
}

function manifestFromPackageJson(rootDir: string): PluginManifest | undefined {
    const file = path.join(rootDir, 'package.json');
    if (!fs.existsSync(file)) return undefined;
    const packageJson = readJson(file);
    if (!isRecord(packageJson) || !isRecord(packageJson.opendesk)) return undefined;
    const declaration = packageJson.opendesk;
    const manifestFields = {
        entry: declaration.plugin,
        id: declaration.id,
        displayName: declaration.displayName,
        description: declaration.description,
        version: declaration.version ?? packageJson.version,
        category: declaration.category,
        author: declaration.author,
        homepage: declaration.homepage,
        iconUrl: declaration.iconUrl,
        apiVersion: declaration.apiVersion,
        capabilities: declaration.capabilities,
        minOpenDeskVersion: declaration.minOpenDeskVersion,
        maxOpenDeskVersion: declaration.maxOpenDeskVersion,
        resources: declaration.resources,
        system: declaration.system,
        enabled: declaration.enabled
    };
    return parsePluginManifest(manifestFields);
}

export function readPluginManifest(entry: string, rootDir: string): PluginManifest | undefined {
    const directoryManifest = path.join(rootDir, 'opendesk.plugin.json');
    const canonicalFileManifest = path.join(
        path.dirname(entry),
        `${path.basename(entry, path.extname(entry))}.opendesk.plugin.json`
    );
    const legacyFileManifest = path.join(
        path.dirname(entry),
        `${path.basename(entry, path.extname(entry))}.plugin.json`
    );
    if (fs.existsSync(directoryManifest)) return parsePluginManifest(readJson(directoryManifest));
    if (fs.existsSync(canonicalFileManifest)) return parsePluginManifest(readJson(canonicalFileManifest));
    if (fs.existsSync(legacyFileManifest)) return parsePluginManifest(readJson(legacyFileManifest));
    return manifestFromPackageJson(rootDir);
}

/**
 * 读取纯静态插件（无可运行入口）的清单：仅认根级 opendesk.plugin.json 或
 * package.json#opendesk 声明。语言包等纯声明贡献插件没有入口文件，
 * 由 loader 据此合成最小插件对象，跳过动态 import。
 */
export function readStaticOnlyPluginManifest(rootDir: string): PluginManifest | undefined {
    const directoryManifest = path.join(rootDir, 'opendesk.plugin.json');
    if (fs.existsSync(directoryManifest)) return parsePluginManifest(readJson(directoryManifest));
    return manifestFromPackageJson(rootDir);
}

export function applyPluginManifest(plugin: OpenDeskPlugin, manifest?: PluginManifest): OpenDeskPlugin {
    if (!manifest) return plugin;
    if (manifest.id && manifest.id !== plugin.id) throw new Error('plugin.manifest_id_mismatch');
    return {
        ...plugin,
        displayName: plugin.displayName ?? manifest.displayName,
        description: plugin.description ?? manifest.description,
        version: plugin.version ?? manifest.version,
        category: plugin.category ?? manifest.category,
        author: plugin.author ?? manifest.author,
        homepage: plugin.homepage ?? manifest.homepage,
        apiVersion: plugin.apiVersion ?? manifest.apiVersion,
        capabilities: plugin.capabilities ?? manifest.capabilities,
        platforms: plugin.platforms ?? manifest.platforms,
        minOpenDeskVersion: plugin.minOpenDeskVersion ?? manifest.minOpenDeskVersion,
        maxOpenDeskVersion: plugin.maxOpenDeskVersion ?? manifest.maxOpenDeskVersion
    };
}

function isPathInside(root: string, target: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

function resolveManifestPath(rootDir: string, declaredPath: string, code: string): string {
    if (path.isAbsolute(declaredPath)) throw new Error(`${code}:absolute`);
    const resolved = path.resolve(rootDir, declaredPath);
    if (!isPathInside(rootDir, resolved)) throw new Error(`${code}:outside_root`);
    if (!fs.existsSync(resolved)) throw new Error(`${code}:not_found`);
    const realRoot = fs.realpathSync(rootDir);
    const realResolved = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, realResolved)) throw new Error(`${code}:outside_root`);
    return realResolved;
}

function findManifestSkillDirectories(rootDir: string, declaredPath: string): string[] {
    const resolved = resolveManifestPath(rootDir, declaredPath, 'plugin.manifest_skill_path_invalid');
    if (!fs.statSync(resolved).isDirectory()) throw new Error('plugin.manifest_skill_path_invalid:not_directory');
    if (fs.existsSync(path.join(resolved, SKILL_MD_FILENAME))) return [resolved];
    const directories = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .map((entry) => path.join(resolved, entry.name))
        .filter((directory) => {
            const safeDirectory = resolveManifestPath(
                resolved,
                path.relative(resolved, directory),
                'plugin.manifest_skill_path_invalid'
            );
            return (
                fs.statSync(safeDirectory).isDirectory() && fs.existsSync(path.join(safeDirectory, SKILL_MD_FILENAME))
            );
        })
        .sort();
    if (directories.length === 0) throw new Error(`plugin.manifest_skill_not_found:${declaredPath}`);
    return directories;
}

function loadManifestSkill(directory: string) {
    const skill = Skill.parseMd(fs.readFileSync(path.join(directory, SKILL_MD_FILENAME), 'utf-8'));
    return {
        name: skill.frontmatter.name,
        description: skill.frontmatter.description,
        body: skill.body,
        directory,
        frontmatter: { ...skill.frontmatter },
        userInvocable: skill.isUserInvocable,
        modelInvocable: skill.isModelInvocable
    };
}

function resolveManifestMcpServer(rootDir: string, definition: PluginMcpServerDefinition): PluginMcpServerDefinition {
    if (definition.transport !== 'stdio') return definition;
    let command = definition.command;
    if (command.startsWith('./') || command.startsWith('../')) {
        command = resolveManifestPath(rootDir, command, 'plugin.manifest_mcp_command_invalid');
        if (!fs.statSync(command).isFile()) throw new Error('plugin.manifest_mcp_command_invalid:not_file');
    }
    let cwd = definition.cwd;
    if (cwd !== undefined) {
        cwd = resolveManifestPath(rootDir, cwd, 'plugin.manifest_mcp_cwd_invalid');
        if (!fs.statSync(cwd).isDirectory()) throw new Error('plugin.manifest_mcp_cwd_invalid:not_directory');
    }
    return {
        ...definition,
        command,
        cwd
    };
}

/**
 * 单个语言包文件大小上限，与插件 appearance logo 上限（runtime/appearance.ts 的
 * APPEARANCE_LOGO_MAX_BYTES = 2MB）对齐；超限跳过该文件并告警，不阻断整个插件。
 */
const LOCALE_PACK_MAX_BYTES = 2 * 1024 * 1024;

/** 收集一个语言包声明路径下的语言包文件：单文件直接返回，目录收集 *.json（排序保证确定性） */
function findLocalePackFiles(rootDir: string, declaredPath: string): string[] {
    const resolved = resolveManifestPath(rootDir, declaredPath, 'plugin.manifest_locale_path_invalid');
    const stat = fs.statSync(resolved);
    if (stat.isFile()) {
        if (!resolved.toLowerCase().endsWith('.json')) {
            throw new Error('plugin.manifest_locale_path_invalid:not_json');
        }
        return [resolved];
    }
    if (!stat.isDirectory()) throw new Error('plugin.manifest_locale_path_invalid:not_directory');
    const files = fs
        .readdirSync(resolved, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
        .map((entry) => path.join(resolved, entry.name))
        .sort();
    if (files.length === 0) throw new Error(`plugin.manifest_locale_not_found:${declaredPath}`);
    return files;
}

/**
 * 装载语言包：每个 JSON 文件的文件名即语言 tag（经 Intl.Locale 规范化），
 * 文件内为扁平 string -> string 词条（结构校验见 parseLocalePackJson）。
 * 同一插件内同一 tag 声明两次视为清单歧义，直接报错。
 */
function loadLocalePacks(rootDir: string, declaredPaths: string[]): PluginLocalePackDefinition[] {
    const packs: PluginLocalePackDefinition[] = [];
    const tagsBySource = new Map<string, string>();
    for (const declaredPath of declaredPaths) {
        for (const file of findLocalePackFiles(rootDir, declaredPath)) {
            if (fs.statSync(file).size > LOCALE_PACK_MAX_BYTES) {
                const relative = path.relative(rootDir, file).split(path.sep).join('/');
                console.warn(
                    `[pluginmgr] locale pack file exceeds ${LOCALE_PACK_MAX_BYTES} bytes, skipped: ${relative}`
                );
                continue;
            }
            let content: LocalePackContent;
            try {
                content = parseLocalePackJson(readJson(file), file);
            } catch (error) {
                if (error instanceof LocalePackParseError) throw error;
                throw new LocalePackParseError('locale pack is not valid JSON', file);
            }
            const existing = tagsBySource.get(content.tag);
            if (existing) throw new Error(`plugin.manifest_locale_tag_conflict:${content.tag} (${existing})`);
            tagsBySource.set(content.tag, path.relative(rootDir, file).split(path.sep).join('/'));
            packs.push({
                tag: content.tag,
                fallback: content.fallback,
                priority: content.priority,
                entries: content.entries,
                sourceFile: path.relative(rootDir, file).split(path.sep).join('/')
            });
        }
    }
    return packs;
}

export function loadPluginResources(manifest: PluginManifest | undefined, rootDir: string): PluginStaticResources {
    const skills = manifest?.resources?.skills?.flatMap((declaredPath) =>
        findManifestSkillDirectories(rootDir, declaredPath).map(loadManifestSkill)
    );
    const mcpServers = manifest?.resources?.mcpServers?.map((definition) =>
        resolveManifestMcpServer(rootDir, definition)
    );
    const agents = manifest?.resources?.agents?.flatMap((declaredPath) =>
        loadAgentsFromDirectory(rootDir, declaredPath, AGENT_MANIFEST_ERROR_CODES)
    );
    const locales =
        manifest?.resources?.locales && manifest.resources.locales.length > 0
            ? loadLocalePacks(rootDir, manifest.resources.locales)
            : undefined;
    return {
        skills,
        mcpServers,
        agents,
        locales
    };
}
