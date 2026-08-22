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

const PluginContributionsSchema = z.object({
    skills: z.array(z.string().min(1)).optional(),
    mcpServers: z.array(McpServerSchema).optional()
});

export const OpenDeskPluginManifestSchema = z.object({
    entry: z.string().min(1),
    schemaVersion: z.literal(1).default(1),
    id: z
        .string()
        .regex(/^[a-zA-Z][a-zA-Z0-9._-]*$/)
        .optional(),
    displayName: z.string().min(1).optional(),
    version: z.string().min(1).optional(),
    apiVersion: z.literal(OPENDESK_PLUGIN_API_VERSION),
    capabilities: z.array(z.enum(OPENDESK_PLUGIN_CAPABILITIES)),
    platforms: z.array(z.enum(OPENDESK_PLUGIN_PLATFORMS)).optional(),
    minOpenDeskVersion: z.string().min(1).optional(),
    maxOpenDeskVersion: z.string().min(1).optional(),
    contributions: PluginContributionsSchema.optional()
});

const PackagePluginDeclarationSchema = OpenDeskPluginManifestSchema.omit({ entry: true }).extend({
    plugin: z.string().min(1)
});

export interface ValidatedOpenDeskPluginPackage {
    id: string;
    name: string;
    version: string;
    entry: string;
    apiVersion: number;
    capabilities: string[];
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
    assertSafeRelativePath(declaration.entry);
    const entry = path.resolve(directory, declaration.entry);
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile()) {
        throw new OpenDeskPluginPackageError(
            'plugin_structure_invalid',
            `plugin entry not found: ${declaration.entry}`
        );
    }
    for (const skillPath of declaration.contributions?.skills ?? []) {
        assertSafeRelativePath(skillPath);
        const skillDirectory = path.resolve(directory, skillPath);
        if (!fs.existsSync(skillDirectory) || !fs.statSync(skillDirectory).isDirectory()) {
            throw new OpenDeskPluginPackageError(
                'plugin_structure_invalid',
                `plugin skill path not found: ${skillPath}`
            );
        }
    }
    for (const server of declaration.contributions?.mcpServers ?? []) {
        if (server.transport !== 'stdio') continue;
        if (server.command.startsWith('./') || server.command.startsWith('../')) {
            assertSafeRelativePath(server.command);
        }
        if (server.cwd) assertSafeRelativePath(server.cwd);
    }
    if (declaration.contributions?.skills?.length && !declaration.capabilities.includes('skill')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin skill contribution requires the skill capability'
        );
    }
    if (declaration.contributions?.mcpServers?.length && !declaration.capabilities.includes('mcp')) {
        throw new OpenDeskPluginPackageError(
            'plugin_manifest_invalid',
            'plugin MCP contribution requires the mcp capability'
        );
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
        capabilities: [...declaration.capabilities]
    };
}

export function validateOpenDeskPluginPackage(directory: string): ValidatedOpenDeskPluginPackage {
    return validatePluginDirectory(directory, true);
}

export function validateOpenDeskPluginDirectory(directory: string): ValidatedOpenDeskPluginPackage {
    return validatePluginDirectory(directory, false);
}
