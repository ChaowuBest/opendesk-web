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

import fs from 'fs';
import path from 'path';

/** Logo 文件大小上限；Logo 仅作为小尺寸品牌图展示，避免整读大文件浪费内存 */
export const APPEARANCE_LOGO_MAX_BYTES = 2 * 1024 * 1024;

const APPEARANCE_LOGO_MIME_TYPES: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPathInside(root: string, target: string): boolean {
    const normalizedRoot = path.resolve(root);
    const normalizedTarget = path.resolve(target);
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`);
}

/** 主题变体 Logo 的解析结果：渲染进程直接使用的 data URL 集合 */
export interface AppearanceLogoValues {
    appLogoUrl?: string;
    appLogoDarkUrl?: string;
    appLogoLightUrl?: string;
}

/**
 * 解析 setAppLogo 的输入。
 *
 * 字符串形式解析出单一 data URL；`{ dark, light }` 对象形式按主题分别解析，
 * 缺省一侧复用另一侧，保证任何主题下都使用自定义 Logo。
 */
export function resolveAppearanceLogoValues(
    pluginDir: string,
    logoPath: string | { dark?: unknown; light?: unknown }
): AppearanceLogoValues {
    if (typeof logoPath === 'string') {
        return { appLogoUrl: resolvePluginLogoDataUrl(pluginDir, logoPath) };
    }
    if (!isRecord(logoPath)) {
        throw new Error('plugin.appearance_logo_variants_invalid');
    }
    const keys = Object.keys(logoPath);
    if (keys.length === 0 || keys.some((key) => key !== 'dark' && key !== 'light')) {
        throw new Error('plugin.appearance_logo_variants_invalid');
    }
    const dark = logoPath.dark;
    const light = logoPath.light;
    if (keys.includes('dark') && (typeof dark !== 'string' || !dark.trim())) {
        throw new Error('plugin.appearance_logo_variants_invalid');
    }
    if (keys.includes('light') && (typeof light !== 'string' || !light.trim())) {
        throw new Error('plugin.appearance_logo_variants_invalid');
    }
    // 逐侧走完整校验（存在性/格式/大小），错误码与单路径形式保持一致
    const darkUrl = typeof dark === 'string' ? resolvePluginLogoDataUrl(pluginDir, dark) : undefined;
    const lightUrl = typeof light === 'string' ? resolvePluginLogoDataUrl(pluginDir, light) : undefined;
    return {
        appLogoDarkUrl: darkUrl ?? lightUrl,
        appLogoLightUrl: lightUrl ?? darkUrl
    };
}

/**
 * 将插件声明的 Logo 相对路径解析为可交给渲染进程直接使用的 data URL。
 *
 * 路径必须相对插件根目录且解析后仍在根目录内（含符号链接校验），
 * 仅接受有限的图片扩展名并限制文件大小。
 */
export function resolvePluginLogoDataUrl(pluginDir: string, logoPath: string): string {
    if (typeof logoPath !== 'string' || !logoPath.trim()) {
        throw new Error('plugin.appearance_logo_path_invalid');
    }
    if (path.isAbsolute(logoPath)) {
        throw new Error('plugin.appearance_logo_path_invalid:absolute');
    }
    const root = path.resolve(pluginDir);
    const resolved = path.resolve(root, logoPath);
    if (!isPathInside(root, resolved)) {
        throw new Error('plugin.appearance_logo_path_invalid:outside_root');
    }
    let stats: fs.Stats;
    try {
        stats = fs.statSync(resolved);
    } catch {
        throw new Error('plugin.appearance_logo_path_invalid:not_found');
    }
    if (!stats.isFile()) {
        throw new Error('plugin.appearance_logo_path_invalid:not_found');
    }
    const realRoot = fs.realpathSync(root);
    const realResolved = fs.realpathSync(resolved);
    if (!isPathInside(realRoot, realResolved)) {
        throw new Error('plugin.appearance_logo_path_invalid:outside_root');
    }
    const mime = APPEARANCE_LOGO_MIME_TYPES[path.extname(realResolved).toLowerCase()];
    if (!mime) {
        throw new Error('plugin.appearance_logo_format_unsupported');
    }
    if (stats.size > APPEARANCE_LOGO_MAX_BYTES) {
        throw new Error('plugin.appearance_logo_too_large');
    }
    const payload = fs.readFileSync(realResolved).toString('base64');
    return `data:${mime};base64,${payload}`;
}
