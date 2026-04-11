/**
 * start-debug 启动脚本：同时启动后端 API 服务器和 Vite 前端开发服务器
 *
 * - 后端: src/main/web-server.ts (通过 esbuild 打包后运行)
 * - 前端: Vite dev server with vite.config.web.ts (port 5173)
 */

import { spawn, execSync } from 'child_process';
import * as esbuild from 'esbuild';
import path from 'path';
import fs from 'fs';
import net from 'net';

const __dirname = import.meta.dirname;
const rootDir = path.resolve(__dirname, '..');
const outfile = path.join(rootDir, 'dist', 'web-server', 'web-server.mjs');

const BANNER = `import { createRequire as __banner_createRequire } from 'node:module';
const __createRequire = __banner_createRequire(import.meta.url);
`;

const PORTS_TO_CLEAN = [3001, 18789];

function isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = net.createServer();
        srv.once('error', () => resolve(true));
        srv.once('listening', () => {
            srv.close();
            resolve(false);
        });
        srv.listen(port, '0.0.0.0');
    });
}

async function killPortProcesses() {
    for (const port of PORTS_TO_CLEAN) {
        if (await isPortInUse(port)) {
            console.log(`Port ${port} is in use, attempting to free it...`);
            try {
                const result = execSync(
                    `for /f "tokens=5" %a in ('netstat -aon ^| findstr :${port} ^| findstr LISTENING') do @taskkill /f /pid %a`,
                    { shell: 'cmd.exe', timeout: 5000, encoding: 'utf8', stdio: 'pipe' }
                );
                if (result.trim()) console.log(result.trim());
            } catch {
                // port may have been freed between check and kill
            }
        }
    }
}

function createRequireShimPlugin(outputPath: string): esbuild.Plugin {
    return {
        name: 'require-shim',
        setup(build) {
            build.onEnd((result) => {
                if (result.errors.length > 0) return;
                let jsText: string;
                try {
                    jsText = fs.readFileSync(outputPath, 'utf8');
                } catch {
                    return;
                }
                const originalPattern =
                    /if\s*\(typeof require\s*(?:!==\s*"undefined"|<"u")\s*\)\s*return require\.apply\(this,\s*arguments\)\s*;\s*throw\s+Error\(\s*'Dynamic require of "'\s*\+\s*(\w+)\s*\+\s*'" is not supported'\s*\)/g;
                const replacement =
                    'if (typeof require !== "undefined") return require.apply(this, arguments); return __createRequire($1)';
                const replaced = jsText.replace(originalPattern, replacement);
                if (replaced !== jsText) {
                    fs.writeFileSync(outputPath, replaced, 'utf8');
                }
            });
        }
    };
}

console.log('Starting OpenDesk Web Debug Mode...\n');

// 清理可能被占用的端口
await killPortProcesses();

// 确保输出目录存在
fs.mkdirSync(path.dirname(outfile), { recursive: true });

// 先用 esbuild 打包后端
console.log('Building web server...');
await esbuild.build({
    entryPoints: [path.join(rootDir, 'src', 'main', 'web-server.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    minify: false,
    sourcemap: 'inline',
    sourcesContent: true,
    banner: { js: BANNER },
    external: ['node-screenshots', 'vectra', 'number-to-alphabet', 'esbuild', 'unpdf', 'better-sqlite3', 'sharp'],
    plugins: [createRequireShimPlugin(outfile)]
});

console.log('Web server built successfully.\n');

// 启动后端 API 服务器
const backend = spawn('node', ['--enable-source-maps', outfile], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true,
    env: {
        ...process.env,
        OPENDESK_WEB_MODE: '1'
    }
});

// 等 2 秒让后端先启动，再启动前端
setTimeout(() => {
    const frontend = spawn('npx', ['vite', '--config', path.join(rootDir, 'vite.config.web.ts')], {
        cwd: rootDir,
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            OPENDESK_WEB_MODE: '1'
        }
    });

    frontend.on('error', (err) => {
        console.error('Frontend error:', err);
    });

    frontend.on('close', (code) => {
        console.log(`Frontend exited with code ${code}`);
        backend.kill();
        process.exit(code || 0);
    });
}, 2000);

backend.on('error', (err) => {
    console.error('Backend error:', err);
});

backend.on('close', (code) => {
    console.log(`Backend exited with code ${code}`);
    process.exit(code || 0);
});

// 优雅退出
process.on('SIGINT', () => {
    backend.kill();
    process.exit(0);
});

process.on('SIGTERM', () => {
    backend.kill();
    process.exit(0);
});
