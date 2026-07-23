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
import picomatch from 'picomatch';

function normalizeComparablePath(value) {
    const raw = String(value ?? '').replace(/\\/g, '/');
    const normalized = path.posix.normalize(raw);
    return normalized.toLowerCase();
}

function normalizeRoot(value) {
    const normalized = normalizeComparablePath(value);
    if (normalized === '/') return normalized;
    return normalized.replace(/\/+$/, '');
}

function isSameOrDescendant(root, filePath) {
    const normalizedRoot = normalizeRoot(root);
    const normalizedFile = normalizeComparablePath(filePath);
    if (normalizedRoot === '/') return normalizedFile.startsWith('/');
    return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
}

function relativeToRoot(root, filePath) {
    const normalizedRoot = normalizeRoot(root);
    const normalizedFile = normalizeComparablePath(filePath);
    if (normalizedRoot === '/') return normalizedFile.replace(/^\/+/, '');
    if (normalizedFile === normalizedRoot) return '';
    return normalizedFile.slice(normalizedRoot.length + 1);
}

function sourceToItem(source) {
    const raw = source?.item ?? source;
    const filePath = raw.path ?? raw.item_id;
    return {
        path: filePath,
        filename: raw.filename ?? path.basename(String(filePath ?? '')),
        modified: raw.modified ?? 0,
        size: raw.size ?? 0,
        snippet: raw.snippet ?? null,
        ref_count: raw.ref_count,
        root_refs: raw.root_refs,
        semanticScore:
            typeof raw.semanticScore === 'number'
                ? raw.semanticScore
                : typeof source?.semanticScore === 'number'
                  ? source.semanticScore
                  : null
    };
}

function semanticScore(item) {
    return typeof item.semanticScore === 'number' ? item.semanticScore : 0;
}

function rankBox(item) {
    const matchTypes = item.matchTypes ?? [];
    if (matchTypes.includes('keyword') && matchTypes.length > 1) return 1;
    if (matchTypes.includes('keyword')) return 2;
    if (matchTypes.includes('content_semantic')) return 3;
    return 4;
}

function visibleRefCount(item) {
    if (typeof item.ref_count === 'number') return item.ref_count;
    if (!item.root_refs) return 1;
    try {
        const refs = JSON.parse(item.root_refs);
        return Array.isArray(refs) ? refs.length : 0;
    } catch {
        return 0;
    }
}

function isUnavailable(filePath, unavailableRoots = {}) {
    return Object.keys(unavailableRoots ?? {}).some((root) => isSameOrDescendant(root, filePath));
}

export function normalizeSearchTopK(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 50;
    return Math.max(1, Math.min(Math.trunc(numeric), 100));
}

export function mergeSearchRoutes({ keyword = [], nameSemantic = [], contentSemantic = [] }) {
    const merged = new Map();
    const routes = [
        ['keyword', keyword],
        ['name_semantic', nameSemantic],
        ['content_semantic', contentSemantic]
    ];
    let order = 0;

    for (const [matchType, items] of routes) {
        for (const source of items ?? []) {
            const base = sourceToItem(source);
            if (!base.path) continue;
            const key = normalizeComparablePath(base.path);
            const existing = merged.get(key);
            if (existing) {
                if (!existing.matchTypes.includes(matchType)) existing.matchTypes.push(matchType);
                if (matchType === 'content_semantic' && base.snippet) existing.snippet = base.snippet;
                if (
                    (matchType === 'name_semantic' || matchType === 'content_semantic') &&
                    typeof base.semanticScore === 'number' &&
                    base.semanticScore > semanticScore(existing)
                ) {
                    existing.semanticScore = base.semanticScore;
                }
                existing.ref_count = existing.ref_count ?? base.ref_count;
                existing.root_refs = existing.root_refs ?? base.root_refs;
                continue;
            }
            merged.set(key, {
                ...base,
                matchTypes: [matchType],
                routeOrder: order++,
                score: typeof base.semanticScore === 'number' ? base.semanticScore : 0
            });
        }
    }

    return [...merged.values()];
}

export function rankSearchResults(items, _options = {}) {
    return [...items]
        .map((item) => ({
            ...item,
            score: semanticScore(item)
        }))
        .sort((a, b) => {
            const boxDiff = rankBox(a) - rankBox(b);
            if (boxDiff !== 0) return boxDiff;

            if (rankBox(a) !== 2) {
                return semanticScore(b) - semanticScore(a);
            }

            return 0;
        });
}

export function isCoveredByActiveEntries(filePath, entries = []) {
    for (const entry of entries ?? []) {
        if (!entry?.root || !isSameOrDescendant(entry.root, filePath)) continue;
        const relative = relativeToRoot(entry.root, filePath);
        const excluded = (entry.exclude_patterns ?? []).some((pattern) =>
            picomatch.isMatch(relative, pattern, { dot: true, nocase: true })
        );
        if (!excluded) return true;
    }
    return false;
}

export async function filterIndexedResults(
    items,
    { entries = [], unavailableRoots = {}, statFile, concurrency = 16 } = {}
) {
    const results = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < items.length) {
            const item = items[cursor++];
            if (visibleRefCount(item) <= 0) continue;
            if (isUnavailable(item.path, unavailableRoots)) continue;
            if (!isCoveredByActiveEntries(item.path, entries)) continue;
            const stat = statFile ? await statFile(item.path).catch(() => null) : { isFile: () => true };
            if (!stat?.isFile?.()) continue;
            results.push(item);
        }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length || 1)) }, () => worker());
    await Promise.all(workers);
    const kept = new Set(results.map((item) => item.path));
    return items.filter((item) => kept.has(item.path));
}

export function toIndexedFileSearchResult(query, items, totalHits, warning = undefined, code = undefined) {
    return {
        query,
        results: items.map((item) => ({
            path: item.path,
            filename: item.filename,
            modified: item.modified,
            size: item.size,
            snippet: item.snippet,
            matchTypes: item.matchTypes,
            score: item.score
        })),
        totalHits,
        ...(warning ? { warning } : {}),
        ...(code ? { code } : {})
    };
}
