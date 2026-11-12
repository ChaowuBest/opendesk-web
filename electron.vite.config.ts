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

import { defineConfig, loadEnv } from 'electron-vite';
import type { UserConfig } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import {
    createOpenDeskOfficeRendererViteConfig,
    createOpenDeskOfficeViteAliases,
    openDeskOfficeEntries,
    openDeskOfficeMainBuildPlugin
} from '@bitclub.ai/opendesk-office/vite';

export default defineConfig(({ mode }) => {
    const isProd = mode === 'production';
    const buildTime = new Date().toISOString();
    const openDeskOfficeAliases = createOpenDeskOfficeViteAliases();
    const openDeskOfficeRendererConfig = createOpenDeskOfficeRendererViteConfig();

    const config: UserConfig = {
        main: {
            define: {
                __BUILD_TIME__: JSON.stringify(buildTime),
                __IS_DEV__: JSON.stringify(!isProd)
            },
            resolve: {
                alias: {
                    ...openDeskOfficeAliases
                }
            },
            publicDir: path.join(__dirname, 'resources', 'main'),
            plugins: [openDeskOfficeMainBuildPlugin, tailwindcss()],
            build: {
                outDir: 'dist/main',
                // 生产环境关闭 sourcemap 以减小体积和内存占用
                sourcemap: !isProd,
                // 生产环境启用压缩
                minify: isProd,
                rollupOptions: {
                    output: {
                        manualChunks(id) {
                            const normalizedId = id.replaceAll('\\', '/');
                            if (/\/@bitclub\.ai\/opendesk-office\/dist\/main\.js$/.test(normalizedId)) {
                                return 'opendesk-office-slides-main';
                            }
                            if (/\/@bitclub\.ai\/opendesk-office\/dist\/word-main\.js$/.test(normalizedId)) {
                                return 'opendesk-office-word-main';
                            }
                            if (/\/@bitclub\.ai\/opendesk-office\/dist\/sheets-main\.js$/.test(normalizedId)) {
                                return 'opendesk-office-sheets-main';
                            }
                        }
                    },
                    input: {
                        main: path.join(__dirname, 'src', 'main', 'startup', 'bootstrap.ts'),
                        // main.ts 必须是显式 entry：否则它只能经 bootstrap 的动态 import 打进
                        // chunks 子目录，main.ts 内 __dirname 相对路径（preload、worker 等）全部失效
                        app: path.join(__dirname, 'src', 'main', 'main.ts'),
                        worker: path.join(__dirname, 'src', 'main', 'worker.ts'),
                        'task-search-worker': path.join(
                            __dirname,
                            'src',
                            'main',
                            'services',
                            'task-search',
                            'worker.ts'
                        ),
                        'workflow-runtime-worker': path.join(
                            __dirname,
                            'src',
                            'main',
                            'applications',
                            'workflowMgr',
                            'run',
                            'runtime',
                            'worker.ts'
                        )
                    },
                    onwarn(warning, warn) {
                        // 忽略 Tailwind CSS 的 sourcemap 警告
                        if (warning.message?.includes('@tailwindcss/vite')) {
                            return;
                        }
                        const normalizedWarningMessage = warning.message?.replaceAll('\\', '/');
                        if (
                            warning.code === 'UNUSED_EXTERNAL_IMPORT' &&
                            (normalizedWarningMessage?.includes('@bitclub.ai/opendesk-office/dist/') ||
                                normalizedWarningMessage?.includes('/packages/opendesk-office/dist/'))
                        ) {
                            warn(warning);
                            return;
                        }
                        // MODULE_LEVEL_DIRECTIVE: node_modules 中 React 组件库的 "use client" RSC 指令，打包时被忽略，属无害警告
                        const safeWarnings: readonly string[] = ['CIRCULAR_DEPENDENCY', 'MODULE_LEVEL_DIRECTIVE'];
                        if (warning.code !== undefined && safeWarnings.includes(warning.code)) {
                            warn(warning);
                            return;
                        }
                        throw new Error(`[Rollup Warning] ${warning.code}: ${warning.message}`);
                    }
                }
            }
        },
        preload: {
            resolve: { alias: openDeskOfficeAliases },
            plugins: [tailwindcss()],
            build: {
                outDir: 'dist/preload',
                // 生产环境关闭 sourcemap，preload 脚本体积小但也会被打包进 ASAR
                sourcemap: !isProd,
                minify: isProd,
                rollupOptions: {
                    input: {
                        index: path.join(__dirname, 'src', 'renderer', 'preload.js'),
                        quickcapture_overlay: path.join(
                            __dirname,
                            'src',
                            'renderer',
                            'quickcapture_overlay_preload.js'
                        ),
                        webviewPreload: path.join(__dirname, 'src', 'renderer', 'webviewPreload.js'),
                        slidesPreload: openDeskOfficeEntries.slides.preload,
                        wordPreload: openDeskOfficeEntries.word.preload,
                        sheetsPreload: openDeskOfficeEntries.sheets.preload
                    },
                    output: {
                        format: 'cjs',
                        entryFileNames: '[name].js'
                    },
                    onwarn(warning, warn) {
                        // 忽略 Tailwind CSS 的 sourcemap 警告
                        if (warning.message?.includes('@tailwindcss/vite')) {
                            return;
                        }
                        // 忽略 node_modules 中 "use client" 指令（React 组件库 RSC 标记）警告
                        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                            return;
                        }
                        warn(warning);
                    }
                }
            }
        },
        renderer: {
            ...openDeskOfficeRendererConfig,
            base: './',
            publicDir: path.join(__dirname, 'resources', 'renderer'),
            plugins: [tailwindcss()],
            resolve: {
                ...openDeskOfficeRendererConfig.resolve,
                alias: {
                    '@': path.resolve(__dirname, 'src'),
                    ...openDeskOfficeAliases
                }
            },
            build: {
                outDir: 'dist/renderer',
                // 生产环境关闭 sourcemap（renderer 体积最大，节省最明显）
                sourcemap: !isProd,
                // 生产环境启用压缩和 tree shaking
                minify: isProd,
                // CSS 代码分割，避免单个巨大 CSS 文件阻塞渲染
                cssCodeSplit: true,
                rollupOptions: {
                    input: {
                        index: path.join(__dirname, 'src', 'renderer', 'index.html'),
                        application: path.join(__dirname, 'src', 'renderer', 'application.html'),
                        application_window: path.join(__dirname, 'src', 'renderer', 'application_window.html'),
                        logview_window: path.join(__dirname, 'src', 'renderer', 'logview_window.html'),
                        floatpage: path.join(__dirname, 'src', 'renderer', 'floatpage.html'),
                        quickcapture_overlay: path.join(__dirname, 'src', 'renderer', 'quickcapture_overlay.html'),
                        task_status_widget: path.join(__dirname, 'src', 'renderer', 'task_status_widget.html'),
                        slides_editor: path.join(__dirname, 'src', 'renderer', 'slides_editor.html'),
                        word_editor: path.join(__dirname, 'src', 'renderer', 'word_editor.html'),
                        sheets_editor: path.join(__dirname, 'src', 'renderer', 'sheets_editor.html')
                    },
                    onwarn(warning, warn) {
                        // 忽略 Tailwind CSS 的 sourcemap 警告
                        if (warning.message?.includes('@tailwindcss/vite')) {
                            return;
                        }
                        // 忽略 node_modules 中 "use client" 指令（React 组件库 RSC 标记）警告
                        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') {
                            return;
                        }
                        warn(warning);
                    }
                }
            }
        }
    };

    // 并行构建入口：scripts/build-electron.cjs 用 OPENDESK_VITE_TARGET 分别启动 main / renderer
    // 两个 electron-vite 进程，各自只构建自己那部分（main 与 renderer 是串行构建里最重的两段）。
    // 未设置该变量时行为不变，仍是 main → preload → renderer 顺序构建。
    const target = process.env.OPENDESK_VITE_TARGET;
    if (target === 'main') return { main: config.main, preload: config.preload };
    if (target === 'renderer') return { renderer: config.renderer };
    return config;
});
