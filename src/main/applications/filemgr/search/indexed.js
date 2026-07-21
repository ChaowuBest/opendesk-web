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
import { normalizePathDescendantOrSelfValue } from '../../../services/storage/path-scope.js';

const SEARCH_ROUTE_ALIASES = {
    keyword: 'keyword',
    name: 'name_semantic',
    name_semantic: 'name_semantic',
    content: 'content_semantic',
    content_semantic: 'content_semantic'
};

function normalizeIndexedSearchRoutes(options = {}) {
    const requested = Array.isArray(options?.routes)
        ? options.routes.map((route) => SEARCH_ROUTE_ALIASES[String(route)]).filter(Boolean)
        : null;
    const routes = new Set(requested === null ? ['keyword', 'name_semantic', 'content_semantic'] : requested);
    if (options?.includeContentSemantic === false) {
        routes.delete('content_semantic');
    }
    return {
        keyword: routes.has('keyword'),
        nameSemantic: routes.has('name_semantic'),
        contentSemantic: routes.has('content_semantic'),
        needsSemantic: routes.has('name_semantic') || routes.has('content_semantic')
    };
}

export class InvalidFilemgrSearchScopeError extends Error {
    constructor() {
        super('Invalid file manager search scope');
        this.name = 'InvalidFilemgrSearchScopeError';
    }
}

export const FILEMGR_SEARCH_MAX_PATHS = 64;

function toFilemgrProtocolPath(value) {
    const isWin32Drive = /^[A-Za-z]:[\\/]/.test(value);
    const isWin32Unc = /^\\\\[^\\]+\\[^\\]+/.test(value);
    return isWin32Drive || isWin32Unc ? value.replace(/\\/g, '/') : value;
}

function normalizeOneScopePath(value) {
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
        throw new InvalidFilemgrSearchScopeError();
    }

    try {
        const normalizedPath = normalizePathDescendantOrSelfValue(toFilemgrProtocolPath(value));
        const segments = normalizedPath.split('/');
        const hasDotSegment = segments.some((segment) => segment === '.' || segment === '..');
        const isPosix = /^\/(?:[^/]+(?:\/[^/]+)*)?$/.test(normalizedPath);
        const isDrive = /^[A-Za-z]:\/(?:[^/]+(?:\/[^/]+)*)?$/.test(normalizedPath);
        const isUnc = /^\/\/[^/]+\/[^/]+(?:\/[^/]+)*$/.test(normalizedPath);
        if (hasDotSegment || (!isPosix && !isDrive && !isUnc)) {
            throw new InvalidFilemgrSearchScopeError();
        }
        return normalizedPath;
    } catch {
        throw new InvalidFilemgrSearchScopeError();
    }
}

export function isExactPathSameOrDescendant(root, candidate) {
    const normalizedRoot = normalizeOneScopePath(root);
    const normalizedCandidate = normalizeOneScopePath(candidate);
    if (normalizedRoot === '/') return normalizedCandidate.startsWith('/');
    if (/^[A-Za-z]:\/$/.test(normalizedRoot)) {
        return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(normalizedRoot);
    }
    return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

function collapseScopePaths(rawPaths) {
    if (!Array.isArray(rawPaths) || rawPaths.length === 0 || rawPaths.length > FILEMGR_SEARCH_MAX_PATHS) {
        throw new InvalidFilemgrSearchScopeError();
    }
    const normalized = [...new Set(Array.from(rawPaths, (value) => normalizeOneScopePath(value)))].sort(
        (left, right) => left.length - right.length || (left < right ? -1 : left > right ? 1 : 0)
    );
    const collapsed = [];
    for (const candidate of normalized) {
        if (!collapsed.some((root) => isExactPathSameOrDescendant(root, candidate))) {
            collapsed.push(candidate);
        }
    }
    return collapsed;
}

export function normalizeFilemgrSearchScope(scope) {
    if (scope === undefined) return undefined;
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
        throw new InvalidFilemgrSearchScopeError();
    }
    if (scope.type === 'path') {
        return { type: 'path', path: collapseScopePaths([scope.path])[0] };
    }
    if (scope.type === 'paths' && Array.isArray(scope.paths)) {
        return { type: 'paths', paths: collapseScopePaths(scope.paths) };
    }
    throw new InvalidFilemgrSearchScopeError();
}

