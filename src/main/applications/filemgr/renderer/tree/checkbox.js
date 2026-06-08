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

import {
    DEFAULT_EXCLUDE_PATTERNS,
    getRelative,
    getUserPatternPrefix,
    hasDescendantRoot,
    hasUserExcludesInSubtree,
    isDefault,
    isSameOrAncestor,
    normalizePath,
    pathHitsDefault,
    userPatternInSubtree,
    userPatternMatches
} from './utils.js';

function cloneEntry(entry) {
    return {
        ...entry,
        root: normalizePath(entry.root),
        exclude_patterns: Array.isArray(entry.exclude_patterns) ? [...entry.exclude_patterns] : []
    };
}

function cloneEntries(entries) {
    return Array.isArray(entries) ? entries.map(cloneEntry) : [];
}

function getDefaultPatterns(ctx = {}) {
    return Array.isArray(ctx.defaultExcludePatterns) ? [...ctx.defaultExcludePatterns] : [...DEFAULT_EXCLUDE_PATTERNS];
}

function isStrictAncestor(ancestor, target) {
    return normalizePath(ancestor) !== normalizePath(target) && isSameOrAncestor(ancestor, target);
}

function byDeepestRoot(left, right) {
    return normalizePath(right.root).length - normalizePath(left.root).length;
}

function byCoarsestPattern(left, right) {
    const leftPrefix = getUserPatternPrefix(left.pattern);
    const rightPrefix = getUserPatternPrefix(right.pattern);
    const depthDelta = leftPrefix.split('/').length - rightPrefix.split('/').length;
    return depthDelta || leftPrefix.length - rightPrefix.length;
}

function findSelf(nodePath, entries) {
    const normalizedNodePath = normalizePath(nodePath);
    return entries.find((entry) => normalizePath(entry.root) === normalizedNodePath) ?? null;
}

function findCoveringAncestor(nodePath, entries) {
    const ancestors = entries.filter((entry) => isStrictAncestor(entry.root, nodePath)).sort(byDeepestRoot);

    return (
        ancestors.find((entry) => {
            const relativePath = getRelative(entry.root, nodePath);
            return !entry.exclude_patterns.some((pattern) => {
                return !isDefault(pattern) && userPatternMatches(pattern, relativePath);
            });
        }) ?? null
    );
}

function hasUserPatterns(entry) {
    return entry.exclude_patterns.some((pattern) => !isDefault(pattern));
}

function unavailableSource(nodePath, ctx = {}) {
    const normalizedNodePath = normalizePath(nodePath);
    return (
        (ctx.sources ?? []).find((source) => {
            return normalizePath(source?.root) === normalizedNodePath && source?.state === 'unavailable';
        }) ?? null
    );
}

export const WORKSPACE_ROOT_PROTECTED_MESSAGE = '当前工作空间不能在这里移除。请回到主页面切换工作空间。';

function isDefaultWorkspaceRoot(nodePath, ctx = {}) {
    const defaultWorkspace = normalizePath(ctx.defaultWorkspace);
    return Boolean(defaultWorkspace) && normalizePath(nodePath) === defaultWorkspace;
}

function replaceEntry(entries, target, replacement) {
    return entries.map((entry) => (entry === target ? replacement : entry));
}

function clearBlockingPatternsForNode(entries, nodePath) {
    return entries.map((entry) => {
        if (!isStrictAncestor(entry.root, nodePath)) {
            return entry;
        }

        const relativePath = getRelative(entry.root, nodePath);
        return {
            ...entry,
            exclude_patterns: entry.exclude_patterns.filter((pattern) => {
                return isDefault(pattern) || !userPatternMatches(pattern, relativePath);
            })
        };
    });
}

function appendUnique(patterns, additions) {
    const seen = new Set(patterns);
    const result = [...patterns];
    for (const pattern of additions) {
        if (!seen.has(pattern)) {
            seen.add(pattern);
            result.push(pattern);
        }
    }

    return result;
}

function joinPath(root, child) {
    const normalizedRoot = normalizePath(root);
    const normalizedChild = normalizePath(child);
    if (!normalizedChild) {
        return normalizedRoot;
    }

    if (normalizedRoot === '/') {
        return `/${normalizedChild}`;
    }

    return `${normalizedRoot}/${normalizedChild}`;
}

