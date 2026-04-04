import type { AutocompleteItem } from '@mariozechner/pi-tui';
import { readdirSync, statSync } from 'fs';
import { join, resolve, isAbsolute } from 'path';
import { homedir } from 'os';

/** 文件补全下拉列表中显示的最大条目数，可按需调整 */
export const FILE_COMPLETION_MAX_RESULTS = 30;

/**
 * 展开路径中的 ~/ 和 $VAR_NAME 环境变量前缀。
 * 支持 $HOME、$APPDATA、$TEMP、$USERPROFILE 等任意环境变量。
 */
function expandPath(p: string): string {
    if (p === '~' || p.startsWith('~/')) {
        return homedir() + p.slice(1);
    }
    const envMatch = p.match(/^\$([A-Za-z_][A-Za-z0-9_]*)(\/.*)?$/);
    if (envMatch) {
        const varName = envMatch[1]!;
        const rest = envMatch[2] ?? '';
        const value = process.env[varName];
        if (value) return value + rest;
    }
    return p;
}

/**
 * 判断查询是否为绝对路径或特殊前缀（~/、$ENV/、../、./、/）。
 */
function isAbsoluteOrSpecial(p: string): boolean {
    return (
        isAbsolute(p) ||
        p.startsWith('~/') ||
        p === '~' ||
        p.startsWith('$') ||
        p.startsWith('../') ||
        p === '..' ||
        p.startsWith('./') ||
        p === '.'
    );
}

/**
 * 基于 readdirSync 的本地文件补全，不依赖 fd。
 * 同时被 @ 文件补全和 /import task 路径补全复用。
 *
 * 支持的路径格式：
 *  - 相对路径：src/foo
 *  - 上级目录：../bar, ../../baz
 *  - 当前目录：./foo
 *  - Home 目录：~/docs, $HOME/docs
 *  - 绝对路径：/usr/local, C:\Users
 *
 * @param basePath  工作区根目录
 * @param query     用户已输入的路径片段，如 "src/ma"
 * @param options   可选控制参数
 * @returns         补全项数组
 */
export function getFileCompletions(
    basePath: string,
    query: string,
    options: {
        /** 给 value 加上 @ 前缀 */
        atPrefix?: boolean;
        /** 给 value 加上固定前缀，如 "task " */
        valuePrefix?: string;
        /** 文件扩展名过滤，如 [".json"] */
        extensions?: string[];
        /** 最大返回数量，默认使用 FILE_COMPLETION_MAX_RESULTS */
        maxResults?: number;
    } = {}
): AutocompleteItem[] {
    const { atPrefix = false, valuePrefix = '', extensions, maxResults = FILE_COMPLETION_MAX_RESULTS } = options;

    try {
        let searchDir: string;
        let filter: string;
        let displayBase: string;

        const normalizedQuery = query.replace(/\\/g, '/');
        const expanded = expandPath(normalizedQuery);

        if (normalizedQuery.includes('/')) {
            const lastSlash = normalizedQuery.lastIndexOf('/');
            displayBase = normalizedQuery.slice(0, lastSlash + 1);
            filter = normalizedQuery.slice(lastSlash + 1).toLowerCase();

            const expandedDir = expandPath(displayBase);
            if (isAbsolute(expandedDir)) {
                searchDir = expandedDir;
            } else {
                searchDir = resolve(basePath, expandedDir);
            }
        } else if (isAbsoluteOrSpecial(expanded)) {
            searchDir = isAbsolute(expanded) ? expanded : resolve(basePath, expanded);
            filter = '';
            displayBase = normalizedQuery;
        } else {
            searchDir = basePath;
            filter = normalizedQuery.toLowerCase();
            displayBase = '';
        }

        const entries = readdirSync(searchDir, { withFileTypes: true });
        const items: AutocompleteItem[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;
            if (filter && !entry.name.toLowerCase().startsWith(filter)) continue;

            let isDir = entry.isDirectory();
            if (!isDir && entry.isSymbolicLink()) {
                try {
                    isDir = statSync(join(searchDir, entry.name)).isDirectory();
                } catch {
                    /* broken symlink */
                }
            }

            if (extensions && !isDir) {
                const ext = entry.name.slice(entry.name.lastIndexOf('.'));
                if (!extensions.includes(ext.toLowerCase())) continue;
            }

            const relativePath = displayBase ? displayBase + entry.name : entry.name;

            const displayPath = isDir ? relativePath + '/' : relativePath;

            const pfx = atPrefix ? '@' : '';
            const value = valuePrefix + pfx + displayPath;

            items.push({
                value,
                label: entry.name + (isDir ? '/' : ''),
                description: displayPath
            });
        }

        items.sort((a, b) => {
            const aIsDir = a.label.endsWith('/');
            const bIsDir = b.label.endsWith('/');
            if (aIsDir && !bIsDir) return -1;
            if (!aIsDir && bIsDir) return 1;
            return a.label.localeCompare(b.label);
        });

        return items.slice(0, maxResults);
    } catch {
        return [];
    }
}

/**
 * 从文本末尾向前查找 @ 前缀，返回 @ 后面的查询串和完整前缀。
 * @ 必须出现在行首或空白分隔符之后。
 */
export function extractAtQuery(text: string): { fullPrefix: string; query: string } | null {
    const delimiters = new Set([' ', '\t', '"', "'", '=']);
    for (let i = text.length - 1; i >= 0; i--) {
        if (text[i] === '@' && (i === 0 || delimiters.has(text[i - 1]!))) {
            return {
                fullPrefix: text.slice(i),
                query: text.slice(i + 1)
            };
        }
    }
    return null;
}