export function filemgrSearchScopePaths(scope) {
    if (!scope) return [];
    return scope.type === 'path' ? [scope.path] : scope.paths;
}

export function isPathInFilemgrSearchScope(filePath, scope) {
    if (!scope) return true;
    try {
        return filemgrSearchScopePaths(scope).some((root) => isExactPathSameOrDescendant(root, filePath));
    } catch {
        return false;
    }
}

function normalizedConfiguredEntries(entries) {
    return (entries ?? [])
        .map((entry) => {
            try {
                return { entry, root: normalizeOneScopePath(entry?.root) };
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function normalizedUnavailableRoots(unavailableRoots) {
    return Object.keys(unavailableRoots ?? {}).flatMap((root) => {
        try {
            return [normalizeOneScopePath(root)];
        } catch {
            return [];
        }
    });
}

export function resolveFilemgrSearchScopeForEntries(scope, { entries = [], unavailableRoots = {} } = {}) {
    if (!scope) {
        return { requestedScope: undefined, effectiveScope: undefined, coversAllSources: false };
    }

    const requestedScope = normalizeFilemgrSearchScope(scope);
    const paths = filemgrSearchScopePaths(requestedScope);
    const configured = normalizedConfiguredEntries(entries);
    if (configured.length === 0) throw new InvalidFilemgrSearchScopeError();

    const unavailable = normalizedUnavailableRoots(unavailableRoots);
    for (const selectedPath of paths) {
        const covering = configured.filter(({ root }) => isExactPathSameOrDescendant(root, selectedPath));
        if (covering.length === 0) throw new InvalidFilemgrSearchScopeError();
        if (unavailable.some((root) => isExactPathSameOrDescendant(root, selectedPath))) {
            throw new InvalidFilemgrSearchScopeError();
        }
    }

    const coversAllSources = configured.every(({ root }) =>
        paths.some((selectedPath) => isExactPathSameOrDescendant(selectedPath, root))
    );
    return {
        requestedScope,
        effectiveScope: coversAllSources ? undefined : requestedScope,
        coversAllSources
    };
}

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
        snippets: raw.snippets,
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

export function createIndexedSearchContext(query, options = {}) {
    return {
        query: typeof query === 'string' ? query.trim() : '',
        topK: normalizeSearchTopK(options?.topK),
        routes: normalizeIndexedSearchRoutes(options),
        scope: normalizeFilemgrSearchScope(options?.scope)
    };
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
                if (matchType === 'content_semantic' && base.snippets) existing.snippets = base.snippets;
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

export function groupIndexedChunksByFile(chunkHits, fileLimit) {
    const grouped = new Map();
    for (const hit of chunkHits ?? []) {
        const file = grouped.get(hit.source.path) ?? {
            path: hit.source.path,
            filename: hit.source.filename,
            modified: hit.source.modified,
            size: hit.source.size,
            ref_count: hit.source.refCount,
            root_refs: hit.source.rootRefs,
            snippets: []
        };
        file.snippets.push({ chunkId: hit.chunk.id, text: hit.chunk.text, score: hit.score });
        grouped.set(hit.source.path, file);
    }
    return [...grouped.values()]
        .map((file) => {
            file.snippets.sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
            return {
                ...file,
                snippet: file.snippets[0]?.text ?? null,
                semanticScore: file.snippets[0]?.score ?? 0
            };
        })
        .sort((left, right) => right.semanticScore - left.semanticScore)
        .slice(0, fileLimit);
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

export function filterIndexedResultsByPolicy(items, { entries = [], unavailableRoots = {}, scope } = {}) {
    return (items ?? []).filter(
        (item) =>
            isPathInFilemgrSearchScope(item.path, scope) &&
            visibleRefCount(item) > 0 &&
            !isUnavailable(item.path, unavailableRoots) &&
            isCoveredByActiveEntries(item.path, entries)
    );
}

export async function filterIndexedResults(
    items,
    { entries = [], unavailableRoots = {}, scope, statFile, concurrency = 16 } = {}
) {
    const candidates = filterIndexedResultsByPolicy(items, { entries, unavailableRoots, scope });
    const results = [];
    let cursor = 0;
    const worker = async () => {
        while (cursor < candidates.length) {
            const item = candidates[cursor++];
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
            snippets: item.snippets,
            matchTypes: item.matchTypes,
            score: item.score
        })),
        totalHits,
        ...(warning ? { warning } : {}),
        ...(code ? { code } : {})
    };
}
