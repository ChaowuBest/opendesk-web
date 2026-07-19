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
import { BaseApplication } from '../base.js';
import { Skill } from '../../aikernel/skill.js';
import { logger } from '../../utils/logger.js';
import { appEntryUrl, toPublicUserApp, type UserAppRecord } from './manager.js';
import { getPlatform } from '../../../platforms/base.js';

function isSafeRelativePath(relPath: string): boolean {
    if (!relPath || path.isAbsolute(relPath) || /^[a-zA-Z]:[\\/]/.test(relPath)) {
        return false;
    }
    return !relPath.split(/[\\/]+/).includes('..');
}

function resolveInside(baseDir: string, relPath: string): string {
    if (!isSafeRelativePath(relPath)) {
        throw new Error(`Unsafe app resource path: ${relPath}`);
    }
    const resolved = path.resolve(baseDir, relPath);
    const base = path.resolve(baseDir);
    if (resolved !== base && !resolved.startsWith(`${base}${path.sep}`)) {
        throw new Error(`Unsafe app resource path: ${relPath}`);
    }
    return resolved;
}

export class ExternalManifestApplication extends BaseApplication {
    readonly source = 'user' as const;
    private record: UserAppRecord;

    constructor(record: UserAppRecord) {
        super(record.bundleName, record.displayName, record.active);
        this.record = record;
    }

    toJSON(): Record<string, unknown> {
        return toPublicUserApp(this.record);
    }

    getManifest() {
        const currentVersion = this.getCurrentVersion();
        return currentVersion.manifest;
    }

    getEntryUrl(): string {
        return appEntryUrl(this.record);
    }

    async getSkills(): Promise<Skill[]> {
        const currentVersion = this.getCurrentVersion();
        const skillPaths = currentVersion.manifest.skills ?? [];
        const skills: Skill[] = [];
        for (const skillPath of skillPaths) {
            try {
                const fullPath = resolveInside(currentVersion.codePath, skillPath);
                const markdown = fs.readFileSync(fullPath, 'utf-8');
                skills.push(Skill.parseMd(markdown));
            } catch (error) {
                logger.warn(`[appmgr] failed to load skill ${skillPath} from ${this.bundleName}: ${error}`);
            }
        }
        return skills;
    }

    private getCurrentVersion() {
        const version = this.record.versions.find((item) => item.versionId === this.record.currentVersionId);
        if (!version) {
            throw new Error(`current version ${this.record.currentVersionId} not found for ${this.bundleName}`);
        }
        return version;
    }

    /**
     * 通过主进程发起 HTTP 请求，绕过渲染进程的 CORS 限制。
     * 供后装应用在 iframe 中调用外部 API 使用。
     */
    async httpRequest(
        url: string,
        options?: { method?: string; headers?: Record<string, string>; body?: string }
    ): Promise<{
        status: number;
        statusText: string;
        headers: Record<string, string>;
        body: string;
        arrayBuffer: number[];
    }> {
        const fetchOptions: RequestInit = {
            method: options?.method || 'GET',
            headers: options?.headers || {}
        };
        if (options?.body) {
            fetchOptions.body = options.body;
        }

        const response = await getPlatform().fetch(url, fetchOptions);
        const headers: Record<string, string> = {};
        response.headers.forEach((v, k) => {
            headers[k] = v;
        });

        const arrayBuf = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuf);

        return {
            status: response.status,
            statusText: response.statusText,
            headers,
            body: buffer.toString('utf-8'),
            arrayBuffer: Array.from(new Uint8Array(buffer))
        };
    }
}
