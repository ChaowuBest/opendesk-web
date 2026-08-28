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

'use strict';

const fs = require('fs');
const path = require('path');

const NATIVE_BUILD_CONFIG_NAMES = new Set([
    'binding.gyp',
    'binding.gypi',
    'cmakelists.txt',
    'meson.build',
    'makefile',
    'configure',
    'configure.ac'
]);
const NATIVE_BUILD_CONFIG_EXTENSIONS = new Set(['.gyp', '.gypi', '.cmake']);
const NATIVE_BUILD_FILE_EXTENSIONS = new Set([
    '.c',
    '.cc',
    '.cpp',
    '.cxx',
    '.h',
    '.hh',
    '.hpp',
    '.hxx',
    '.gyp',
    '.gypi',
    '.cmake',
    '.mk',
    '.m4',
    '.o',
    '.obj',
    '.a',
    '.lib',
    '.pdb',
    '.sln',
    '.vcxproj',
    '.props',
    '.targets',
    '.patch'
]);
const NATIVE_BUILD_FILE_NAMES = new Set(['makefile', 'cmakelists.txt', 'configure', 'configure.ac']);

function isPathInside(parentPath, candidatePath) {
    const relative = path.relative(parentPath, candidatePath);
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function readPackageManifest(packageRoot) {
    try {
        return JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    } catch {
        return null;
    }
}

function findOwningPackage(depsDir) {
    let current = path.dirname(path.resolve(depsDir));
    while (true) {
        if (path.basename(current).toLowerCase() === 'node_modules') return null;

        const manifest = readPackageManifest(current);
        if (manifest) return { packageRoot: current, manifest };

        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
}

function listRootBuildConfigs(packageRoot) {
    let entries;
    try {
        entries = fs.readdirSync(packageRoot, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter((entry) => {
            if (!entry.isFile()) return false;
            const lowerName = entry.name.toLowerCase();
            return (
                NATIVE_BUILD_CONFIG_NAMES.has(lowerName) || NATIVE_BUILD_CONFIG_EXTENSIONS.has(path.extname(lowerName))
            );
        })
        .map((entry) => path.join(packageRoot, entry.name));
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configReferencesDirectory(configPath, relativeDirectory) {
    let content;
    try {
        content = fs.readFileSync(configPath, 'utf8').replaceAll('\\', '/');
    } catch {
        return false;
    }

    const normalizedDirectory = relativeDirectory.split(path.sep).join('/');
    const referencePattern = new RegExp(
        `(^|[^A-Za-z0-9_.-])(?:\\./)?${escapeRegExp(normalizedDirectory)}(?:/|[^A-Za-z0-9_.-]|$)`,
        'm'
    );
    return referencePattern.test(content);
}

function isNativeBuildFile(fileName) {
    const lowerName = fileName.toLowerCase();
    if (NATIVE_BUILD_FILE_NAMES.has(lowerName)) return true;
    if (lowerName.endsWith('.vcxproj.filters')) return true;
    return NATIVE_BUILD_FILE_EXTENSIONS.has(path.extname(lowerName));
}

function pruneBuildFiles(depsDir) {
    const stack = [depsDir];
    let removedFiles = 0;
    let removedBytes = 0;

    // Keep directories and unknown file types intact: runtime code may resolve them dynamically.
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const entry of entries) {
            const target = path.join(current, entry.name);
            if (entry.isSymbolicLink()) continue;
            if (entry.isDirectory()) {
                stack.push(target);
                continue;
            }
            if (!entry.isFile() || !isNativeBuildFile(entry.name)) continue;

            let size = 0;
            try {
                size = fs.statSync(target).size;
                fs.rmSync(target, { force: true });
            } catch {
                continue;
            }
            removedFiles++;
            removedBytes += size;
        }
    }

    return { removedFiles, removedBytes };
}

function pruneNativeBuildFilesInDeps(depsDir) {
    const resolvedDepsDir = path.resolve(depsDir);
    const result = {
        pruned: false,
        removedFiles: 0,
        removedBytes: 0,
        packageName: null,
        packageVersion: null,
        relativePath: null
    };
    if (path.basename(resolvedDepsDir).toLowerCase() !== 'deps' || !fs.existsSync(resolvedDepsDir)) return result;

    const owner = findOwningPackage(resolvedDepsDir);
    if (!owner || !isPathInside(owner.packageRoot, resolvedDepsDir)) return result;

    const relativePath = path.relative(owner.packageRoot, resolvedDepsDir).split(path.sep).join('/');
    result.packageName =
        typeof owner.manifest.name === 'string' ? owner.manifest.name : path.basename(owner.packageRoot);
    result.packageVersion = typeof owner.manifest.version === 'string' ? owner.manifest.version : null;
    result.relativePath = relativePath;

    // A directory name is not evidence. Require the package's native build entry to reference this exact deps path.
    const buildConfigs = listRootBuildConfigs(owner.packageRoot);
    if (!buildConfigs.some((configPath) => configReferencesDirectory(configPath, relativePath))) return result;

    const removed = pruneBuildFiles(resolvedDepsDir);
    result.pruned = removed.removedFiles > 0;
    result.removedFiles = removed.removedFiles;
    result.removedBytes = removed.removedBytes;
    return result;
}

module.exports = {
    pruneNativeBuildFilesInDeps
};
