/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { createRequire, register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { logger } from '../../../utils/logger.js';

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
const HOST_PACKAGE_SPECIFIERS = [
    '@bitclub.ai/opendesk-plugin-sdk',
    '@bitclub.ai/opendesk-plugin-sdk/package',
    'zod'
] as const;

let mappingRegistered = false;
let cachedRequire: ReturnType<typeof createRequire> | undefined;

function hostRequire(): ReturnType<typeof createRequire> {
    cachedRequire ??= createRequire(import.meta.url);
    return cachedRequire;
}

/**
 * 从宿主模块解析链定位指定的包入口文件 URL。
 * 解析不到时返回 undefined（保持插件原有加载行为，不阻断）。
 */
function resolveHostPackageUrl(specifier: string): string | undefined {
    try {
        return pathToFileURL(hostRequire().resolve(specifier)).href;
    } catch {
        return undefined;
    }
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
    return Boolean(
        error &&
        typeof error === 'object' &&
        (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'MODULE_NOT_FOUND')
    );
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