function childName(child) {
    if (typeof child === 'string') {
        return child.split('/').filter(Boolean).pop() ?? child;
    }

    if (typeof child?.name === 'string') {
        return child.name;
    }

    if (typeof child?.path === 'string') {
        return child.path.split('/').filter(Boolean).pop() ?? child.path;
    }

    return '';
}

function childrenFor(path, ctx = {}) {
    const normalizedPath = normalizePath(path);
    const children = ctx.childrenByPath?.[normalizedPath] ?? ctx.tree?.[normalizedPath] ?? [];
    return Array.isArray(children) ? children.map(childName).filter(Boolean) : [];
}

export function effectiveBlockingPattern(nodePath, entries) {
    const ancestors = (Array.isArray(entries) ? entries : [])
        .filter((entry) => isStrictAncestor(entry.root, nodePath))
        .sort(byDeepestRoot);
    const candidates = [];

    for (const ownerEntry of ancestors) {
        const relativePath = getRelative(ownerEntry.root, nodePath);
        candidates.push(
            ...ownerEntry.exclude_patterns
                .filter((pattern) => !isDefault(pattern) && userPatternMatches(pattern, relativePath))
                .map((pattern) => ({ ownerEntry, pattern }))
        );
    }

    if (candidates.length > 0) {
        const [candidate] = candidates.sort(byCoarsestPattern);
        return {
            ownerEntry: candidate.ownerEntry,
            blockingPattern: candidate.pattern
        };
    }

    return null;
}

export function computeVisual(nodePath, entries, ctx = {}) {
    const normalizedNodePath = normalizePath(nodePath);
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    if (unavailableSource(normalizedNodePath, ctx)) {
        return { state: 'unavailable', cause: 'unavailable' };
    }

    if (pathHitsDefault(normalizedNodePath, getDefaultPatterns(ctx))) {
        return { state: 'system-skip', cause: 'defaults' };
    }

    const self = findSelf(normalizedNodePath, normalizedEntries);
    if (self) {
        if (hasUserPatterns(self)) {
            return { state: 'indeterminate', cause: 'self_dirty', ownerEntry: self };
        }

        return { state: 'checked', cause: 'self_clean', ownerEntry: self };
    }

    const coveringAncestor = findCoveringAncestor(normalizedNodePath, normalizedEntries);
    if (coveringAncestor) {
        if (hasUserExcludesInSubtree(coveringAncestor, normalizedNodePath)) {
            return { state: 'indeterminate', cause: 'covered_dirty', ownerEntry: coveringAncestor };
        }

        return { state: 'checked', cause: 'covered_clean', ownerEntry: coveringAncestor };
    }

    if (hasDescendantRoot(normalizedNodePath, normalizedEntries)) {
        return { state: 'indeterminate', cause: 'desc_only' };
    }

    const blocker = effectiveBlockingPattern(normalizedNodePath, normalizedEntries);
    if (blocker) {
        return {
            state: 'empty',
            cause: 'blocked',
            ownerEntry: blocker.ownerEntry,
            blockingPattern: blocker.blockingPattern
        };
    }

    return { state: 'empty', cause: 'none' };
}

export function ascendAndConsolidate(nodePath, entries, ctx = {}) {
    const normalizedNodePath = normalizePath(nodePath);
    let nextEntries = cloneEntries(entries).map((entry) => {
        if (normalizePath(entry.root) !== normalizedNodePath && !isStrictAncestor(entry.root, normalizedNodePath)) {
            return entry;
        }

        const relativeNode =
            normalizePath(entry.root) === normalizedNodePath ? '' : getRelative(entry.root, normalizedNodePath);
        return {
            ...entry,
            exclude_patterns: entry.exclude_patterns.filter((pattern) => {
                return isDefault(pattern) || !userPatternInSubtree(pattern, relativeNode);
            })
        };
    });

    nextEntries = nextEntries.filter((entry) => !isStrictAncestor(normalizedNodePath, entry.root));
    if (!findSelf(normalizedNodePath, nextEntries) && !findCoveringAncestor(normalizedNodePath, nextEntries)) {
        nextEntries.push({ root: normalizedNodePath, exclude_patterns: getDefaultPatterns(ctx) });
    }

    return nextEntries;
}

