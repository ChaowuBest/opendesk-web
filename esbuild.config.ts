import * as esbuild from 'esbuild';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';

const outfile = 'dist/cli/opendesk';
const outfileDebug = 'dist/cli/opendesk-debug';

/**
 * 注入 shebang 和 require shim 作为 banner
 * 使用 #!/bin/sh polyglot 技巧，兼容 OpenHarmony HiShell（其 env 在 /bin/env 而非 /usr/bin/env）
 * npm 发布包会由打包脚本将 shebang 替换为 #!/usr/bin/env node 以兼容 Windows
 */
const BANNER = `#!/bin/sh
// 2>/dev/null; exec "$(command -v node || command -v nodejs)" "$0" "$@"
import { createRequire as __banner_createRequire } from 'node:module';
const __createRequire = __banner_createRequire(import.meta.url);
`;

/**
 * 创建 require shim 插件，用于处理 esbuild 注入的动态 require 抛错逻辑
 * @param outputPath - 输出文件路径
 */
function createRequireShimPlugin(outputPath: string): esbuild.Plugin {
    return {
        name: `require-shim-${outputPath.split('/').pop()}`,
        setup(build) {
            build.onEnd((result) => {
                if (result.errors.length > 0) return;

                // 读取生成的 JS 文件
                let jsText: string;
                try {
                    jsText = readFileSync(outputPath, 'utf8');
                } catch {
                    return;
                }

                // 替换 Dynamic require 错误为使用 __createRequire
                const originalPattern =
                    /if\s*\(typeof require\s*(?:!==\s*"undefined"|<"u")\s*\)\s*return require\.apply\(this,\s*arguments\)\s*;\s*throw\s+Error\(\s*'Dynamic require of "'\s*\+\s*(\w+)\s*\+\s*'" is not supported'\s*\)/g;

                // 替换为使用 __createRequire
                const replacement =
                    'if (typeof require !== "undefined") return require.apply(this, arguments); return __createRequire($1)';

                const replaced = jsText.replace(originalPattern, replacement);
                if (replaced !== jsText) {
                    jsText = replaced;
                    writeFileSync(outputPath, jsText, 'utf8');
                }
            });
        }
    };
}

const prodConfig: esbuild.BuildOptions = {
    entryPoints: ['src/main/cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile,
    minify: true,
    treeShaking: true,
    sourcemap: false,
    banner: { js: BANNER },
    external: [
        'node-screenshots',
        'vectra',
        'number-to-alphabet',
        'esbuild',
        'unpdf',
        'better-sqlite3',
        'sqlite-vec',
        'canvas'
    ],
    plugins: [createRequireShimPlugin(outfile)]
};

const debugConfig: esbuild.BuildOptions = {
    entryPoints: ['src/main/cli.ts'],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    outfile: outfileDebug,
    minify: false,
    treeShaking: true,
    sourcemap: 'inline',
    sourcesContent: true,
    banner: { js: BANNER },
    external: [
        'node-screenshots',
        'vectra',
        'number-to-alphabet',
        'esbuild',
        'unpdf',
        'better-sqlite3',
        'sqlite-vec',
        'canvas'
    ],
    plugins: [createRequireShimPlugin(outfileDebug)]
};

async function build() {
    await esbuild.build(prodConfig);
    await esbuild.build(debugConfig);
    // 添加可执行权限，确保 npm link 后可直接运行
    chmodSync(outfile, 0o755);
    chmodSync(outfileDebug, 0o755);
    console.log('Built both production and debug versions:');
    console.log(`  - ${outfile} (minified, no sourcemap)`);
    console.log(`  - ${outfileDebug} (unminified, with inline sourcemap)`);
}

build().catch((error) => {
    console.error('Failed to build CLI: ', error.message);
    process.exit(1);
});
