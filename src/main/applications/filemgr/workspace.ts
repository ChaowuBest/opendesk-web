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

import { FSEntrySchema } from './setting.js';

function normalizeComparablePath(value: any) {
    const raw = String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
    const normalized = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
    return normalized.toLowerCase();
}

function normalizePattern(value: any) {
    return String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+/g, '/');
}

function isStrictDescendant(parent: string, child: string) {
    const normalizedParent = normalizeComparablePath(parent);
    const normalizedChild = normalizeComparablePath(child);
    if (!normalizedParent || !normalizedChild || normalizedParent === normalizedChild) {
        return false;
    }

    if (normalizedParent === '/') {
        return normalizedChild.startsWith('/');
    }

    return normalizedChild.startsWith(`${normalizedParent}/`);
}

function samePath(left: any, right: any) {
    return normalizeComparablePath(left) === normalizeComparablePath(right);
}

function relativePathFromParent(parentRoot: string, childRoot: string) {
    const parent = normalizePattern(parentRoot).replace(/\/+$/, '');
    const child = normalizePattern(childRoot).replace(/\/+$/, '');
    if (parent === '/') {
        return child.replace(/^\/+/, '');
    }

    return child.slice(parent.length + 1);
}

function defaultExcludePatternSet() {
    return new Set(
        FSEntrySchema.parse({ root: '__filemgr_default_workspace__' }).exclude_patterns.map(normalizePattern)
    );
}

function getUserExcludePatterns(entry: any) {
    if (!Array.isArray(entry?.exclude_patterns)) {
        return [];
    }

    const defaults = defaultExcludePatternSet();
    return entry.exclude_patterns.filter((pattern: any) => !defaults.has(normalizePattern(pattern)));
}

function relativePatternFromChildRoot(parentRoot: string, childRoot: string, pattern: string) {
    const relativeChild = relativePathFromParent(parentRoot, childRoot);
    const normalizedPattern = normalizePattern(pattern).replace(/^\/+/, '');
    return relativeChild ? `${relativeChild}/${normalizedPattern}` : normalizedPattern;
}

function appendUniquePatterns(existing: any[] = [], additions: string[] = []) {
    const seen = new Set(existing.map(normalizePattern));
    const next = [...existing];
    for (const pattern of additions) {
        const normalized = normalizePattern(pattern);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        next.push(pattern);
    }

    return next;
}

function mergeChildWorkspaceEntry(entries: any[], defaultWorkspace: string, oldDefaultWorkspace: any) {
    if (
        typeof oldDefaultWorkspace !== 'string' ||
        oldDefaultWorkspace.length === 0 ||
        !isStrictDescendant(defaultWorkspace, oldDefaultWorkspace)
    ) {
        return entries;
    }

    const childEntry = entries.find((entry: any) => samePath(entry?.root, oldDefaultWorkspace));
    const parentEntry = entries.find((entry: any) => samePath(entry?.root, defaultWorkspace));
    if (!childEntry || !parentEntry) {
        return entries;
    }

    const userExcludes = getUserExcludePatterns(childEntry).map((pattern: string) =>
        relativePatternFromChildRoot(defaultWorkspace, childEntry.root, pattern)
    );
    const mergedParentEntry =
        userExcludes.length === 0
            ? parentEntry
            : {
                  ...parentEntry,
                  exclude_patterns: appendUniquePatterns(parentEntry.exclude_patterns, userExcludes)
              };

    return entries
        .filter((entry: any) => !samePath(entry?.root, oldDefaultWorkspace))
        .map((entry: any) => (samePath(entry?.root, defaultWorkspace) ? mergedParentEntry : entry));
}

export function prepareFileMgrWorkspaceSettings(nextSettings: any, oldSettings: any = {}) {
    const defaultWorkspace =
        typeof nextSettings?.default_workspace === 'string' && nextSettings.default_workspace.length > 0
            ? nextSettings.default_workspace
            : null;

    if (!defaultWorkspace) {
        return {
            data: nextSettings,
            defaultWorkspace,
            shouldNotifyWorkspaceChanged: false
        };
    }

    const applications = { ...(nextSettings?.applications ?? {}) };
    const filemgr = { ...(applications.filemgr ?? {}) };
    const entries = Array.isArray(filemgr.entries) ? filemgr.entries : [];
    const hasEntry = entries.some((entry: any) => samePath(entry?.root, defaultWorkspace));
    const upsertedEntries = hasEntry ? entries : [...entries, FSEntrySchema.parse({ root: defaultWorkspace })];
    const nextEntries = mergeChildWorkspaceEntry(upsertedEntries, defaultWorkspace, oldSettings?.default_workspace);

    return {
        data: {
            ...nextSettings,
            applications: {
                ...applications,
                filemgr: {
                    ...filemgr,
                    entries: nextEntries
                }
            }
        },
        defaultWorkspace,
        shouldNotifyWorkspaceChanged: oldSettings?.default_workspace !== defaultWorkspace
    };
}

export function prepareFileMgrStartupWorkspaceSettings(settingData: any) {
    const prepared = prepareFileMgrWorkspaceSettings(settingData, settingData);
    const changed =
        JSON.stringify(prepared.data?.applications?.filemgr) !== JSON.stringify(settingData?.applications?.filemgr);

    return {
        ...prepared,
        data: changed ? prepared.data : settingData,
        changed
    };
}

export function upsertDefaultWorkspaceFileMgrEntry(settingData: any, selectedPath: string) {
    const entries = Array.isArray(settingData?.applications?.filemgr?.entries)
        ? settingData.applications.filemgr.entries
        : [];
    const hasEntry = entries.some((entry: any) => samePath(entry?.root, selectedPath));
    const prepared = prepareFileMgrWorkspaceSettings({ ...settingData, default_workspace: selectedPath }, settingData);

    return {
        data: prepared.data,
        defaultWorkspaceChanged: prepared.shouldNotifyWorkspaceChanged,
        entriesChanged: !hasEntry
    };
}