export function carveOut(rootEntry, nodePath, blockingPattern, ctx = {}) {
    const entry = cloneEntry(rootEntry);
    const normalizedNodePath = normalizePath(nodePath);
    const blockedPrefix = getUserPatternPrefix(blockingPattern);
    const relativeNode = getRelative(entry.root, normalizedNodePath);
    const remaining = blockedPrefix ? relativeNode.slice(blockedPrefix.length).replace(/^\//, '') : relativeNode;
    const lineage = remaining.split('/').filter(Boolean);
    const additions = [];

    let currentAbsPath = joinPath(entry.root, blockedPrefix);
    let currentRelPath = blockedPrefix;
    for (const lineageChild of lineage) {
        const siblings = childrenFor(currentAbsPath, ctx);
        for (const sibling of siblings) {
            if (sibling === lineageChild) {
                continue;
            }

            const siblingRel = currentRelPath ? `${currentRelPath}/${sibling}` : sibling;
            additions.push(`${siblingRel}/**`);
        }

        currentAbsPath = joinPath(currentAbsPath, lineageChild);
        currentRelPath = currentRelPath ? `${currentRelPath}/${lineageChild}` : lineageChild;
    }

    const keptPatterns = entry.exclude_patterns.filter((pattern) => {
        return pattern !== blockingPattern && (isDefault(pattern) || !userPatternInSubtree(pattern, relativeNode));
    });

    return {
        ...entry,
        exclude_patterns: appendUnique(keptPatterns, additions)
    };
}

export function applyClick(nodePath, entries, ctx = {}) {
    const normalizedNodePath = normalizePath(nodePath);
    let nextEntries = cloneEntries(entries);
    const visual = computeVisual(normalizedNodePath, nextEntries, ctx);

    if (visual.state === 'system-skip' || visual.state === 'unavailable') {
        return null;
    }

    if (isDefaultWorkspaceRoot(normalizedNodePath, ctx) && visual.state === 'checked') {
        return {
            action: 'protectedWorkspace',
            nextEntries: entries,
            message: WORKSPACE_ROOT_PROTECTED_MESSAGE
        };
    }

    if (visual.state === 'checked') {
        const self = findSelf(normalizedNodePath, nextEntries);
        if (self) {
            return {
                action: 'showModal',
                nextEntries: nextEntries.filter((entry) => normalizePath(entry.root) !== normalizedNodePath)
            };
        }

        const coveringAncestor = findCoveringAncestor(normalizedNodePath, nextEntries);
        const relativePath = getRelative(coveringAncestor.root, normalizedNodePath);
        coveringAncestor.exclude_patterns = appendUnique(coveringAncestor.exclude_patterns, [`${relativePath}/**`]);
        return { action: 'commit', nextEntries, toast: 'undo', toastAction: 'exclude' };
    }

    if (visual.state === 'indeterminate') {
        return {
            action: 'commit',
            nextEntries: ascendAndConsolidate(normalizedNodePath, nextEntries, ctx),
            toast: 'info',
            toastAction: 'consolidate'
        };
    }

    const blocker = effectiveBlockingPattern(normalizedNodePath, nextEntries);
    if (blocker) {
        const ownerEntry = nextEntries.find(
            (entry) => normalizePath(entry.root) === normalizePath(blocker.ownerEntry.root)
        );
        const relativePath = getRelative(ownerEntry.root, normalizedNodePath);
        const blockedPrefix = getUserPatternPrefix(blocker.blockingPattern);
        if (blockedPrefix === relativePath) {
            ownerEntry.exclude_patterns = ownerEntry.exclude_patterns.filter(
                (pattern) => pattern !== blocker.blockingPattern
            );
            return { action: 'commit', nextEntries, toast: 'info', toastAction: 'restore' };
        }

        nextEntries = replaceEntry(
            nextEntries,
            ownerEntry,
            carveOut(ownerEntry, normalizedNodePath, blocker.blockingPattern, ctx)
        );
        nextEntries = clearBlockingPatternsForNode(nextEntries, normalizedNodePath);
        return { action: 'commit', nextEntries, toast: 'info', toastAction: 'carve-out' };
    }

    nextEntries = nextEntries.filter((entry) => !isStrictAncestor(normalizedNodePath, entry.root));
    nextEntries.push({ root: normalizedNodePath, exclude_patterns: getDefaultPatterns(ctx) });
    return { action: 'commit', nextEntries, toast: 'info', toastAction: 'add-entry' };
}
