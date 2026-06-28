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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../../utils/logger.js';
import {
    type MemoryChunk,
    type MemoryPathOptions,
    type MemoryScope,
    type ScopedMemoryChunk,
    getGlobalMemoryFilePath,
    getWorkspaceMemoryFilePath,
    normalizeMemoryChunk
} from './common.js';
import { t } from '../../../locale/index.js';

export interface AddMemoryResult {
    success: boolean;
    status: 'created';
    uid: string;
    scope: MemoryScope;
}

export interface RemoveMemoryResult {
    success: boolean;
    removed: boolean;
    uid: string;
    scope?: MemoryScope;
}

export interface SearchMemoryResult {
    uid: string;
    title: string;
}

export interface GetMemoryOptions {
    incrementHeat?: boolean;
}

function normalizeNonBlankMemoryText(value: unknown, errorMessage: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(errorMessage);
    }
    return value.trim();
}

export class FactorialMemoryStore {
    private static instances: Map<string, FactorialMemoryStore> = new Map();
    private static mutationQueue: Promise<void> = Promise.resolve();
    private readonly workspace?: string;
    private readonly baseDirOverride?: string;

    private constructor(workspace?: string, baseDirOverride?: string) {
        this.workspace = workspace;
        this.baseDirOverride = baseDirOverride;
    }

    static getInstance(workspace?: string): FactorialMemoryStore {
        const key = workspace ?? '';
        let instance = FactorialMemoryStore.instances.get(key);
        if (!instance) {
            instance = new FactorialMemoryStore(workspace);
            FactorialMemoryStore.instances.set(key, instance);
        }
        return instance;
    }

    static createForTest(workspace: string, baseDir: string): FactorialMemoryStore {
        return new FactorialMemoryStore(workspace, baseDir);
    }

    private pathOptions(): MemoryPathOptions {
        return {
            ...(this.baseDirOverride ? { baseDir: this.baseDirOverride } : {}),
            ...(this.workspace ? { workspaceDir: this.workspace } : {})
        };
    }

    private getMemoryFilePath(scope: MemoryScope): string {
        const options = this.pathOptions();
        return scope === 'global' ? getGlobalMemoryFilePath(options) : getWorkspaceMemoryFilePath(options);
    }

