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

import path from 'path';
import { getOpendeskDirectory, Setting } from '../../utils/setting.js';

export type MemoryScope = 'global' | 'workspace';

export const MEMORY_FILE_NAME = 'memory.json';

export interface MemoryChunk {
    uid: string;
    title: string;
    content: string;
    heat: number;
}

export interface ScopedMemoryChunk {
    scope: MemoryScope;
    chunk: MemoryChunk;
}

export interface MemoryPathOptions {
    baseDir?: string;
    workspaceDir?: string;
}

export function getGlobalMemoryDir(options: MemoryPathOptions = {}): string {
    const base = options.baseDir ?? getOpendeskDirectory();
    return path.join(base, 'memory');
}

export function getGlobalMemoryFilePath(options: MemoryPathOptions = {}): string {
    return path.join(getGlobalMemoryDir(options), MEMORY_FILE_NAME);
}

export function getWorkspaceMemoryDir(options: MemoryPathOptions = {}): string {
    const workspace = options.workspaceDir ?? Setting.getInstance().getEffectiveWorkspace();
    return path.join(workspace, '.opendesk');
}

export function getWorkspaceMemoryFilePath(options: MemoryPathOptions = {}): string {
    return path.join(getWorkspaceMemoryDir(options), 'memory', MEMORY_FILE_NAME);
}

export function normalizeMemoryChunk(raw: unknown): MemoryChunk | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const record = raw as Record<string, unknown>;
    const uid = record.uid ?? record.Uid;
    const title = record.title ?? record.Title;
    const content = record.content ?? record.Content;
    const heat = record.heat ?? record.hotness ?? record.access_count ?? record.accessCount ?? 0;

    if (typeof uid !== 'string' || !uid.trim()) {
        return null;
    }
    if (typeof title !== 'string' || !title.trim()) {
        return null;
    }
    if (typeof content !== 'string') {
        return null;
    }

    return {
        uid: uid.trim(),
        title: title.trim(),
        content,
        heat: typeof heat === 'number' && Number.isFinite(heat) && heat > 0 ? Math.floor(heat) : 0
    };
}
