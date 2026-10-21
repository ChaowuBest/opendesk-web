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

import { getIsOpenHarmony, getPlatform, getSystemHomePath } from '../state.js';

export const DRIVE_ROOT_PATH = '{DRIVE_ROOT}';
export const DEFAULT_EXCLUDE_PATTERNS = [
    '**/node_modules/**',
    '**/.git/**',
    '**/.idea/**',
    '**/.vscode/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.hvigor/**',
    '**/site-packages/**',
    '**/.DS_Store/**'
];

const DEFAULT_PATTERN_SET = new Set(DEFAULT_EXCLUDE_PATTERNS);
const DEFAULT_DIRECTORY_NAMES = new Set([
    'node_modules',
    '.git',
    '.idea',
    '.vscode',
    '.pytest_cache',
    '.mypy_cache',
    '.hvigor',
    'site-packages',
    '.DS_Store'
]);

function isAbsolutePattern(pattern) {
    return pattern.startsWith('/') || /^[A-Za-z]:\//.test(pattern);
}

export function isDriveRootPath(path) {
    return path === DRIVE_ROOT_PATH;
}

export function directoriesOnly(entries) {
    if (!Array.isArray(entries)) {
        return [];
    }

    return entries.filter((entry) => entry?.isDirectory || entry?.isDrive);
}

// Comparison keys may contain bare drive roots; resolve them at filesystem boundaries.
export function normalizePath(path) {
    if (typeof path !== 'string') {
        return '';
    }

    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (normalized.length > 1 && normalized.endsWith('/')) {
        return normalized.replace(/\/+$/, '');
    }

    return normalized;
}

export function isSameOrAncestor(ancestor, target) {
    const normalizedAncestor = normalizePath(ancestor);
    const normalizedTarget = normalizePath(target);
    if (!normalizedAncestor || !normalizedTarget) {
        return false;
    }

    if (normalizedAncestor === normalizedTarget) {
        return true;
    }

    if (normalizedAncestor === '/') {
        return normalizedTarget.startsWith('/');
    }

    return normalizedTarget.startsWith(`${normalizedAncestor}/`);
}

export function getRelative(root, target) {
    const normalizedRoot = normalizePath(root);
    const normalizedTarget = normalizePath(target);
    if (normalizedRoot === normalizedTarget) {
        return '';
    }

    if (normalizedRoot === '/') {
        return normalizedTarget.slice(1);
    }

    if (!isSameOrAncestor(normalizedRoot, normalizedTarget)) {
        return normalizedTarget;
    }

    return normalizedTarget.slice(normalizedRoot.length + 1);
}

export function getParentPath(path) {
    const normalizedPath = normalizePath(path);
    if (!normalizedPath || normalizedPath === DRIVE_ROOT_PATH) {
        return normalizedPath;
    }

    if (normalizedPath === '/') {
        return '/';
    }

    if (/^[A-Za-z]:$/.test(normalizedPath)) {
        return normalizedPath;
    }

    const parts = normalizedPath.split('/').filter(Boolean);
    if (normalizedPath.startsWith('/')) {
        return parts.length <= 1 ? '/' : `/${parts.slice(0, -1).join('/')}`;
    }

    return parts.length <= 1 ? normalizedPath : parts.slice(0, -1).join('/');
}

export function getUserPatternPrefix(pattern) {
    const normalized = normalizePath(pattern);
    if (normalized.endsWith('/**')) {
        return normalized.slice(0, -3);
    }

    return normalized;
}

export function isDefault(pattern) {
    const normalized = normalizePath(pattern);
    return (
        DEFAULT_PATTERN_SET.has(normalized) ||
        (isAbsolutePattern(normalized) && normalized.endsWith('/Library/**')) ||
        (isAbsolutePattern(normalized) && normalized.endsWith('/AppData/**')) ||
        normalized === 'C:/Windows/**' ||
        normalized === 'C:/Temp/**'
    );
}

export function userPatternMatches(pattern, relPath) {
    const prefix = getUserPatternPrefix(pattern);
    const relativePath = normalizePath(relPath);
    return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

export function userPatternInSubtree(pattern, relOfNode) {
    const prefix = getUserPatternPrefix(pattern);
    const relativeNode = normalizePath(relOfNode);
    if (relativeNode === '') {
        return true;
    }

    return prefix === relativeNode || prefix.startsWith(`${relativeNode}/`);
}

export function hasDescendantRoot(nodePath, entries) {
    const normalizedNodePath = normalizePath(nodePath);
    if (!Array.isArray(entries)) {
        return false;
    }

    return entries.some((entry) => {
        const root = normalizePath(entry?.root);
        return root !== normalizedNodePath && isSameOrAncestor(normalizedNodePath, root);
    });
}

export function hasUserExcludesInSubtree(rootEntry, nodePath, optionalNodePath) {
    if (!rootEntry || !Array.isArray(rootEntry.exclude_patterns)) {
        return false;
    }

    const targetPath = optionalNodePath ?? nodePath;
    const relativeNode =
        normalizePath(rootEntry.root) === normalizePath(targetPath) ? '' : getRelative(rootEntry.root, targetPath);

    return rootEntry.exclude_patterns.some((pattern) => {
        return !isDefault(pattern) && userPatternInSubtree(pattern, relativeNode);
    });
}

export function pathHitsDefault(absPath, defaultPatterns = DEFAULT_EXCLUDE_PATTERNS) {
    const normalizedPath = normalizePath(absPath);
    const segments = normalizedPath.split('/').filter(Boolean);
    if (segments.some((segment) => DEFAULT_DIRECTORY_NAMES.has(segment))) {
        return true;
    }

    return defaultPatterns.some((pattern) => {
        const normalizedPattern = normalizePath(pattern);
        if (!isDefault(normalizedPattern)) {
            return false;
        }

        if (normalizedPattern.startsWith('**/')) {
            const marker = normalizedPattern.slice(3, -3);
            return segments.includes(marker.replace(/\//g, ''));
        }

        const prefix = getUserPatternPrefix(normalizedPattern);
        return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
    });
}

function deriveHomeFromWorkspace(workspace) {
    const normalizedWorkspace = normalizePath(workspace);
    if (!normalizedWorkspace) {
        return '/';
    }

    const segments = normalizedWorkspace.split('/').filter(Boolean);
    if (normalizedWorkspace.startsWith('/')) {
        return `/${segments.slice(0, 2).join('/')}`;
    }

    return segments.slice(0, 3).join('/');
}

export function getHomeRoot(defaultWorkspace) {
    const platform = getPlatform();
    const isOH = getIsOpenHarmony();
    const systemHomePath = getSystemHomePath();
    let result;

    if (platform === 'win32') {
        result = DRIVE_ROOT_PATH;
    } else if (isOH) {
        result = normalizePath(systemHomePath);
    } else if (systemHomePath) {
        result = normalizePath(systemHomePath);
    }

    if (!result) {
        result = deriveHomeFromWorkspace(defaultWorkspace);
    }

    return result;
}