    private async ensureMemoryFile(scope: MemoryScope): Promise<void> {
        const filePath = this.getMemoryFilePath(scope);
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                await this.writeMemoryFile(filePath, []);
                return;
            }
            throw err;
        }
    }

    private async readMemoryFile(scope: MemoryScope, createIfMissing = false): Promise<MemoryChunk[]> {
        if (createIfMissing) {
            await this.ensureMemoryFile(scope);
        }

        const filePath = this.getMemoryFilePath(scope);
        let raw = '';
        try {
            raw = await fs.promises.readFile(filePath, 'utf-8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
                return [];
            }
            throw err;
        }

        try {
            const parsed = JSON.parse(raw);
            const items = Array.isArray(parsed)
                ? parsed
                : parsed && typeof parsed === 'object' && Array.isArray(parsed.memories)
                  ? parsed.memories
                  : [];
            return items.map((item) => normalizeMemoryChunk(item)).filter((item): item is MemoryChunk => item !== null);
        } catch (err) {
            logger.warn(`Failed to parse memory file ${filePath}: ${err}`);
            return [];
        }
    }

    private async writeMemoryFile(filePath: string, chunks: MemoryChunk[]): Promise<void> {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        const tempPath = path.join(
            path.dirname(filePath),
            `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
        );
        const content = `${JSON.stringify(chunks, null, 2)}\n`;
        try {
            await fs.promises.writeFile(tempPath, content, 'utf-8');
            await fs.promises.rename(tempPath, filePath);
        } catch (err) {
            await fs.promises.rm(tempPath, { force: true }).catch(() => {});
            throw err;
        }
    }

    private async saveMemories(scope: MemoryScope, chunks: MemoryChunk[]): Promise<void> {
        await this.writeMemoryFile(this.getMemoryFilePath(scope), chunks);
    }

    private static async runMutation<T>(operation: () => Promise<T>): Promise<T> {
        const previous = FactorialMemoryStore.mutationQueue;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        FactorialMemoryStore.mutationQueue = previous.then(
            () => current,
            () => current
        );

        await previous.catch(() => {});
        try {
            return await operation();
        } finally {
            release();
        }
    }

    async listMemories(scope: MemoryScope): Promise<MemoryChunk[]> {
        return await this.readMemoryFile(scope);
    }

    async listAllMemories(): Promise<ScopedMemoryChunk[]> {
        const result: ScopedMemoryChunk[] = [];
        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            for (const chunk of await this.listMemories(scope)) {
                result.push({ scope, chunk });
            }
        }
        return result;
    }

    async addMemory(scope: MemoryScope, title: string, content: string): Promise<AddMemoryResult> {
        return await FactorialMemoryStore.runMutation(async () => {
            const normalizedTitle = normalizeNonBlankMemoryText(title, t('tools.memory.invalidTitle'));
            const normalizedContent = normalizeNonBlankMemoryText(content, t('tools.memory.invalidContent'));
            await this.ensureMemoryFile(scope);
            const chunks = await this.readMemoryFile(scope);
            const uid = await this.generateUid();
            const chunk: MemoryChunk = {
                uid,
                title: normalizedTitle,
                content: normalizedContent,
                heat: 0
            };
            chunks.push(chunk);
            await this.saveMemories(scope, chunks);
            return {
                success: true,
                status: 'created',
                uid,
                scope
            };
        });
    }

    async removeMemory(uid: string): Promise<RemoveMemoryResult> {
        return await FactorialMemoryStore.runMutation(async () => {
            for (const scope of ['workspace', 'global'] as MemoryScope[]) {
                const chunks = await this.readMemoryFile(scope);
                const next = chunks.filter((chunk) => chunk.uid !== uid);
                if (next.length !== chunks.length) {
                    await this.saveMemories(scope, next);
                    return {
                        success: true,
                        removed: true,
                        uid,
                        scope
                    };
                }
            }
            return {
                success: true,
                removed: false,
                uid
            };
        });
    }

    async searchMemory(keyword: string): Promise<SearchMemoryResult[]> {
        const normalizedKeyword = keyword.trim().toLowerCase();
        if (!normalizedKeyword) {
            return [];
        }

        const tokens = normalizedKeyword.split(/\s+/).filter(Boolean);
        const scored: Array<{ score: number; uid: string; title: string }> = [];
        const seen = new Set<string>();

        for (const { chunk } of await this.listAllMemories()) {
            if (seen.has(chunk.uid)) {
                continue;
            }

            const title = chunk.title.toLowerCase();
            const content = chunk.content.toLowerCase();
            let score = 0;
            for (const token of tokens) {
                if (title.includes(token)) {
                    score += 3;
                }
                if (content.includes(token)) {
                    score += 1;
                }
            }

            if (score > 0) {
                seen.add(chunk.uid);
                scored.push({ score, uid: chunk.uid, title: chunk.title });
            }
        }

        return scored
            .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
            .map(({ uid, title }) => ({ uid, title }));
    }

    async getMemory(uid: string, options: GetMemoryOptions = {}): Promise<ScopedMemoryChunk | undefined> {
        if (options.incrementHeat) {
            return await FactorialMemoryStore.runMutation(() => this.getMemoryInternal(uid, options));
        }
        return await this.getMemoryInternal(uid, options);
    }

    private async getMemoryInternal(
        uid: string,
        options: GetMemoryOptions = {}
    ): Promise<ScopedMemoryChunk | undefined> {
        for (const scope of ['workspace', 'global'] as MemoryScope[]) {
            const chunks = await this.readMemoryFile(scope);
            const index = chunks.findIndex((chunk) => chunk.uid === uid);
            if (index >= 0) {
                const chunk = { ...chunks[index] };
                if (options.incrementHeat) {
                    chunk.heat += 1;
                    chunks[index] = chunk;
                    await this.saveMemories(scope, chunks);
                }
                return { scope, chunk };
            }
        }
        return undefined;
    }

    private async generateUid(): Promise<string> {
        const existing = new Set((await this.listAllMemories()).map(({ chunk }) => chunk.uid));
        for (let i = 0; i < 8; i++) {
            const uid = crypto.randomBytes(6).toString('hex');
            if (!existing.has(uid)) {
                return uid;
            }
        }
        return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
}
