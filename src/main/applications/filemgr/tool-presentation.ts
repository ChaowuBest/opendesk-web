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

import type { ToolCall } from '../../aikernel/messages.js';
import {
    getToolCallPresentationArgs,
    type ToolCallPresentation,
    type ToolPresentationText
} from '../../aikernel/tool-presentation.js';

export type FileToolPresentationKind =
    | 'readFile'
    | 'readImage'
    | 'askImage'
    | 'extractText'
    | 'writeFile'
    | 'editFile'
    | 'searchReplace'
    | 'applyPatch'
    | 'globFiles'
    | 'grepFiles'
    | 'semanticSearch';

const DISPLAY_NAME_KEYS: Record<FileToolPresentationKind, string> = {
    readFile: 'filemgr.readFile.name',
    readImage: 'filemgr.readImage.name',
    askImage: 'filemgr.askImage.name',
    extractText: 'filemgr.extractText.name',
    writeFile: 'filemgr.writeFile.name',
    editFile: 'filemgr.editFile.name',
    searchReplace: 'filemgr.searchReplace.name',
    applyPatch: 'filemgr.applyPatch.name',
    globFiles: 'renderer.taskview.output.toolName.glob',
    grepFiles: 'renderer.taskview.output.toolName.grep',
    semanticSearch: 'filemgr.semanticSearch.name'
};

function basename(value: unknown): string {
    if (typeof value !== 'string') return '';
    const normalized = value.replace(/[\\/]+$/, '');
    return normalized.split(/[\\/]/).pop() || normalized;
}

function explicitSummary(args: Record<string, unknown>): string | undefined {
    for (const key of ['description', 'purpose', 'task']) {
        const value = args[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
}

function globSummary(args: Record<string, unknown>): ToolPresentationText | undefined {
    if (typeof args.pattern !== 'string' || !args.pattern.trim()) return undefined;
    const pattern = args.pattern.trim().replaceAll('\\', '/');
    const typedFiles = pattern.match(/^(?:(.+?)\/)?(?:\*\*\/)?\*\.([a-zA-Z0-9]+)$/);
    if (!typedFiles) return { key: 'renderer.taskview.output.purpose.glob', params: { pattern } };
    const [, patternDirectory, extension] = typedFiles;
    const typeNames: Record<string, string> = {
        c: 'C',
        cpp: 'C++',
        css: 'CSS',
        go: 'Go',
        html: 'HTML',
        java: 'Java',
        js: 'JavaScript',
        json: 'JSON',
        jsx: 'JavaScript React',
        md: 'Markdown',
        py: 'Python',
        rs: 'Rust',
        ts: 'TypeScript',
        tsx: 'TypeScript React',
        yaml: 'YAML',
        yml: 'YAML'
    };
    const type = typeNames[extension.toLowerCase()] || extension.toUpperCase();
    const directory = patternDirectory || args.path;
    return directory
        ? {
              key: 'renderer.taskview.output.purpose.globTypedFilesIn',
              params: { directory: String(directory), type }
          }
        : { key: 'renderer.taskview.output.purpose.globTypedFiles', params: { type } };
}

function fileSummary(
    kind: FileToolPresentationKind,
    args: Record<string, unknown>,
    name: string
): ToolPresentationText | undefined {
    const explicit = explicitSummary(args);
    if (explicit) return explicit;
    if (kind === 'readFile' && name) {
        return { key: 'renderer.taskview.output.purpose.readFile', params: { name } };
    }
    if ((kind === 'readImage' || kind === 'askImage') && name) {
        return { key: 'renderer.taskview.output.purpose.readImage', params: { name } };
    }
    if (kind === 'extractText' && name) {
        return { key: 'renderer.taskview.output.purpose.extractText', params: { name } };
    }
    if (kind === 'writeFile' && name) {
        return { key: 'renderer.taskview.output.purpose.writeFile', params: { name } };
    }
    if (kind === 'editFile' && name) {
        return { key: 'renderer.taskview.output.purpose.editFile', params: { name } };
    }
    if (kind === 'searchReplace' && name) {
        return { key: 'renderer.taskview.output.purpose.searchReplace', params: { name } };
    }
    if (kind === 'applyPatch') return { key: 'renderer.taskview.output.purpose.applyPatch' };
    if (kind === 'globFiles') return globSummary(args);
    if (kind === 'grepFiles' && args.pattern !== undefined) {
        return { key: 'renderer.taskview.output.purpose.grep', params: { pattern: String(args.pattern) } };
    }
    if (kind === 'semanticSearch' && args.query !== undefined) {
        return { key: 'renderer.taskview.output.purpose.search', params: { query: String(args.query) } };
    }
    return undefined;
}

export function getFileToolCallPresentation(kind: FileToolPresentationKind, toolCall: ToolCall): ToolCallPresentation {
    const args = getToolCallPresentationArgs(toolCall);
    const pathValue = args.file_path ?? args.filePath ?? args.path;
    const filePath = typeof pathValue === 'string' && pathValue.trim() ? pathValue.trim() : undefined;
    const name = basename(filePath);
    const resource =
        filePath && kind === 'readFile'
            ? { type: 'preview' as const, value: filePath }
            : filePath && (kind === 'writeFile' || kind === 'editFile' || kind === 'searchReplace')
              ? { type: 'changes' as const, value: filePath }
              : undefined;
    return {
        displayName: { key: DISPLAY_NAME_KEYS[kind] },
        summary: fileSummary(kind, args, name),
        activity:
            kind === 'readFile' && filePath ? { key: 'output.running.reading', params: { path: filePath } } : undefined,
        resource,
        detailMode: resource ? 'resource' : kind === 'grepFiles' ? 'custom' : undefined
    };
}
