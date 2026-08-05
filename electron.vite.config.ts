import { defineConfig, loadEnv } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import {
    createOpenGenOfficeSlidesRendererViteConfig,
    createOpenGenOfficeSlidesViteAliases,
    openGenOfficeSlidesEntries,
    openGenOfficeSlidesMainBuildPlugin
} from '@bitclub.ai/open-genoffice/vite';

export default defineConfig(({ mode }) => {
    const isProd = mode === 'production';
    const buildTime = new Date().toISOString();
    const openGenOfficeAliases = createOpenGenOfficeSlidesViteAliases();
    const openGenOfficeRendererConfig = createOpenGenOfficeSlidesRendererViteConfig();

    return {
        main: {
            define: {
                __BUILD_TIME__: JSON.stringify(buildTime),
                __IS_DEV__: JSON.stringify(!isProd)
            },
            resolve: {
                alias: {
                    ...openGenOfficeAliases
                }
            },
            publicDir: path.join(__dirname, 'resources', 'main'),
            plugins: [openGenOfficeSlidesMainBuildPlugin, tailwindcss()],
            build: {
                outDir: 'dist/main',
                // 生产环境关闭 sourcemap 以减小体积和内存占用
                sourcemap: !isProd,
                // 生产环境启用压缩
                minify: isProd,
                rollupOptions: {
                    output: {
                        manualChunks(id) {
                            if (id.replaceAll('\\', '/').endsWith('/@bitclub.ai/open-genoffice/dist/main.js')) {
                                return 'open-genoffice-main';
                            }
                        }
                    },
                    input: {
                        main: path.join(__dirname, 'src', 'main', 'main.ts'),
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
                        if (
                            warning.code === 'UNUSED_EXTERNAL_IMPORT' &&
                            warning.message?.includes('@bitclub.ai/open-genoffice/dist/main.js')
                        ) {
                            warn(warning);
                            return;
                        }
                        const safeWarnings = ['CIRCULAR_DEPENDENCY'];
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
                        slidesPreload: openGenOfficeSlidesEntries.preload
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
                        warn(warning);
                    }
                }
            }
        },
        renderer: {
            ...openGenOfficeRendererConfig,
            base: './',
            publicDir: path.join(__dirname, 'resources', 'renderer'),
            plugins: [tailwindcss()],
            resolve: {
                alias: {
                    '@': path.resolve(__dirname, 'src'),
                    ...openGenOfficeAliases
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
                        slides_editor: path.join(__dirname, 'src', 'renderer', 'slides_editor.html')
                    },
                    onwarn(warning, warn) {
                        // 忽略 Tailwind CSS 的 sourcemap 警告
                        if (warning.message?.includes('@tailwindcss/vite')) {
                            return;
                        }
                        warn(warning);
                    }
                }
            }
        }
    };
});
