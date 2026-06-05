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

import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { getAppDirectory } from '../../utils/setting.js';
import { logger } from '../../utils/logger.js';
import type { OpenDeskAppManifest } from '../base.js';

const BundleNameSchema = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/);

export const AppManifestSchema = z.object({
    schemaVersion: z.literal(1),
    bundleName: BundleNameSchema,
    displayName: z.string().min(1),
    versionName: z.string().min(1),
    entry: z.string().min(1),
    icon: z.string().optional(),
    description: z.string().optional(),
    skills: z.array(z.string()).optional(),
    permissions: z.array(z.string()).optional()
});

export interface UserAppVersionRecord {
    versionId: string;
    versionName: string;
    parentVersionId: string | null;
    codePath: string;
    manifest: OpenDeskAppManifest;
    createdAt: string;
}

export interface UserAppRecord {
    bundleName: string;
    displayName: string;
    description?: string;
    iconPath?: string;
    active: boolean;
    currentVersionId: string;
    versions: UserAppVersionRecord[];
    createdAt: string;
    updatedAt: string;
}

export interface AppMgrState {
    schemaVersion: 1;
    apps: UserAppRecord[];
}

export interface InstallAppResult {
    app: UserAppRecord;
    version: UserAppVersionRecord;
}

const STATE_SCHEMA_VERSION = 1;
const FALLBACK_ICON_PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAAeRJREFUeNrs3MFtwjAQQFEj9V+5QDcIF+gcqAPkAqUD5AKlAqUCSgVOHDgY5VgQwsPP8JvZkqH5yXJkZAAAAAAAAPg7rVZr8vF4nIYx3nU6nf3z+fy3LMvu7XZ7Hcc5hmEYtnEcV9vb2+M4zhzHmZ2dnXEcZ/v7+8MwDPv9/t3pdAqgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgAQgATwDgAB3fA6C4i/vhwAAAABJRU5ErkJggg==';

function normalizePathForUrl(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

export function getAppMgrDirectory(): string {
    return path.join(getAppDirectory(), 'appmgr');
}

export function getManagedAppsDirectory(): string {
    return path.join(getAppMgrDirectory(), 'apps');
}

export function getAppMgrStateFilePath(): string {
    return path.join(getAppMgrDirectory(), 'apps.json');
}

export function createVersionId(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

export function validateBundleName(bundleName: string): void {
    BundleNameSchema.parse(bundleName);
}

function ensureDirectories(): void {
    fs.mkdirSync(getManagedAppsDirectory(), { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
    if (!fs.existsSync(filePath)) {
        return fallback;
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
    } catch (error) {
        logger.warn(`[appmgr] failed to read ${filePath}: ${error}`);
        return fallback;
    }
}

function writeJsonFile(filePath: string, data: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 4), 'utf-8');
    fs.renameSync(tmpPath, filePath);
}

function isSafeRelativePath(relPath: string): boolean {
    if (!relPath || path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
        return false;
    }
    return !relPath.split(/[\\/]+/).includes('..');
}

function assertSafeRelativePath(relPath: string): void {
    if (!isSafeRelativePath(relPath)) {
        throw new Error(`Unsafe app package path: ${relPath}`);
    }
}

function assertPathInside(baseDir: string, targetPath: string): void {
    const base = path.resolve(baseDir);
    const target = path.resolve(targetPath);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
        throw new Error(`Unsafe extraction target: ${targetPath}`);
    }
}

function getEntryText(zip: AdmZip, entryName: string): string | null {
    const entry = zip.getEntry(entryName);
    if (!entry || entry.isDirectory) {
        return null;
    }
    return entry.getData().toString('utf-8');
}

function readManifestFromDirectory(sourceDir: string): OpenDeskAppManifest {
    const manifestPath = path.join(sourceDir, 'opendesk-app.json');
    if (!fs.existsSync(manifestPath)) {
        throw new Error('opendesk-app.json not found');
    }
    return AppManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
}

function readManifestFromZip(zip: AdmZip): OpenDeskAppManifest {
    const manifestText = getEntryText(zip, 'opendesk-app.json');
    if (!manifestText) {
        throw new Error('opendesk-app.json not found in app package');
    }
    return AppManifestSchema.parse(JSON.parse(manifestText));
}

export function readAppManifestFromZipFile(zipPath: string): OpenDeskAppManifest {
    if (!fs.existsSync(zipPath)) {
        throw new Error(`zip file not found: ${zipPath}`);
    }
    return readManifestFromZip(new AdmZip(zipPath));
}

function extractZipSafely(zip: AdmZip, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of zip.getEntries()) {
        const entryName = entry.entryName.replace(/\\/g, '/');
        assertSafeRelativePath(entryName);
        const targetPath = path.join(targetDir, entryName);
        assertPathInside(targetDir, targetPath);
        if (entry.isDirectory) {
            fs.mkdirSync(targetPath, { recursive: true });
        } else {
            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            fs.writeFileSync(targetPath, entry.getData());
        }
    }
}

