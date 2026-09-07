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

/**
 * renderer 侧任务导出（GUI 导出按钮）的落盘与字体内联。
 *
 * 导出的 HTML 由 renderer 的 task-export.ts 生成：消息 DOM 与 CSS 均来自
 * task view 的真实渲染管线与实时样式表。字体文件在 file:// 环境下无法由
 * renderer 读取，因此 renderer 只收集 URL，由这里替换为 data URI 后写盘。
 */

import fs from 'fs';
import path from 'path';

const FONT_MIME_TYPES: Record<string, string> = {
    woff2: 'font/woff2',
    woff: 'font/woff',
    ttf: 'font/ttf',
    otf: 'font/otf'
};

/** 应用根目录：dev 为仓库根，打包后为 app.asar 根（fs 可直接读 asar 内文件） */
function getAppRootDir(): string {
    return path.resolve(__dirname, '..', '..');
}

/**
 * 把字体 URL 解析为本地文件路径。支持三类来源：
 * - file:// 绝对路径（打包后构建产物中的字体）；
 * - 本地 dev server 的 http(s) URL（含 Vite 的 /@fs/ 路径）；
 * - 以 / 开头的应用根相对路径。
 * 远端 http(s) 字体不内联。
 */
function resolveFontFilePath(url: string): string | null {
    try {
        if (typeof url !== 'string' || !url || url.startsWith('data:')) return null;
        if (/^file:/i.test(url)) {
            const parsed = new URL(url);
            let filePath = decodeURIComponent(parsed.pathname);
            if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1);
            return filePath;
        }
        let pathname: string | null = null;
        if (/^https?:/i.test(url)) {
            const parsed = new URL(url);
            if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
            pathname = decodeURIComponent(parsed.pathname);
        } else if (url.startsWith('/')) {
            pathname = decodeURIComponent(url);
        } else {
            return null;
        }
        if (pathname.startsWith('/@fs/')) {
            return pathname.slice('/@fs/'.length);
        }
        const appRoot = getAppRootDir();
        const candidates = [
            path.join(appRoot, 'src', 'renderer', 'public', pathname),
            path.join(appRoot, 'dist', 'renderer', pathname),
            path.join(appRoot, 'resources', 'renderer', pathname),
            path.join(appRoot, pathname)
        ];
        for (const candidate of candidates) {
            if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
        }
        return null;
    } catch {
        return null;
    }
}

function readFontAsDataUri(url: string): string | null {
    const filePath = resolveFontFilePath(url);
    if (!filePath) return null;
    try {
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = FONT_MIME_TYPES[ext];
        if (!mime) return null;
        return `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`;
    } catch {
        return null;
    }
}

/**
 * 保存 renderer 侧生成的任务导出 HTML：将内嵌字体 URL 替换为 data URI 后写盘。
 * 找不到本地文件的字体保持原 URL（浏览器会回退到系统字体）。
 */
export async function saveTaskExportHtml(filePath: unknown, html: unknown, fontUrls: unknown): Promise<string> {
    if (typeof filePath !== 'string' || !filePath) {
        throw new Error('invalid export file path');
    }
    if (typeof html !== 'string' || !html) {
        throw new Error('invalid export html');
    }
    const urls = Array.isArray(fontUrls) ? fontUrls.filter((url): url is string => typeof url === 'string') : [];

    let finalHtml = html;
    for (const url of urls) {
        const dataUri = readFontAsDataUri(url);
        if (dataUri) {
            finalHtml = finalHtml.split(url).join(dataUri);
        } else {
            // 未内联的字体在 file: 打开的导出页中会被唯一源策略拦截，
            // 表现为图标/字体缺失，这里显式暴露便于定位解析失败的原因。
            console.warn('[task-export] font not inlined (unresolvable):', url);
        }
    }
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, finalHtml, 'utf-8');
    return filePath;
}
