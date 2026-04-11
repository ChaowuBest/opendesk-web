/**
 * Vite config for Web Debug Mode (npm run start-debug)
 *
 * 只构建 renderer 部分，在浏览器中运行前端。
 * 后端 API 由 src/main/web-server.ts 提供 (HTTP + WebSocket on port 3001)。
 */

import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

const __dirname = import.meta.dirname;

function injectPreloadWebPlugin() {
    return {
        name: 'inject-preload-web',
        transformIndexHtml(html: string) {
            return html.replace('<head>', '<head>\n        <script src="./preload-web.js"></script>');
        }
    };
}

export default defineConfig({
    root: path.join(__dirname, 'src', 'renderer'),
    base: './',
    publicDir: path.join(__dirname, 'resources', 'renderer'),
    plugins: [tailwindcss(), injectPreloadWebPlugin()],
    resolve: {
        alias: {
            '@': path.resolve(__dirname, 'src')
        }
    },
    server: {
        port: 5173,
        open: true
    },
    build: {
        outDir: path.join(__dirname, 'dist', 'renderer-web'),
        sourcemap: true,
        rollupOptions: {
            input: {
                index: path.join(__dirname, 'src', 'renderer', 'index.html'),
                application: path.join(__dirname, 'src', 'renderer', 'application.html')
            }
        }
    }
});
