/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logger } from '../../../utils/logger.js';
import { appRootCandidatesFrom } from '../management/paths.js';

/**
 * 会被映射到宿主内置模块的包名。
 *
 * 插件入口由 `loadPlugin` 通过动态 `import()` 加载，Node 会按入口文件
 * 所在目录向上查找 node_modules 来解析裸包名。目录/归档方式安装的插件
 * 经常不自带 node_modules（尤其是鸿蒙端的 OpenDesk 不会在运行时执行
 * npm install），导致加载阶段报
 * `Cannot find package '@bitclub.ai/opendesk-plugin-sdk' imported from ...`。
 *
 * 这里注册一个 ESM loader hook：对上述包名先尝试常规解析（尊重插件自带
 * 依赖），解析失败时回退到宿主内置的同一模块文件。
 */
export const HOST_PACKAGE_SPECIFIERS = [
    '@bitclub.ai/opendesk-plugin-sdk',
    '@bitclub.ai/opendesk-plugin-sdk/package',
    'zod'
] as const;

/**
 * 宿主自带包在应用目录中的 workspace 位置（相对应用根）。
 *
 * Plugin SDK 以 `file:packages/plugin-sdk` 的形式被宿主依赖，运行时靠
 * `node_modules/@bitclub.ai/opendesk-plugin-sdk` 这个指向 workspace 目录的
 * 符号链接解析。打包、复制或裁剪应用目录时该链接可能不被保留（鸿蒙 HAP 等
 * 非 Electron 产物尤其容易命中），宿主侧解析随之失败。workspace 目录本身仍随
 * 应用分发，因此这里保留一条不依赖 node_modules 的兜底路径。
 */
const WORKSPACE_PACKAGE_DIRECTORIES = new Map<string, string>([
    ['@bitclub.ai/opendesk-plugin-sdk', path.join('packages', 'plugin-sdk')]
]);

/**
 * 从模块 specifier 提取 npm 包名（scoped 包取 `@scope/name`，其余取第一段）。
 * dependencies 中声明的是包名，而 HOST_PACKAGE_SPECIFIERS 可能包含子路径。
 */
function packageNameOf(specifier: string): string {
    const segments = specifier.split('/');
    return specifier.startsWith('@') && segments.length >= 2 ? `${segments[0]}/${segments[1]}` : segments[0];
}

/** 判断一个 npm 包名是否由宿主直接提供（安装插件时无需从 registry 安装）。 */
export function isHostMappedPackageName(packageName: string): boolean {
    return HOST_PACKAGE_SPECIFIERS.some((specifier) => packageNameOf(specifier) === packageName);
}

let mappingRegistered = false;
let cachedRequire: ReturnType<typeof createRequire> | undefined;

function hostRequire(): ReturnType<typeof createRequire> {
    cachedRequire ??= createRequire(import.meta.url);
    return cachedRequire;
}

/**
 * 绕过 node_modules，直接从应用根目录下的 workspace 包解析 specifier。
 *
 * 以 workspace 包自身的 package.json 作为解析基准，借 Node 的包自引用
 * （self-reference）解析：specifier 会按该包声明的 `exports` 映射到具体
 * 产物文件，子路径（如 `./package`）无需在此硬编码。
 * 定位不到时返回 undefined，由调用方保持原有行为。
 */
export function resolveWorkspacePackageUrl(specifier: string, startDirectory: string): string | undefined {
    const workspaceDirectory = WORKSPACE_PACKAGE_DIRECTORIES.get(packageNameOf(specifier));
    if (!workspaceDirectory) return undefined;
    for (const appRoot of appRootCandidatesFrom(startDirectory)) {
        const manifest = path.join(appRoot, workspaceDirectory, 'package.json');
        if (!fs.existsSync(manifest)) continue;
        try {
            return pathToFileURL(createRequire(manifest).resolve(specifier)).href;
        } catch {
            continue;
        }
    }
    return undefined;
}

/**
 * 从宿主模块解析链定位指定的包入口文件 URL。
 *
 * 常规解析失败，或解析结果不可读时退回应用根目录下的 workspace 包。
 * 不可读场景：Windows 上 `file:packages/*` 依赖在 node_modules 下是 junction，
 * electron-packager 打包 asar 时会把它记录为指向构建机绝对路径的损坏链接，
 * `require.resolve` 仍会"成功"返回坏路径（不抛 MODULE_NOT_FOUND），但文件实际
 * 不存在。两者都解析不到时返回 undefined（保持插件原有加载行为，不阻断）。
 */
export function resolveHostPackageUrl(
    specifier: string,
    startDirectory: string = path.dirname(fileURLToPath(import.meta.url)),
    resolveFromHost: (specifier: string) => string = (value) => hostRequire().resolve(value)
): string | undefined {
    try {
        const resolved = resolveFromHost(specifier);
        if (resolved && fs.existsSync(resolved)) {
            return pathToFileURL(resolved).href;
        }
    } catch {
        // 常规解析失败，走 workspace 兜底
    }
    return resolveWorkspacePackageUrl(specifier, startDirectory);
}

function buildSpecifierMap(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const specifier of HOST_PACKAGE_SPECIFIERS) {
        const url = resolveHostPackageUrl(specifier);
        if (url) map[specifier] = url;
    }
    return map;
}

function buildLoaderSource(map: Record<string, string>): string {
    return `
const map = ${JSON.stringify(map)};

function isModuleNotFound(error) {
    if (!error || typeof error !== 'object') return false;
    const code = error.code;
    // ENOENT 覆盖 asar 中损坏链接导致的解析失败（Windows junction 打包为
    // 指向构建机绝对路径的坏链接，nextResolve 会抛 ENOENT 而非 MODULE_NOT_FOUND）。
    return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

export async function resolve(specifier, context, nextResolve) {
    if (!Object.prototype.hasOwnProperty.call(map, specifier)) {
        return nextResolve(specifier, context);
    }
    try {
        // 优先让插件自带的 node_modules 生效（尊重插件自身的 SDK/zod 版本）
        return await nextResolve(specifier, context);
    } catch (error) {
        if (isModuleNotFound(error)) {
            return { url: map[specifier], shortCircuit: true };
        }
        throw error;
    }
}
`;
}

/**
 * 注册插件 SDK 包路径映射（进程级，进程内只注册一次）。
 *
 * 映射成功后，缺少 node_modules 的插件也能解析到宿主内置的
 * `@bitclub.ai/opendesk-plugin-sdk`；宿主侧无对应包可解析时静默跳过，
 * 不会改变插件原有加载行为。
 */
export function registerSdkPackageMapping(): void {
    if (mappingRegistered) return;
    const map = buildSpecifierMap();
    if (Object.keys(map).length === 0) return;
    try {
        register(
            `data:text/javascript;base64,${Buffer.from(buildLoaderSource(map)).toString('base64')}`,
            import.meta.url
        );
        mappingRegistered = true;
        logger.info(`Registered plugin SDK package mapping: ${Object.keys(map).join(', ')}`);
    } catch (error) {
        logger.warn('Failed to register plugin SDK package mapping:', error);
    }
}
