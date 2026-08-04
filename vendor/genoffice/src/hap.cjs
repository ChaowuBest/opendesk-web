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

const fs = require('node:fs');
const path = require('node:path');

const manifestPath = path.resolve(__dirname, '..', 'hap-manifest.json');

function loadGenOfficeSlidesHapManifest() {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const key of ['artifacts', 'prebundledPackages', 'runtimePackages', 'wasmAssets']) {
        if (!Array.isArray(manifest[key])) {
            throw new Error(`GenOffice Slides HAP manifest 缺少 ${key}`);
        }
    }
    return manifest;
}

function globPatternToRegExp(pattern) {
    const escaped = pattern
        .replaceAll('\\', '/')
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replaceAll('*', '[^/]*');
    return new RegExp(`^${escaped}$`);
}

function listRelativeFiles(rootDir) {
    const result = [];
    const stack = [rootDir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const absolutePath = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(absolutePath);
            else if (entry.isFile()) result.push(path.relative(rootDir, absolutePath).replaceAll('\\', '/'));
        }
    }
    return result;
}

function assertHtmlLocalAssets(appDir, htmlRelativePath) {
    const htmlPath = path.join(appDir, htmlRelativePath);
    const html = fs.readFileSync(htmlPath, 'utf8');
    const htmlDir = path.dirname(htmlPath);
    const localAssets = [];
    for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
        const reference = match[1];
        if (/^(?:[a-z]+:|#|\/\/)/i.test(reference)) continue;
        const cleanReference = reference.split(/[?#]/, 1)[0];
        if (!cleanReference) continue;
        localAssets.push(cleanReference);
        if (!fs.existsSync(path.resolve(htmlDir, cleanReference))) {
            throw new Error(`GenOffice Slides HAP 缺少 HTML 资源: ${cleanReference}`);
        }
    }
    if (localAssets.length === 0) {
        throw new Error(`GenOffice Slides HAP 页面没有本地入口资源: ${htmlRelativePath}`);
    }
}

function assertGenOfficeSlidesHapPayload(appDir) {
    const manifest = loadGenOfficeSlidesHapManifest();
    for (const artifact of manifest.artifacts) {
        if (!fs.existsSync(path.join(appDir, artifact))) {
            throw new Error(`GenOffice Slides HAP 缺少产物: ${artifact}`);
        }
    }

    assertHtmlLocalAssets(appDir, 'dist/renderer/slides_editor.html');

    const payloadFiles = listRelativeFiles(appDir);
    for (const wasmPattern of manifest.wasmAssets) {
        const matcher = globPatternToRegExp(wasmPattern);
        if (!payloadFiles.some((file) => matcher.test(file))) {
            throw new Error(`GenOffice Slides HAP 缺少 WASM: ${wasmPattern}`);
        }
    }

    for (const packageName of manifest.runtimePackages) {
        if (!fs.existsSync(path.join(appDir, 'node_modules', packageName, 'package.json'))) {
            throw new Error(`GenOffice Slides HAP 缺少运行时依赖: ${packageName}`);
        }
    }
}

function stageGenOfficeSlidesHapPayload(appDir) {
    const source = path.resolve(__dirname, '..', 'dist', 'genspark-cli.cjs');
    const destination = path.join(appDir, 'dist', 'main', 'genoffice-gsk.cjs');
    if (!fs.existsSync(source)) {
        throw new Error(`GenOffice Slides 缺少 Genspark CLI 构建产物: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function getGenOfficeSlidesRuntimePackages() {
    return [...loadGenOfficeSlidesHapManifest().runtimePackages];
}

function getGenOfficeSlidesPrebundledPackages() {
    return [...loadGenOfficeSlidesHapManifest().prebundledPackages];
}

module.exports = {
    assertGenOfficeSlidesHapPayload,
    getGenOfficeSlidesPrebundledPackages,
    getGenOfficeSlidesRuntimePackages,
    loadGenOfficeSlidesHapManifest,
    stageGenOfficeSlidesHapPayload
};
