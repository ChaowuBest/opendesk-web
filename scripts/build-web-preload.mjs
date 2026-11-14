#!/usr/bin/env node
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
 * 构建 Web 模式的 renderer preload（dist/web/preload.js）。
 *
 * 与桌面 preload 同一份源码（src/renderer/preload.js），仅把 'electron' 模块替换为
 * src/renderer/web/electron-shim.ts（IPC 走 WebSocket），并注入只在包内可见的 process。
 * 产物是普通 IIFE 脚本，由 web 服务注入到每个 HTML 页面的 <head> 最前面。
 */

import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const production = process.argv.includes('--production') || process.env.NODE_ENV === 'production';

await build({
    absWorkingDir: root,
    entryPoints: [path.join(root, 'src', 'renderer', 'preload.js')],
    outfile: path.join(root, 'dist', 'web', 'preload.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    alias: { electron: './src/renderer/web/electron-shim.ts' },
    inject: [path.join(root, 'src', 'renderer', 'web', 'process-shim.ts')],
    minify: production,
    sourcemap: production ? false : 'inline',
    legalComments: 'none',
    logLevel: 'warning'
});

process.stdout.write('[build] web preload → dist/web/preload.js\n');
