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

import { defineConfig, externalizeDepsPlugin, loadEnv } from 'electron-vite';
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

    return {
        main: {
            define: {
                __BUILD_TIME__: JSON.stringify(buildTime),
                __IS_DEV__: JSON.stringify(!isProd)
            },
            resolve: {
                alias: {
                    // marked-katex-extension@5.1.7+ 的 exports.import 直接指向 TS 源码 (src/index.ts)。
                    // Electron 主进程的依赖会被 external，运行时由 Node ESM loader 加载，
                    // 而 Node 拒绝为 node_modules 下的 .ts 做类型剥离，抛出
                    // ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING。这里显式映射到随包发布的
                    // CJS 产物，使其被打进 bundle，运行时不再走 exports 解析。
                    'marked-katex-extension': path.join(
                        __dirname,
                        'node_modules',
                        'marked-katex-extension',
                        'lib',
                        'index.cjs'
                    ),
                    ...openDeskOfficeAliases
                }
            },
            publicDir: path.join(__dirname, 'resources', 'main'),
            plugins: [
                // 显式 externalize 依赖列表，并把 marked-katex-extension 排除在外：
                // electron-vite 默认会把所有 dependencies 设为 external（enforce: 'pre'，
                // 早于 resolve 生效），导致 alias 无法覆盖；显式传入后检测到同名插件不再自动注入。
                externalizeDepsPlugin({ exclude: ['marked-katex-extension'] }),
                openDeskOfficeMainBuildPlugin,
                tailwindcss()
            ],
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
                        const safeWarnings = ['CIRCULAR_DEPENDENCY', 'MODULE_LEVEL_DIRECTIVE'];
                        if (safeWarnings.includes(warning.code)) {
                            warn(warning);
                            return;
                        }
                        throw new Error(`[Rollup Warning] ${warning.code}: ${warning.message}`);
                    }
                }
            }
        },
        preload: {
            plugins: [tailwindcss()],
            build: {
                outDir: 'dist/preload',
                // 生产环境关闭 sourcemap，preload 脚本体积小但也会被打包进 ASAR
                sourcemap: !isProd,
                minify: isProd,
                rollupOptions: {
                    input: {
                        index: path.join(__dirname, 'src', 'renderer', 'preload.js'),
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
});