function copyDirectory(sourceDir: string, targetDir: string): void {
    fs.mkdirSync(targetDir, { recursive: true });
    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        const sourcePath = path.join(sourceDir, entry.name);
        const targetPath = path.join(targetDir, entry.name);
        if (entry.isDirectory()) {
            copyDirectory(sourcePath, targetPath);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function removeDirectoryIfExists(dirPath: string): void {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

function removeDirectoryIfEmpty(dirPath: string): void {
    if (fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory() && fs.readdirSync(dirPath).length === 0) {
        fs.rmdirSync(dirPath);
    }
}

function writeFallbackIcon(iconPath: string): void {
    fs.mkdirSync(path.dirname(iconPath), { recursive: true });
    fs.writeFileSync(iconPath, Buffer.from(FALLBACK_ICON_PNG_BASE64, 'base64'));
}

function copyIconFromVersion(appDir: string, versionDir: string, manifest: OpenDeskAppManifest): string {
    const targetIconPath = path.join(appDir, 'icon.png');
    if (!manifest.icon) {
        if (!fs.existsSync(targetIconPath)) {
            writeFallbackIcon(targetIconPath);
        }
        return targetIconPath;
    }
    assertSafeRelativePath(manifest.icon);
    const sourceIconPath = path.join(versionDir, manifest.icon);
    assertPathInside(versionDir, sourceIconPath);
    if (!fs.existsSync(sourceIconPath)) {
        throw new Error(`icon file not found: ${manifest.icon}`);
    }
    fs.mkdirSync(appDir, { recursive: true });
    fs.copyFileSync(sourceIconPath, targetIconPath);
    return targetIconPath;
}

export function appIconUrl(bundleName: string): string {
    return `opendesk-app://${bundleName}/icon.png`;
}

export function appEntryUrl(app: UserAppRecord, versionId: string = app.currentVersionId): string {
    const version = app.versions.find((item) => item.versionId === versionId);
    if (!version) {
        throw new Error(`version ${versionId} not found for ${app.bundleName}`);
    }
    return `opendesk-app://${app.bundleName}/${version.versionId}/${version.manifest.entry}?applicationBundleName=${encodeURIComponent(app.bundleName)}`;
}

export function toPublicUserApp(app: UserAppRecord): Record<string, unknown> {
    return {
        bundleName: app.bundleName,
        name: app.displayName,
        displayName: app.displayName,
        description: app.description || '',
        showIcon: app.active,
        iconUrl: appIconUrl(app.bundleName),
        entryUrl: appEntryUrl(app),
        source: 'user',
        removable: true,
        active: app.active,
        currentVersionId: app.currentVersionId,
        versions: app.versions.map((version) => ({
            versionId: version.versionId,
            versionName: version.versionName,
            parentVersionId: version.parentVersionId,
            codePath: normalizePathForUrl(version.codePath),
            createdAt: version.createdAt
        }))
    };
}

export class AppManagerStore {
    static loadState(): AppMgrState {
        ensureDirectories();
        const state = readJsonFile<AppMgrState>(getAppMgrStateFilePath(), {
            schemaVersion: STATE_SCHEMA_VERSION,
            apps: []
        });
        if (state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.apps)) {
            return { schemaVersion: STATE_SCHEMA_VERSION, apps: [] };
        }
        return state;
    }

    static saveState(state: AppMgrState): void {
        writeJsonFile(getAppMgrStateFilePath(), state);
    }

    static listApps(): UserAppRecord[] {
        return this.loadState().apps;
    }

    static listActiveApps(): UserAppRecord[] {
        return this.listApps().filter((app) => app.active);
    }

    static getApp(bundleName: string): UserAppRecord | undefined {
        return this.listApps().find((app) => app.bundleName === bundleName);
    }

    static getAppOrThrow(bundleName: string): UserAppRecord {
        const app = this.getApp(bundleName);
        if (!app) {
            throw new Error(`application ${bundleName} not found`);
        }
        return app;
    }

    static installFromZip(zipPath: string): InstallAppResult {
        ensureDirectories();
        if (!fs.existsSync(zipPath)) {
            throw new Error(`zip file not found: ${zipPath}`);
        }
        const zip = new AdmZip(zipPath);
        const manifest = readManifestFromZip(zip);
        assertSafeRelativePath(manifest.entry);
        if (manifest.icon) assertSafeRelativePath(manifest.icon);

        const state = this.loadState();
        const existing = state.apps.find((app) => app.bundleName === manifest.bundleName);
        const appDir = path.join(getManagedAppsDirectory(), manifest.bundleName);
        const versionId = createVersionId();
        const tmpDir = path.join(appDir, `.install-${versionId}`);
        const versionDir = path.join(appDir, versionId);
        removeDirectoryIfExists(tmpDir);
        removeDirectoryIfExists(versionDir);

        try {
            extractZipSafely(zip, tmpDir);
            const entryPath = path.join(tmpDir, manifest.entry);
            assertPathInside(tmpDir, entryPath);
            if (!fs.existsSync(entryPath)) {
                throw new Error(`entry file not found: ${manifest.entry}`);
            }
            fs.renameSync(tmpDir, versionDir);
            const iconPath = copyIconFromVersion(appDir, versionDir, manifest);
            const now = new Date().toISOString();
            const version: UserAppVersionRecord = {
                versionId,
                versionName: manifest.versionName,
                parentVersionId: existing?.currentVersionId ?? null,
                codePath: versionDir,
                manifest,
                createdAt: now
            };

            let app: UserAppRecord;
            if (existing) {
                existing.displayName = manifest.displayName;
                existing.description = manifest.description || existing.description;
                existing.iconPath = iconPath;
                existing.active = true;
                existing.currentVersionId = versionId;
                existing.versions.push(version);
                existing.updatedAt = now;
                app = existing;
            } else {
                app = {
                    bundleName: manifest.bundleName,
                    displayName: manifest.displayName,
                    description: manifest.description,
                    iconPath,
                    active: true,
                    currentVersionId: versionId,
                    versions: [version],
                    createdAt: now,
                    updatedAt: now
                };
                state.apps.push(app);
            }
            this.saveState(state);
            return { app, version };
        } catch (error) {
            removeDirectoryIfExists(tmpDir);
            removeDirectoryIfExists(versionDir);
            if (!existing) {
                removeDirectoryIfEmpty(appDir);
            }
            throw error;
        }
    }

    static installFromDirectory(sourceDir: string): InstallAppResult {
        ensureDirectories();
        const manifest = readManifestFromDirectory(sourceDir);
        assertSafeRelativePath(manifest.entry);
        if (manifest.icon) assertSafeRelativePath(manifest.icon);

        const state = this.loadState();
        const existing = state.apps.find((app) => app.bundleName === manifest.bundleName);
        const appDir = path.join(getManagedAppsDirectory(), manifest.bundleName);
        const versionId = createVersionId();
        const tmpDir = path.join(appDir, `.install-${versionId}`);
        const versionDir = path.join(appDir, versionId);
        removeDirectoryIfExists(tmpDir);
        removeDirectoryIfExists(versionDir);

        try {
            copyDirectory(sourceDir, tmpDir);
            const entryPath = path.join(tmpDir, manifest.entry);
            assertPathInside(tmpDir, entryPath);
            if (!fs.existsSync(entryPath)) {
                throw new Error(`entry file not found: ${manifest.entry}`);
            }
            fs.renameSync(tmpDir, versionDir);
            const iconPath = copyIconFromVersion(appDir, versionDir, manifest);
            const now = new Date().toISOString();
            const version: UserAppVersionRecord = {
                versionId,
                versionName: manifest.versionName,
                parentVersionId: existing?.currentVersionId ?? null,
                codePath: versionDir,
                manifest,
                createdAt: now
            };

            let app: UserAppRecord;
            if (existing) {
                existing.displayName = manifest.displayName;
                existing.description = manifest.description || existing.description;
                existing.iconPath = iconPath;
                existing.active = true;
                existing.currentVersionId = versionId;
                existing.versions.push(version);
                existing.updatedAt = now;
                app = existing;
            } else {
                app = {
                    bundleName: manifest.bundleName,
                    displayName: manifest.displayName,
                    description: manifest.description,
                    iconPath,
                    active: true,
                    currentVersionId: versionId,
                    versions: [version],
                    createdAt: now,
                    updatedAt: now
                };
                state.apps.push(app);
            }
            this.saveState(state);
            return { app, version };
        } catch (error) {
            removeDirectoryIfExists(tmpDir);
            removeDirectoryIfExists(versionDir);
            if (!existing) {
                removeDirectoryIfEmpty(appDir);
            }
            throw error;
        }
    }

    static createApp(input: { bundleName: string; displayName: string; description?: string }): InstallAppResult {
        validateBundleName(input.bundleName);
        if (this.getApp(input.bundleName)) {
            throw new Error(`application ${input.bundleName} already exists`);
        }
        const sourceDir = path.join(getAppMgrDirectory(), '.templates', `${input.bundleName}-${Date.now()}`);
        removeDirectoryIfExists(sourceDir);
        fs.mkdirSync(path.join(sourceDir, 'renderer'), { recursive: true });
        const manifest: OpenDeskAppManifest = {
            schemaVersion: 1,
            bundleName: input.bundleName,
            displayName: input.displayName,
            versionName: '初始版本',
            entry: 'renderer/index.html',
            icon: 'icon.png',
            description: input.description || '由应用管理创建的 OpenDesk 应用模板'
        };
        fs.writeFileSync(path.join(sourceDir, 'opendesk-app.json'), JSON.stringify(manifest, null, 4), 'utf-8');
        writeFallbackIcon(path.join(sourceDir, 'icon.png'));
        fs.writeFileSync(
            path.join(sourceDir, 'renderer', 'index.html'),
            [
                '<!doctype html>',
                '<html lang="zh-CN">',
                '<head>',
                '    <meta charset="UTF-8">',
                '    <meta name="viewport" content="width=device-width, initial-scale=1.0">',
                `    <title>${escapeHtmlForTemplate(input.displayName)}</title>`,
                '    <script type="module" src="./main.js"></script>',
                '</head>',
                '<body>',
                '    <open-desk-sample-app></open-desk-sample-app>',
                '</body>',
                '</html>'
            ].join('\n'),
            'utf-8'
        );
        fs.writeFileSync(
            path.join(sourceDir, 'renderer', 'main.js'),
            [
                'class OpenDeskSampleApp extends HTMLElement {',
                '    connectedCallback() {',
                '        this.innerHTML = `',
                '            <style>',
                '                :host { display: flex; height: 100vh; box-sizing: border-box; padding: 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #111827; }',
                '                main { width: 100%; border: 1px solid #e5e7eb; border-radius: 12px; background: #fff; padding: 28px; box-shadow: 0 8px 30px rgba(15, 23, 42, 0.06); }',
                '                h1 { margin: 0 0 10px; font-size: 24px; }',
                '                p { margin: 0; color: #6b7280; line-height: 1.6; }',
                '            </style>',
                '            <main>',
                `                <h1>${escapeHtmlForTemplate(input.displayName)}</h1>`,
                '                <p>这是一个最小 OpenDesk 应用模板。你可以从这里开始构建自己的界面。</p>',
                '            </main>',
                '        `;',
                '    }',
                '}',
                'customElements.define("open-desk-sample-app", OpenDeskSampleApp);'
            ].join('\n'),
            'utf-8'
        );

        try {
            return this.installFromDirectory(sourceDir);
        } finally {
            removeDirectoryIfExists(sourceDir);
        }
    }

    static setActive(bundleName: string, active: boolean): UserAppRecord {
        const state = this.loadState();
        const app = state.apps.find((item) => item.bundleName === bundleName);
        if (!app) {
            throw new Error(`application ${bundleName} not found`);
        }
        app.active = active;
        app.updatedAt = new Date().toISOString();
        this.saveState(state);
        return app;
    }

    static setCurrentVersion(bundleName: string, versionId: string): UserAppRecord {
        const state = this.loadState();
        const app = state.apps.find((item) => item.bundleName === bundleName);
        if (!app) {
            throw new Error(`application ${bundleName} not found`);
        }
        if (!app.versions.some((version) => version.versionId === versionId)) {
            throw new Error(`version ${versionId} not found for ${bundleName}`);
        }
        app.currentVersionId = versionId;
        app.updatedAt = new Date().toISOString();
        this.saveState(state);
        return app;
    }

    static updateMetadata(input: {
        bundleName: string;
        displayName?: string;
        description?: string;
        iconSourcePath?: string;
    }): UserAppRecord {
        const state = this.loadState();
        const app = state.apps.find((item) => item.bundleName === input.bundleName);
        if (!app) {
            throw new Error(`application ${input.bundleName} not found`);
        }
        if (input.displayName !== undefined) {
            app.displayName = input.displayName;
        }
        if (input.description !== undefined) {
            app.description = input.description;
        }
        if (input.iconSourcePath) {
            const appDir = path.join(getManagedAppsDirectory(), app.bundleName);
            const iconPath = path.join(appDir, 'icon.png');
            fs.mkdirSync(appDir, { recursive: true });
            fs.copyFileSync(input.iconSourcePath, iconPath);
            app.iconPath = iconPath;
        }
        app.updatedAt = new Date().toISOString();
        this.saveState(state);
        return app;
    }

    static deleteApp(bundleName: string): { success: true } {
        const state = this.loadState();
        const before = state.apps.length;
        state.apps = state.apps.filter((app) => app.bundleName !== bundleName);
        if (state.apps.length === before) {
            throw new Error(`application ${bundleName} not found`);
        }
        this.saveState(state);
        removeDirectoryIfExists(path.join(getManagedAppsDirectory(), bundleName));
        return { success: true };
    }
}

function escapeHtmlForTemplate(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/`/g, '&#96;');
}
