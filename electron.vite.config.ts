import { defineConfig, loadEnv } from 'electron-vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig(({ mode }) => {
    return {
        main: {
            publicDir: path.join(__dirname, 'resources', 'main'),
            plugins: [tailwindcss()],
            build: {
                outDir: 'dist/main',
                rollupOptions: {
                    input: {
                        main: path.join(__dirname, 'src', 'main', 'main.ts'),
                        worker: path.join(__dirname, 'src', 'main', 'worker.ts')
                    },
                    onwarn(warning, warn) {
                        // 忽略 Tailwind CSS 的 sourcemap 警告
                        if (warning.message?.includes('@tailwindcss/vite')) {
                            return;
                        }
                        const safeWarnings = ['CIRCULAR_DEPENDENCY'];
                        if (safeWarnings.includes(warning.code)) {
                            warn(warning);
                            return;
                        }
                        throw new Error(`[Rollup Warning] ${warning.code}: ${warning.message}`);
                    }
                },
                sourcemap: true
            }
        },
        preload: {
            plugins: [tailwindcss()],
            build: {
                outDir: 'dist/preload',
                rollupOptions: {
                    input: {
                        index: path.join(__dirname, 'src', 'renderer', 'preload.js'),
                        webviewPreload: path.join(__dirname, 'src', 'renderer', 'webviewPreload.js')
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
                },
                sourcemap: true
            }
        },
        renderer: {
            base: './',
            publicDir: path.join(__dirname, 'resources', 'renderer'),
            plugins: [tailwindcss()],
            resolve: {
                alias: {
                    '@': path.resolve(__dirname, 'src')
                }
            },
            build: {
                outDir: 'dist/renderer',
                sourcemap: true,
                rollupOptions: {
                    input: {
                        index: path.join(__dirname, 'src', 'renderer', 'index.html'),
                        application: path.join(__dirname, 'src', 'renderer', 'application.html'),
                        application_window: path.join(__dirname, 'src', 'renderer', 'application_window.html'),
                        floatpage: path.join(__dirname, 'src', 'renderer', 'floatpage.html')
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
