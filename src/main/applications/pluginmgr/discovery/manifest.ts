/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import { Skill, SKILL_MD_FILENAME } from '../../../aikernel/skill.js';
import {
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_CAPABILITIES,
    OPENDESK_PLUGIN_PLATFORMS,
    type OpenDeskPlugin,
    type PluginCapability,
    type PluginMcpServerDefinition,
    type PluginPlatform,
    type PluginStaticContributions
} from '../../../../../packages/plugin-sdk/src/index.js';

export interface PluginManifestContributions {
    skills?: string[];
    mcpServers?: PluginMcpServerDefinition[];
}

export interface PluginManifest {
    schemaVersion: 1;
    entry?: string;
    id?: string;
    displayName?: string;
    version?: string;
    apiVersion: number;
    capabilities?: PluginCapability[];
    platforms?: PluginPlatform[];
    minOpenDeskVersion?: string;
    maxOpenDeskVersion?: string;
    contributions?: PluginManifestContributions;
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

function parseContributions(value: unknown): PluginManifestContributions | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid_contributions');
    const skills = optionalStringArray(value.skills, 'plugin.manifest_invalid_skills');
    let mcpServers: PluginMcpServerDefinition[] | undefined;
    if (value.mcpServers !== undefined) {
        if (!Array.isArray(value.mcpServers)) throw new Error('plugin.manifest_invalid_mcp_servers');
        mcpServers = value.mcpServers.map(parseMcpServer);
    }
    return {
        skills,
        mcpServers
    };
}

export function parsePluginManifest(value: unknown): PluginManifest {
    if (!isRecord(value)) throw new Error('plugin.manifest_invalid');
    const schemaVersion = value.schemaVersion ?? 1;
    if (schemaVersion !== 1) throw new Error('plugin.manifest_schema_unsupported');
    const apiVersion = value.apiVersion ?? OPENDESK_PLUGIN_API_VERSION;
    if (!Number.isInteger(apiVersion) || (apiVersion as number) <= 0) {
        throw new Error('plugin.manifest_invalid_api_version');
    }
    const id = optionalString(value.id, 'plugin.manifest_invalid_id');
    if (id && !pluginIdPattern.test(id)) throw new Error('plugin.manifest_invalid_id');
    const capabilities = parseCapabilities(value.capabilities);
    const platforms = parsePlatforms(value.platforms);
    const contributions = parseContributions(value.contributions);
    if (capabilities && contributions?.skills?.length && !capabilities.includes('skill')) {
        throw new Error('plugin.manifest_contribution_capability_missing:skill');
    }
    if (capabilities && contributions?.mcpServers?.length && !capabilities.includes('mcp')) {
        throw new Error('plugin.manifest_contribution_capability_missing:mcp');
    }
    return {
        schemaVersion: 1,
        entry: optionalString(value.entry, 'plugin.manifest_invalid_entry'),
        id,
        displayName: optionalString(value.displayName, 'plugin.manifest_invalid_display_name'),
        version: optionalString(value.version, 'plugin.manifest_invalid_version'),
        apiVersion: apiVersion as number,
        capabilities,
        platforms,
        minOpenDeskVersion: optionalString(value.minOpenDeskVersion, 'plugin.manifest_invalid_min_opendesk_version'),
        maxOpenDeskVersion: optionalString(value.maxOpenDeskVersion, 'plugin.manifest_invalid_max_opendesk_version'),
        contributions
    };
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
        schemaVersion: declaration.schemaVersion,
        entry: declaration.plugin,
        id: declaration.id,
        displayName: declaration.displayName,
        version: declaration.version ?? packageJson.version,
        apiVersion: declaration.apiVersion,
        capabilities: declaration.capabilities,
        minOpenDeskVersion: declaration.minOpenDeskVersion,
        maxOpenDeskVersion: declaration.maxOpenDeskVersion,
        contributions: declaration.contributions
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

export function applyPluginManifest(plugin: OpenDeskPlugin, manifest?: PluginManifest): OpenDeskPlugin {
    if (!manifest) return plugin;
    if (manifest.id && manifest.id !== plugin.id) throw new Error('plugin.manifest_id_mismatch');
    return {
        ...plugin,
        displayName: plugin.displayName ?? manifest.displayName,
        version: plugin.version ?? manifest.version,
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

export function loadPluginContributions(
    manifest: PluginManifest | undefined,
    rootDir: string
): PluginStaticContributions {
    const skills = manifest?.contributions?.skills?.flatMap((declaredPath) =>
        findManifestSkillDirectories(rootDir, declaredPath).map(loadManifestSkill)
    );
    const mcpServers = manifest?.contributions?.mcpServers?.map((definition) =>
        resolveManifestMcpServer(rootDir, definition)
    );
    return {
        skills,
        mcpServers
    };
}

function parseVersion(value: string): [number, number, number] | undefined {
    const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function comparePluginVersions(left: string, right: string): number | undefined {
    const a = parseVersion(left);
    const b = parseVersion(right);
    if (!a || !b) return undefined;
    for (let index = 0; index < a.length; index++) {
        if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
    }
    return 0;
}
