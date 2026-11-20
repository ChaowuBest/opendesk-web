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

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cleanPathInput } from '../../utils/path.js';

export interface TextFilePreview {
    tooLarge: boolean;
    size: number;
    limit: number;
    content: string;
    binary: boolean;
    dataUri?: string;
}

export interface FileBrowserEntry {
    name: string;
    path: string;
    isDirectory: boolean;
    isSymbolicLink: boolean;
    size: number;
    modifiedAt: number | null;
}

export interface WorkspaceBrowseOptions {
    includeFiles?: boolean;
    extensions?: string[];
    showHidden?: boolean;
}

function requirePath(value: string, name: string): void {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
}

export async function readTextFile(filePath: string, maxBytes?: number): Promise<TextFilePreview> {
    requirePath(filePath, 'filePath');
    const limit = Number.isFinite(maxBytes) && maxBytes! > 0 ? Math.floor(maxBytes!) : 0;
    const systemPath = filePath.replace(/\//g, path.sep);
    const stat = await fs.stat(systemPath);
    if (!stat.isFile()) throw new Error('not a file');
    if (limit > 0 && stat.size > limit) {
        // Return no editable prefix: saving a truncated preview would destroy the rest of the file.
        return { tooLarge: true, size: stat.size, limit, content: '', binary: false };
    }
    const buffer = await fs.readFile(systemPath);
    const binary = buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0);
    const mimeMap: Record<string, string> = {
        png: 'image/png',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        gif: 'image/gif',
        webp: 'image/webp',
        bmp: 'image/bmp',
        ico: 'image/x-icon',
        avif: 'image/avif',
        apng: 'image/apng'
    };
    const mime = binary ? mimeMap[path.extname(systemPath).toLowerCase().slice(1)] : undefined;
    return {
        tooLarge: false,
        size: stat.size,
        limit,
        content: binary ? '' : buffer.toString('utf8'),
        binary,
        ...(mime ? { dataUri: `data:${mime};base64,${buffer.toString('base64')}` } : {})
    };
}

export async function listFileEntries(dirPath: string): Promise<FileBrowserEntry[]> {
    requirePath(dirPath, 'dirPath');
    const systemPath = dirPath.replace(/\//g, path.sep);
    const entries: FileBrowserEntry[] = [];
    for (const entry of await fs.readdir(systemPath, { withFileTypes: true })) {
        const absolutePath = path.join(systemPath, entry.name);
        const result: FileBrowserEntry = {
            name: entry.name,
            path: absolutePath.replace(/\\/g, '/'),
            isDirectory: entry.isDirectory(),
            isSymbolicLink: entry.isSymbolicLink(),
            size: 0,
            modifiedAt: null
        };
        try {
            const stat = await fs.stat(absolutePath);
            if (result.isSymbolicLink) result.isDirectory = stat.isDirectory();
            result.size = stat.size;
            result.modifiedAt = stat.mtimeMs;
        } catch {
            // Keep inaccessible/broken entries visible without metadata.
        }
        entries.push(result);
    }
    return entries.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}

export async function listWorkspaceEntries(
    dirPath: string,
    options?: WorkspaceBrowseOptions
): Promise<Pick<FileBrowserEntry, 'name' | 'path' | 'isDirectory'>[]> {
    requirePath(dirPath, 'dirPath');
    const result: Pick<FileBrowserEntry, 'name' | 'path' | 'isDirectory'>[] = [];
    for (const entry of await fs.readdir(dirPath, { withFileTypes: true })) {
        if (!options?.showHidden && entry.name.startsWith('.')) continue;
        const isDirectory = entry.isDirectory();
        if (!isDirectory) {
            if (!options?.includeFiles) continue;
            if (options.extensions?.length && !options.extensions.includes(path.extname(entry.name).toLowerCase()))
                continue;
        }
        result.push({ name: entry.name, path: path.join(dirPath, entry.name).replace(/\\/g, '/'), isDirectory });
    }
    return result.sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
    });
}

export function resolveWorkspaceFilePath(
    filePath: string,
    workspace: string,
    toHostPath: (value: string) => string = (value) => value
): string {
    requirePath(filePath, 'filePath');
    let resolved = toHostPath(cleanPathInput(filePath));
    if (resolved.startsWith('~')) resolved = path.join(os.homedir(), resolved.slice(1));
    return path.resolve(workspace, resolved).replace(/\\/g, '/');
}
